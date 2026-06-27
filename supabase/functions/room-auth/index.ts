import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ownerSetupPassword = Deno.env.get("OWNER_SETUP_PASSWORD") || "";
const supabase = createClient(supabaseUrl, serviceRoleKey);
const JOIN_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const GRANT_LINK_TTL_MS = 48 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "owner-login") {
      return json(await ownerLogin(safeRoomId(body.roomId), body));
    }
    if (action === "join-with-token") {
      return json(await joinWithToken(safeRoomId(body.roomId), String(body.joinToken || "")));
    }
    if (action === "create-room-from-grant") {
      return json(await createRoomFromGrant(String(body.grantToken || ""), body));
    }
    if (action === "validate") {
      return json(await validate(safeRoomId(body.roomId), String(body.token || "")));
    }
    if (action === "save-state") {
      const session = await requireSession(safeRoomId(body.roomId), String(body.token || ""));
      await upsertRoom(session.room_id, body.state);
      return json(accessResponse(session));
    }
    if (action === "owner-action") {
      return json(await ownerAction(safeRoomId(body.roomId), body));
    }

    throw statusError("Unknown action", 400);
  } catch (error) {
    const status = error.status || 500;
    return json({ error: error.message || "Server error" }, status);
  }
});

async function ownerLogin(roomId: string, body: any) {
  const password = String(body.password || "");
  let access = await getAccess(roomId);

  if (!access) {
    if (!ownerSetupPassword) {
      throw statusError("OWNER_SETUP_PASSWORD is not configured", 500);
    }
    if (password !== ownerSetupPassword) {
      throw statusError("Wrong owner password", 403);
    }
    const initialState = normalizeState(body.initialState);
    await upsertRoom(roomId, initialState);
    access = await createAccess(roomId, ownerSetupPassword);
  }

  if ((await hashValue(password)) !== access.owner_password_hash) {
    throw statusError("Wrong owner password", 403);
  }

  if (access.closed) {
    access = await setRoomClosed(roomId, false);
  }

  const token = await createSession(roomId, "owner", access.access_version);
  const state = await getRoomState(roomId);
  return {
    token,
    role: "owner",
    state,
    closed: access.closed,
  };
}

async function joinWithToken(roomId: string, joinToken: string) {
  const tokenRow = await getRoomToken(joinToken, "join", roomId);
  if (!tokenRow) throw statusError("Player link is invalid or expired", 403);

  const access = await getAccess(roomId);
  if (!access) throw statusError("Room does not exist", 404);
  if (access.closed) throw statusError("Room is closed", 403);

  const token = await createSession(roomId, "player", access.access_version, tokenRow.expires_at);
  const state = await getRoomState(roomId);
  return {
    token,
    role: "player",
    state,
    closed: access.closed,
    expiresAt: tokenRow.expires_at,
  };
}

async function createRoomFromGrant(grantToken: string, body: any) {
  const tokenRow = await getRoomToken(grantToken, "grant");
  if (!tokenRow) throw statusError("Grant link is invalid or expired", 403);

  const roomId = createRoomId();
  const initialState = normalizeState(body.initialState);
  await upsertRoom(roomId, initialState);
  const delegatedPassword = "grant:" + crypto.randomUUID();
  const access = await createAccess(roomId, delegatedPassword);
  const token = await createSession(roomId, "owner", access.access_version, tokenRow.expires_at);

  return {
    roomId,
    token,
    role: "owner",
    state: initialState,
    closed: false,
    expiresAt: tokenRow.expires_at,
  };
}

async function validate(roomId: string, token: string) {
  const session = await requireSession(roomId, token);
  const state = await getRoomState(roomId);
  return { ...accessResponse(session), state };
}

async function ownerAction(roomId: string, body: any) {
  const session = await requireSession(roomId, String(body.token || ""));
  if (session.role !== "owner") {
    throw statusError("Owner permission required", 403);
  }

  const type = String(body.type || "");
  if (type === "set-closed") {
    await setRoomClosed(roomId, body.closed === true);
  } else if (type === "create-join-link") {
    const expiresAt = new Date(Date.now() + JOIN_LINK_TTL_MS).toISOString();
    const joinToken = await createRoomToken("join", roomId, expiresAt);
    return { ...accessResponse(session), joinToken, expiresAt };
  } else if (type === "create-grant-link") {
    const expiresAt = new Date(Date.now() + GRANT_LINK_TTL_MS).toISOString();
    const grantToken = await createRoomToken("grant", null, expiresAt);
    return { ...accessResponse(session), grantToken, expiresAt };
  } else {
    throw statusError("Unknown owner action", 400);
  }

  const access = await getAccess(roomId);
  return {
    role: "owner",
    closed: access.closed,
  };
}

async function requireSession(roomId: string, token: string) {
  const tokenHash = await hashValue(token);
  const { data: session, error } = await supabase
    .from("room_sessions")
    .select("*")
    .eq("token_hash", tokenHash)
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw error;
  if (!session) throw statusError("Login expired", 401);
  if (new Date(session.expires_at).getTime() <= Date.now()) {
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
    closed: session.access.closed,
  };
}

async function createSession(roomId: string, role: "owner" | "player", accessVersion: number, expiresAt?: string | null) {
  const token = crypto.randomUUID() + "." + crypto.randomUUID();
  const tokenHash = await hashValue(token);
  const sessionRow: any = {
    token_hash: tokenHash,
    room_id: roomId,
    role,
    access_version: accessVersion,
  };
  if (expiresAt) sessionRow.expires_at = expiresAt;
  const { error } = await supabase.from("room_sessions").insert(sessionRow);
  if (error) throw error;
  return token;
}

async function createRoomToken(tokenType: "join" | "grant", roomId: string | null, expiresAt: string | null) {
  const token = crypto.randomUUID() + "." + crypto.randomUUID();
  const tokenHash = await hashValue(token);
  const { error } = await supabase.from("room_tokens").insert({
    token_hash: tokenHash,
    token_type: tokenType,
    room_id: roomId,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return token;
}

async function getRoomToken(token: string, tokenType: "join" | "grant", roomId?: string) {
  if (!token) return null;
  let query = supabase
    .from("room_tokens")
    .select("*")
    .eq("token_hash", await hashValue(token))
    .eq("token_type", tokenType)
    .eq("revoked", false);

  if (roomId) query = query.eq("room_id", roomId);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
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

async function createAccess(roomId: string, ownerPassword: string) {
  const row = {
    room_id: roomId,
    owner_password_hash: await hashValue(ownerPassword),
    player_password_hash: "",
    access_version: 1,
    allow_player_edit: true,
    closed: false,
  };
  const { data, error } = await supabase.from("room_access").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

async function setRoomClosed(roomId: string, closed: boolean) {
  const { data, error } = await supabase
    .from("room_access")
    .update({ closed, updated_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .select("*")
    .single();
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

async function hashValue(value: string) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createRoomId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
