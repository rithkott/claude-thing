# Car Thing Dev Emulator

Runs the actual Nocturne firmware webapp — extracted straight out of a generated
firmware zip's rootfs — inside a faithful on-screen Car Thing: 800×480 screen,
4 preset buttons, settings button, rotary dial (turn + press), back button.

The emulator reproduces the device runtime exactly:

- Static UI served at hardcoded `127.0.0.1:8080` with SPA fallback (what
  nocturned's `webapp_server.rs` does on the device).
- Mock nocturned WebSocket RPC on `localhost:5000` — same envelope
  (`request`/`response`/`error`/`event`), same broadcast-to-all-clients
  semantics, same connect-time replay of `app.ready` / `voice.wakeword.state`.
- All input delivered as the same DOM events hardware produces: dial turn =
  `wheel` with `deltaX`, dial press = `Enter`, back = `Escape`, presets =
  `1`–`4` / `Digit1`–`Digit4`, settings = `m`/`KeyM`. Long-presses work because
  buttons send keydown on press and keyup on release, like real keys.

## Usage

```bash
node scripts/deploy-dev.js     # or: npm run deploy   (or tell Claude "deploy to dev")
```

Finds the newest `nocturne*.zip` containing a `system_*.ext2` rootfs in
`<project>/firmware/`, `~/Desktop`, `~/Downloads` → extracts `/etc/nocturne/ui`
via debugfs (cached per zip+mtime) → restarts the server → opens a Chrome
app-mode window.

Requirements: Node ≥18, `unzip`, `zipinfo`, and e2fsprogs
(`brew install e2fsprogs`).

Controls: click everything on the faceplate; keyboard `1–4`, `M`, `Enter`,
`Escape`, and `←`/`→` for the dial. Drag or scroll the knob to turn it; click
it to press; hold to long-press.

Env flags: `SIM_PHONE=0` (no simulated phone — UI sits in onboarding/pairing
like phoneless hardware), `SPOTIFY_SKIPPED=0` (report Spotify as authenticated
instead of skipped).

Other commands: `npm run check` (extraction only), `npm run start` (server in
foreground), `npm run smoke` (WS protocol semantics test; server must be up).

Logs: `logs/server.log`, `logs/ws.log` (every WS frame both directions).

## Known limitations

- Desktop Chrome executes the firmware's *modern* JS chunks; the device's
  Chrome 69 runs the *legacy* chunks. The emulator proves logic/UX, not
  Chrome-69 syntax compatibility — keep a hardware smoke test before releases.
- `spotify.*` beyond auth status is not emulated; music screens dead-end with
  the connector's verbatim `Unknown method` error. The UI runs in
  Spotify-skipped mode, matching a real device without Spotify auth.
- Synthetic events carry `isTrusted:false` (the firmware never checks).
- Mouse drags on the screen are mouse events, not touch — swipe-gesture code
  paths need DevTools touch emulation.
- Fonts fall back to macOS system fonts (device fonts live in the Buildroot
  image, not the webapp).
- macOS AirPlay Receiver also listens on `*:5000`; the emulator binds
  `127.0.0.1`/`::1` specifically, which coexists and wins for localhost.
