# nocturne-ui + connector (app-side patterns)

> **Nocturne 4.0-era.** 2.0.0 targets **4.1**, which moved to a Yocto monorepo
> (`usenocturne/nocturne`: `crates/daemon`, `packages/ui`, `image/`), switched
> userspace from armv7 to **aarch64**, replaced the flat `system_[ab].ext2`
> slots with a GPT `superbird.wic` plus a `bandaid.ext4` overlay, and moved the
> webapp root from `/etc/nocturne/ui` to `/usr/lib/nocturne/webapps/ui`.
> `nocturned` and `nocturne-ui` are archived. The device *behaviour* recorded
> below — the :5000 envelope, the MsgPack/SPP wire format, input handling, the
> hardware itself — is unchanged and still correct.
>
> **For 4.1 specifics, read `docs/rebase-4.1/NOTES.md` instead of re-deriving
> them.** It is the researched record, with the command that proves each claim.

## 0. Mental model

Chromium 69-era kiosk at `http://localhost:8080` (static SPA served by nocturned from `NOCTURNE_WEBAPPS_DIR`). Same daemon runs WS RPC on `:5000` — **not same-origin** despite what `nocturne-ui/AGENTS.md:10` claims (port hardcoded at `useNocturned.js:5`). All internet proxied: browser → WS :5000 → daemon → BT → phone/connector.

For a new app, reuse: static-serve path, WS envelope, keyboard-based input contract, Chrome 69 build config. Replace: `spotify.*` namespace + connector dispatcher.

## 1. UI ↔ daemon WebSocket

- Singleton socket (`useNocturned.js:18,543-574`), `ws://localhost:5000`. Listener registry `addGlobalWsListener(id, {onOpen,onMessage,onClose,onError})` (`:406-421`), lazily boots socket.
- On open, immediately sends `reset_boot_counter` — tells daemon boot succeeded, cancels A/B rollback (`:554-573`).
- Request: `{type:"request", id:<uuidv4>, method, params}`. Response matched by `id` from module-level pending Map. Events `{type:"event", topic, data}` fanned to all listeners.
- `sendNocturneWsRequest(method, params, {timeoutMs=30000})` (`:776-851`): polls readyState through CONNECTING/CLOSED, triggers reconnect. UUID fallback for no `crypto.randomUUID` (`:7-16`).
- `sendSpotifyCommand` (`useSpotifyWebSocket.js:113-201`) = second correlation layer on same socket, with readiness gates (`isSpotifyReady`: wsConnected && (appReady||deviceConnected) && auth && !skipped && subscribed) + replay queue. Don't add a third correlation map.
- WS reconnect: exp backoff `1000*2^(n-1)` cap 30s, skips codes 1000/1001. BT reconnect separate: base 2s, max 60s, infinite; watchdog must not poll `bluetooth.devices.list` while live session evidence exists (`src/hooks/AGENTS.md:56`).
- Dead code: `App.jsx:1547,1554` fetches `http://localhost:5000/device/power/*` — no HTTP on :5000. Use WS methods.

Methods used: `reset_boot_counter`, `device.info/.version`, `device.time.get`, `device.timezone.get`, `device.launchApp`, `device.factoryreset`, `device.power.*`, `device.brightness.*`, `device.display.*`, `device.ota.*`, `bluetooth.*`, `audio.record.*`, `voice.cancel`, `wakeword.pause/resume`, `spotify.auth.getStatus`.

## 2. Input handling (most reusable part)

**All hardware input = ordinary DOM keyboard/wheel events.** No JS bridge.

| Input | Event |
|---|---|
| Dial turn | `wheel` with **`deltaX`** (neg=left, pos=right) — horizontal only, never deltaY |
| Dial press | `Enter` keydown/keyup; long = held ≥1000ms |
| Back button | `Escape` |
| Preset buttons 1–4 | keydown; main UI reads `event.key` `"1"–"4"`, mockingbird skin reads `event.code` `"Digit1"–"Digit4"` — **pick `event.code` for new apps** (layout-independent) |
| 5th button (settings/lock) | `m` / `KeyM` |
| Touch | normal touchstart/move/end; pinch disabled by Chromium flag; cursor hidden `cursor: none !important` |

Dial handling patterns (`useNavigation.js`): wheel on `document` `{passive:false}` + preventDefault; rapid-scroll detect (<60ms ticks), drop <15ms ticks; dead-zone `|deltaX|<10`; selection = direct DOM class toggles, not React state (perf).

Long-press thresholds vary: 1000ms generic (mockingbird), 2000ms preset-save, 600ms power menu. **Key trick: `setIgnoreNextRelease` latch** — keydown starts timer only; keyup fires short-press unless long-press fired first (`App.jsx:207-241`, `useButtonMapping.jsx:80-102`). Also suppress key auto-repeat via held-keys Set (`HardwareEvents.js:179-183`).

Gestures (`useGestureControls.js`): >50px swipes, `isWithinScrollableContainer()` DOM walk prevents hijacking scroll areas; touchmove `{passive:false}`.

Wake-input suppression: capture-phase handler swallows first input after display sleep (700ms window, `App.jsx:1204-1254`).

Hazard: nearly all key listeners `{capture:true}` on window, several `stopImmediatePropagation()` — mount-order-dependent; codebase uses isActive flags instead of unmounting.

**Best starting point for a new app: `src/mockingbird/ui/helpers/HardwareEvents.js`** — ~310 lines, self-contained abstraction of the full input surface (dial turn/press/long, back, settings, 4 presets short/long, auto-repeat suppression).

## 3. Chrome 69 constraints

- `vite.config.js:82-86`: `legacy({targets:["chrome >= 64"], renderLegacyChunks:true, modernPolyfills:true})` + `optimizeDeps.esbuildOptions.target="chrome69"`.
- Dev shim `legacyDevTarget()` (`vite.config.js:53-77`): serve-only post plugin, injects polyfills (globalThis, Promise.allSettled, Object.fromEntries, replaceAll, performance.measure try/catch) + re-esbuilds every module to chrome69 incl. HMR client. **Copy vite.config.js verbatim for any new app.**
- Banned: top-level await, `#private` fields, dynamic import in hot paths, `crypto.randomUUID` (fallback needed), CSS `inset:` shorthand (PostCSS plugin expands it but don't rely on it — and inline `style={{inset:0}}` bypasses PostCSS, silent no-op; write longhands). Optional chaining/nullish OK (transpiled).
- Tailwind 3 runtime.

## 4. App structure

- No routing — `BrowserRouter` mounted only so `useNavigate` works; screen selection is if/else over `activeSection` (`App.jsx:1697-1788`). Overlays render outside chain; display-sleep black div `zIndex:2147483647`.
- State: 3 tiers — (1) module-singleton + pub/sub hooks for high-frequency (avoid Context re-render storms), (2) 4 Contexts for low-frequency (Settings/OTA/Notification/Voice), (3) MobX in mockingbird skin only. Don't add Contexts when singleton hook works.
- 800×480: no media queries. `overflow-hidden min-h-screen` root + hardcoded pixel Tailwind values. Black body bg.
- Fonts: no @font-face — system-installed family names via CSS vars; fonts come from Buildroot image. `public/fonts/` is dev-only, not in dist.
- Images: never raw `<img>` to CDN — `SpotifyImage`/`useImageLoader` → `spotify.image.fetch` via daemon → blob URL. Canvas dominant-color extraction feeds gradient background.
- Clock: no `Date` — polls `device.time.get` over WS every 15s, timezone cached.

## 5. Non-Spotify UI features (reference implementations)

Settings (declarative structure object, localStorage-backed, mutual exclusions), OTA update flow (`device.ota.check {currentVersion, channel}` → status events → apply → reboot), BT pairing (discoverable → `bluetooth.agent` PIN event → PairingScreen → pairing_succeeded → persist `lastConnectedBluetoothDevice`), power menu (600ms hold `m`: shutdown/reboot/brightness), display sleep (`device.display.sleep/wake` — never brightness.set for sleep), voice overlay (dismiss must send BOTH `audio.record.stop` + `voice.cancel`), notifications (dedupe by id), network banner (window events, not React state), tutorial (hidden skip: hold Escape+4), lock screen, presets storage (per-phone scoping `nocturne_presets:<bt-address>`).

Gotchas: battery in StatusBar hardcoded 80%; `device.launchApp` latched once per drive, re-armed after ≥10min vs `lastBtLinkDownAt` (wrong var choice yanked users off Maps 5×/drive).

## 6. Connector = phone-side RPC contract

Pi (TS) + macOS (Swift) answer identical method set. New companion app must satisfy this.

- Wire: MsgPack chunks, header `u8 idLen | id | u16BE index | u16BE total | u32BE crc32 | u16BE payloadLen | payload` (`rpc/chunking.ts:27-64`), chunk 2000B. Live Car Thing link uses **base64-newline framing** (`nocturne-manager.ts:132`). Envelope types `call/result/error/event` — **different from browser↔daemon `request/response`**; daemon translates.
- Retransmit: device sends `chunk.retransmit_request {message_id, chunk_idx}` → connector replays from `sentChunks` map.
- Methods answered (`nocturne-manager.ts:360-452`): `ping` → `{pong}`, `device.info`, `spotify.auth.getStatus`, `device.ota.check/.download/.transfer` (default transfer size 31680), `device.timezone.get`, `device.time.get`, `media.control.*` (macOS→MediaRemote), `spotify.*` → dispatcher, else `{error:"Unknown method"}`.
- `spotify.*` dispatcher: 38 methods in one Map (`spotify-commands.ts:20-75`) — player/devices/library/catalog/profile/radio/lyrics/dj/image/search. Responses filtered (`spotify-filters.ts`) to strip bloat before ~2KB-chunk BT link — **essential pattern for low-bandwidth link**.
- Events pushed: **`app.ready`** (most important — UI readiness gate hangs on it; `{platform:"web", datetime, time, timezone{...}, spotifySkipped}`), `spotify.auth.*`, `spotify.player.state_changed/device_state_changed/volume_changed`, `device.ota.package_state`, `notification.show`; macOS adds `media.nowPlaying.update/.artwork` (base64 JPEG ≤600px), `device.volume.update`.
- Keep-alive: `ping {message:"keepalive"}` every 15s. On new connection: 500ms → ping → device.info → app.ready.
- Pi BT: BlueZ `Profile1` via dbus-next for inbound SPP (UUID 00001101-…); **outbound dial = raw libc FFI socket AF_BLUETOOTH/BTPROTO_RFCOMM, channel 2 default** (`rfcomm-client.ts:59`). Auto-dial 2s after ACL up.
- macOS BT: IOBluetooth. **Ch 3 = inbound probe listener; ch 2 = actual RPC link dialed outbound by Mac** after Car Thing probes ch 3. Two missed 15s keep-alives → tear down incl. ACL. Pairing never app-driven (System Settings only).

## 7. Anti-patterns (from AGENTS.md + found)

1. No `<Route>` elements; Router is useNavigate shell.
2. No modern-Chrome syntax (see §3).
3. No mockingbird imports in main UI (MobX leak).
4. Never fetch Spotify directly — everything via sendSpotifyCommand.
5. No TypeScript in nocturne-ui; connector src IS TypeScript.
6. Refs-for-callbacks pattern deliberate — stale closures in long-lived listeners.
7. MsgPack chunk format = public wire contract; changing breaks shipped apps.
8. Firmware consumes released artifacts — local UI edits invisible until `_VERSION` bump + `just cleandeps`.
9. Connector: no BT in routes/, DBus not bluetoothctl, no hardcoded hostname, state in /data.

## 8. Build → device

- `bun run build` → `dist/` (index.html + assets modern+legacy + images + license; fonts excluded).
- CI zips dist flat (index.html at zip root — layout contract). `nocturne-ui.mk` downloads from nightly.link at tag, unzips, installs to `/etc/nocturne/ui`.
- Dev loop on hardware: remount rw, edit `--app=` URL in `/etc/supervisord.conf` `[program:chromium]` to point at dev server, `supervisorctl reread && supervisorctl restart chromium`. (AGENTS.md runit flow stale.)
- **Chromium DevTools reachable at device port 2222** — practical hardware debugging path.

## 9. Copy verbatim for new kiosk app

1. `vite.config.js` (legacy plugin + dev shim) — highest-value file, app-agnostic
2. `postcss.config.js` (inset fix)
3. `HardwareEvents.js` (input abstraction)
4. `sendWsRequest` pattern + `addGlobalWsListener` + backoff reconnect from `useNocturned.js`
5. Module-singleton + pub/sub hook shape
6. `setIgnoreNextRelease` long/short-press latch
7. Wake-input-suppression pattern
