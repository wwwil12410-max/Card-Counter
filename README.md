# Red/Blue Card Counter

A mobile-first card counter for two tracks: red cards and blue cards. Tapping a card rank subtracts one card from the currently selected track. The bottom buttons can add or subtract the current rank for correction.

The page includes mobile anti-zoom handling so fast repeated taps should not trigger browser double-tap zoom.

## Access Modes

- Without Supabase: local test mode only. Each device keeps its own counts.
- With Supabase + Edge Function: owner-control mode. Everyone opening the same `roomId` link sees the same live counts.

## Owner Control

The owner can:

- Change the player password
- Kick all logged-in users
- Open or close the current room
- Decide whether players can edit counts
- Create a new independent room link

Players enter with the player password. Whether they can edit counts is controlled by the owner.

## Files To Upload To GitHub Pages

Upload:

```text
index.html
styles.css
app.js
config.js
README.md
supabase-schema.sql
supabase/functions/room-auth/index.ts
```

Do not upload:

```text
server.err.log
server.out.log
```

## Supabase Setup

1. Run `supabase-schema.sql` in the Supabase SQL Editor.
2. Deploy the Edge Function at `supabase/functions/room-auth/index.ts`. The function name must be `room-auth`.
3. Add these Edge Function secrets:

```text
OWNER_SETUP_PASSWORD=your_owner_setup_password
DEFAULT_PLAYER_PASSWORD=default_player_password
```

Do not write real passwords in README or frontend code.

4. Edit `config.js`:

```js
window.POKER_COUNTER_CONFIG = {
  supabaseUrl: "https://your-project.supabase.co",
  supabaseAnonKey: "your publishable key",
  roomAuthFunctionUrl: ""
};
```

`roomAuthFunctionUrl` can stay empty. The frontend will use:

```text
https://your-project.supabase.co/functions/v1/room-auth
```

## First Room Setup

1. Open the GitHub Pages link.
2. Choose owner mode.
3. Enter the owner setup password stored in Supabase Secrets.
4. The room permissions will be initialized for this `roomId`.
5. After that, the owner can change the player password in the owner console.

## Important

Real owner control requires the Supabase Edge Function. GitHub Pages frontend-only passwords cannot provide strong access control.
