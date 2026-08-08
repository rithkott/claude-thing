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
- **Legacy JS chunks**: the served HTML is rewritten so the Vite
  `@vitejs/plugin-legacy` (chrome69/SystemJS) bundles execute — the exact code
  path the device's Chromium 69 runs — instead of the modern module build.
- **Device-class resources**: Chrome's V8 heap is capped and the renderer is
  CPU-throttled over the DevTools protocol to approximate 4× Cortex-A53
  @1.8GHz with 512MB shared RAM.
- **40ms button polling**: hardware buttons go through the kernel's
  `gpio-keys-polled` driver at 40ms — press/release timing is quantized and a
  tap shorter than one poll window is dropped. The faceplate samples its
  buttons the same way. (The rotary encoder is event-driven on hardware and is
  deliberately *not* quantized.)
- **Device fonts**: Inter / Circular Sp / Noto are pulled out of the rootfs
  (`/usr/share/fonts`) and served via `@font-face`, so text renders with the
  device families instead of macOS fallbacks.

## Faceplate geometry

Everything is drawn at true physical scale: the 3.97" 800×480 panel is 86.4mm
wide → **9.259 px/mm** (`--mm` in `shell/faceplate.css`, mirrored by
`FACE_W/H` in `src/config.js`). Proportions are measured off Spotify's product
photography: device face 117×64mm → 1083×593px (the quoted 124mm width
includes the dial overhang and logo tag); dial is a **plain smooth ⌀36mm disc
(⌀333px, no ridges or index dot — rotation reads from its sheen)** sitting
upper-right ~5mm from the top edge, its center ~9mm in from the right edge, so
it **overhangs the face's right side by ~8.5mm and just kisses the display's
right edge — on purpose, like the real unit**. Back button ⌀10.6mm below it
near the corner. Clicks in the dial's square corners fall through to the
screen (`clip-path` hit-testing).

## Usage

```bash
node scripts/deploy-dev.js     # or: npm run deploy   (or tell Claude "deploy to dev")
```

Finds the newest Nocturne 4.1 zip (`superbird.wic` + `meta.json`) in
`<project>/firmware/`, `~/Desktop`, `~/Downloads` → carves `root_a` out of the
wic by GPT offset → extracts `/usr/lib/nocturne/webapps/ui` (and
`/usr/share/fonts`) via debugfs (cached per zip+mtime) → restarts the server →
opens a Chrome app-mode window.

The carve streams (`unzip -p | tail -c | head -c`), so the 1.43 GB wic is never
written to disk in full. 4.0.7-era zips of flat `system_[ab].ext2` slots are no
longer supported.

Requirements: Node ≥18, `unzip`, `zipinfo`, and e2fsprogs
(`brew install e2fsprogs`).

Controls: click everything on the faceplate; keyboard `1–4`, `M`, `Enter`,
`Escape`, and `←`/`→` for the dial. Drag or scroll the knob to turn it; click
it to press; hold to long-press.

### Env flags

| Flag | Default | Meaning |
|---|---|---|
| `EMU_CPU_THROTTLE` | `8` | CDP CPU throttle factor (≈ one A53 @1.8GHz vs an Apple Silicon core). **`0` to disable for fast dev iteration** |
| `EMU_JS_HEAP_MB` | `200` | `--max-old-space-size` V8 heap cap (device: 512MB total, shared). `0` = uncapped |
| `EMU_INPUT_POLL_MS` | `40` | gpio-keys-polled quantization for buttons. `0` = instant dispatch |
| `EMU_FORCE_LEGACY` | on | `0` = serve the modern module chunks instead of the chrome69 legacy path. No-op on 4.1+, whose UI ships module-only with no `nomodule` twin |
| `EMU_DEVICE_FONTS` | on | `0` = macOS font fallbacks |
| `EMU_CDP_PORT` | `9223` | Chrome remote-debugging port used for throttling |
| `EMU_CHROME_BIN` | — | Alternate browser binary (e.g. an old Chromium build) launched with the same flags |
| `SIM_PHONE` | on | `0` = no simulated phone — UI sits in onboarding/pairing like phoneless hardware |
| `SPOTIFY_SKIPPED` | on | `0` = report Spotify as authenticated instead of skipped |

The status strip under the faceplate shows the active fidelity settings
(`cpu 8x · heap 200MB · keys 40ms · legacy js · device fonts`).

Other commands: `npm run check` (extraction only), `npm run start` (server in
foreground), `npm run smoke` (WS protocol semantics test; server must be up).

Logs: `logs/server.log`, `logs/ws.log` (every WS frame both directions).

## Known limitations

- The JS *code path* matches the device (legacy chunks), but the engine is
  still modern Chrome — new DOM/CSS APIs the device lacks would not throw
  here. Keep a hardware smoke test before releases. (A real Chromium 69 binary
  can be tried via `EMU_CHROME_BIN`, but 2018 builds rarely launch on current
  macOS.)
- The CPU throttle is duty-cycle based and the heap cap covers V8 old space
  only (not DOM/GPU/image memory) — approximations, not cycle-accurate
  emulation. No Mali-G31, thermal, or eMMC/swap-pressure model.
- ProMotion Macs run `requestAnimationFrame` at up to 120Hz vs the panel's
  fixed 60.02Hz.
- `spotify.*` beyond auth status is not emulated; music screens dead-end with
  the connector's verbatim `Unknown method` error. The UI runs in
  Spotify-skipped mode, matching a real device without Spotify auth.
- Synthetic events carry `isTrusted:false` (the firmware never checks).
- Mouse drags on the screen are mouse events, not touch — swipe-gesture code
  paths need DevTools touch emulation.
- The claude app's `Chakra Petch`/`JetBrains Mono` aren't in the rootfs either;
  their fallback differs between macOS and device fontconfig.
- macOS AirPlay Receiver also listens on `*:5000`; the emulator binds
  `127.0.0.1`/`::1` specifically, which coexists and wins for localhost.
