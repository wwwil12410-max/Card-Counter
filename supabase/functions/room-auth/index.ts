import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ownerSetupPassword = Deno.env.get("OWNER_SETUP_PASSWORD") || "";
const defaultPlayerPassword = Deno.env.get("DEFAULT_PLAYER_PASSWORD") || "";
const supabase = createClient(supabaseUrl, serviceRoleKey);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const action = String(body.action || "");
    const roomId = safeRoomId(body.roomId);

    if (action === "login") {
      return json(await login(roomId, body));
    }
    if (action === "validate") {
      return json(await validate(roomId, String(body.token || "")));
    }
    if (action === "save-state") {
      const session = await requireSession(roomId, String(body.token || ""));
      if (session.role !== "owner" && !session.access.allow_player_edit) {
        throw statusError("Only owner can edit now", 403);
      }
      await upsertRoom(roomId, body.state);
      return json(accessResponse(session));
    }
    if (action === "owner-action") {
      return json(await ownerAction(roomId, body));
    }

    throw statusError("Unknown action", 400);
  } catch (error) {
    const status = error.status || 500;
    return json({ error: error.message || "Server error" }, status);
  }
});

async function login(roomId: string, body: any) {
  const role = body.role === "owner" ? "owner" : "player";
  const password = String(body.password || "");
  let access = await getAccess(roomId);

  if (!access) {
    if (!ownerSetupPassword || !defaultPlayerPassword) {
      throw statusError("Function secrets are not configured", 500);
    }
    if (role !== "owner" || password !== ownerSetupPassword) {
      throw statusError("Room must be initialized by owner", 403);
    }
    const initialState = normalizeState(body.initialState);
    await upsertRoom(roomId, initialState);
    access = await createAccess(roomId, ownerSetupPassword, defaultPlayerPassword);
  }

  if (access.closed && role !== "owner") {
    throw statusError("Room is closed", 403);
  }

  const expected = role === "owner" ? access.owner_password_hash : access.player_password_hash;
  if ((await hashPassword(password)) !== expected) {
    throw statusError("Wrong password", 403);
  }

  const token = crypto.randomUUID() + "." + crypto.randomUUID();
  const tokenHash = await hashPassword(token);
  const { error } = await supabase.from("room_sessions").insert({
    token_hash: tokenHash,
    room_id: roomId,
    role,
    access_version: access.access_version,
  });
  if (error) throw error;

  const state = await getRoomState(roomId);
  return {
    token,
    role,
    state,
    allowPlayerEdit: access.allow_player_edit,
    closed: access.closed,
  };
}

async function validate(roomId: string, token: string) {
  const session = await requireSession(roomId, token);
  return accessResponse(session);
}

async function ownerAction(roomId: string, body: any) {
  const session = await requireSession(roomId, String(body.token || ""));
  if (session.role !== "owner") {
    throw statusError("Owner permission required", 403);
  }

  const type = String(body.type || "");
  if (type === "set-player-password") {
    const password = String(body.playerPassword || "");
    if (password.length < 4) throw statusError("Player password must be at least 4 chars", 400);
    const { error } = await supabase
      .from("room_access")
      .update({
        player_password_hash: await hashPassword(password),
        updated_at: new Date().toISOString(),
      })
      .eq("room_id", roomId);
    if (error) throw error;
    await deletePlayerSessions(roomId);
  } else if (type === "set-player-edit") {
    const { error } = await supabase
      .from("room_access")
      .update({ allow_player_edit: body.allowPlayerEdit === true, updated_at: new Date().toISOString() })
      .eq("room_id", roomId);
    if (error) throw error;
  } else if (type === "kick-all") {
    const { error } = await supabase
      .from("room_access")
      .update({ access_version: session.access.access_version + 1, updated_at: new Date().toISOString() })
      .eq("room_id", roomId);
    if (error) throw error;
    await deleteSessions(roomId);
  } else if (type === "set-closed") {
    const { error } = await supabase
      .from("room_access")
      .update({
        closed: body.closed === true,
        access_version: session.access.access_version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("room_id", roomId);
    if (error) throw error;
    await deleteSessions(roomId);
  } else {
    throw statusError("Unknown owner action", 400);
  }

  const access = await getAccess(roomId);
  return {
    role: "owner",
    allowPlayerEdit: access.allow_player_edit,
    closed: access.closed,
  };
}

async function requireSession(roomId: string, token: string) {
  const tokenHash = await hashPassword(token);
  const { data: session, error } = await supabase
    .from("room_sessions")
    .select("*")
    .eq("token_hash", tokenHash)
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw error;
  if (!session) throw statusError("Login expired", 401);
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await supabase.from("room_sessions").delete().eq("token_hash", tokenHash);
    throw statusError("Login expired", 401);
  }

  const access = await getAccess(roomId);
  if (!access || session.access_version !== access.access_version) {
    await supabase.from("room_sessions").delete().eq("token_hash", tokenHash);
    throw statusError("Login expired", 401);
  }
  if (access.closed && session.role !== "owner") {
    throw statusError("Room is closed", 403);
  }

  return { ...session, access };
}

function accessResponse(session: any) {
  return {
    role: session.role,
    allowPlayerEdit: session.access.allow_player_edit,
    closed: session.access.closed,
  };
}

async function getAccess(roomId: string) {
  const { data, error } = await supabase
    .from("room_access")
    .select("*")
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createAccess(roomId: string, ownerPassword: string, playerPassword: string) {
  const row = {
    room_id: roomId,
    owner_password_hash: await hashPassword(ownerPassword),
    player_password_hash: await hashPassword(playerPassword),
    access_version: 1,
    allow_player_edit: true,
    closed: false,
  };
  const { data, error } = await supabase.from("room_access").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

async function upsertRoom(roomId: string, state: any) {
  const { error } = await supabase
    .from("rooms")
    .upsert({ id: roomId, state: normalizeState(state), updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function getRoomState(roomId: string) {
  const { data, error } = await supabase.from("rooms").select("state").eq("id", roomId).maybeSingle();
  if (error) throw error;
  return data?.state || null;
}

async function deleteSessions(roomId: string) {
  const { error } = await supabase.from("room_sessions").delete().eq("room_id", roomId);
  if (error) throw error;
}

async function deletePlayerSessions(roomId: string) {
  const { error } = await supabase.from("room_sessions").delete().eq("room_id", roomId).eq("role", "player");
  if (error) throw error;
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeRoomId(value: unknown) {
  const roomId = String(value || "");
  if (!/^[a-zA-Z0-9_-]{6,48}$/.test(roomId)) {
    throw statusError("Invalid room", 400);
  }
  return roomId;
}

function normalizeState(state: any) {
  return state && typeof state === "object" ? state : {};
}

function statusError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
