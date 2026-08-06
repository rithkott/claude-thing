# nocturned + iap2-rs (device-side services)

> Doc drift: `nocturned/AGENTS.md` slightly stale — omits `webapp_server.rs` + `app/hid_mapping.rs`, says 20ms audio frames (code uses 60ms, `audio.rs:15-21,64`). Trust code.

## 1. WebSocket API on :5000

Raw `tokio-tungstenite` server, bound `127.0.0.1:5000`, **no HTTP layer** (`websocket.rs:186`). Text frames only.

> Gotcha: `nocturne-ui/src/App.jsx:1547,1554` fetches `http://localhost:5000/device/power/shutdown` — endpoint doesn't exist. Dead code; real path is `device.power.*` WS methods.

**Envelope** — serde-tagged on `type` (`websocket.rs:17-40`):

| type | fields |
|---|---|
| `request` | `id`, `method`, `params` |
| `response` | `id`, `result` |
| `error` | `id`, `error` |
| `event` | `topic`, `data`, optional `server_timestamp_ms` |

Critical semantics:
1. **Responses + events broadcast to EVERY connected client** (`websocket.rs:1504-1531`). Correlation is client-side by `id`.
2. **No subscribe protocol** — connecting = subscribed to all. On connect, server replays cached `app.ready` and `voice.wakeword.state`.

### Device-local methods (never touch phone)

`device.ab.get/.reset/.setSlot/.setBootResult/.failover`, `device.brightness.get/.set/.auto`, `device.display.get/.sleep/.wake`, `bluetooth.discoverable`, `bluetooth.devices.list`, `device.version`, `device.info`, `device.ota.apply` (spawns `swupdate-client`), `reset_boot_counter` (`phb -r 1`), `device.power.reboot/.shutdown`, `device.factoryreset` (`uenv set firstboot 1` + reboot), `spotify.image.fetch` (disk cache short-circuit). All in `websocket.rs:334-1440`.

### Routed to BluetoothDaemon

`bluetooth.device.connect/.disconnect/.unpair/.forget` (`websocket.rs:918-985` → `bluetooth.rs:149-476`). Intercepted pre-phone: `audio.record.start/stop`, `wakeword.pause/resume`, `voice.cancel` (`bluetooth.rs:482-563`). `media.control.*` → direct iAP2 HID (`iap2_wrapper.rs:809-836`, canonical map `app/hid_mapping.rs:3-16`: play/pause/playPause/next/previous/shuffle/repeat/volumeUp/volumeDown). `device.launchApp {bundleId}` (`iap2_wrapper.rs:838-863`).

### Everything else → phone

Fallthrough wraps request as protocol `com.usenocturne.daemon`, session 1, becomes MsgPack `Call` (`websocket.rs:1442-1454`). Allow-list of ~45 phone-bound methods at `app/websocket_handler.rs:113-161`: all `spotify.*` (player/library/artist/album/playlist/show/radio/dj/lyrics/devices), `device.timezone.get`, `device.time.get`, `tts.speak/stop`, `voice.cancel`, `onboarding.set_state`, plus `device.ota.check/.download`.

### Event topics to UI

Daemon-originated: `bluetooth.connection/.device/.pairing/.agent/.mfi/.discoverable`, `media.nowPlaying.update/.artwork/.artwork.failed`, `ambient_light_update`, `audio.level`, `voice.wakeword`, `voice.wakeword.state`, `device.ota.progress/complete/error/status`, `phone.volume.update`, `chunk.retransmit_request`.

Phone-originated pass through **verbatim** (`app/msgpack.rs:1006-1008`): `app.ready`, `subscription.updated`, `notification.show`, `network.status`, `voice.transcription`, `daemon.heartbeat`, anything else. **Extension point: new phone-side event needs ZERO daemon changes to reach UI.** Three topics have server-side effects (`websocket.rs:1477-1497`): `app.ready` cached + gates wake word, `subscription.updated` patches cache, `media.nowPlaying.update` sets playback-active.

## 2. MsgPack RPC wire contract (phone link)

`MsgPackMessage`: `call`/`result`/`error`/`event`, serialized `rmp_serde::to_vec_named` (map form).

**Chunk envelope** (`app/msgpack.rs:130-192` parse, `332-372` build):

```
[1B id_len=36][36B ASCII UUID][2B index BE][2B total BE][4B CRC32 BE][2B payload_len BE][payload ≤2000]
```

Validated: `id_len` must be 36 (doubles as frame-sync marker — leading `0x24` = envelope, else bare MsgPack); UUID hyphens at 8/13/18/23; `total<=1000`; CRC32 (crc32fast) over chunk payload only; outbound UUIDs uppercased. `CHUNK_SIZE=2000`; OTA file chunks use `OTA_CHUNK_SIZE=1800`.

Reassembly: per-session `BytesMut`, cap 256KB (overflow drops whole buffer). CRC mismatch emits `chunk.retransmit_request` WS event but **no actual retransmit protocol**. Known limit: multi-chunk *synchronous responses* unsupported (`:1139-1142`); async pushes fine.

**Transports:**

| | iOS | Android / macOS |
|---|---|---|
| Transport | iAP2 EA session, RFCOMM ch 1 | RFCOMM SPP (UUID 00001101-…) ch 2 |
| Framing | raw chunk bytes in EA datagrams | **base64 + newline-delimited lines** per chunk (`bluetooth.rs:968-1077`) |

macOS connector: daemon probes Mac on ch 3 (`MACOS_CONNECTOR_PROBE_CHANNEL`, `bluetooth.rs:1417`), holds 750ms, Mac dials back to ch 2. **The Mac hardcodes ch 2 and never runs an SDP query** — a missing Serial Port entry in macOS's service list is the device having dropped the profile, never a stale Mac SDP cache, so re-pairing is not the fix.

Both profiles are BlueZ `RegisterProfile` registrations scoped to the handle nocturned holds; if bluetoothd restarts, the handle dies and the SDP record plus the RFCOMM listener go with it while ACL/AVRCP survive — macOS keeps saying "Connected" over a port nobody is listening on. `patches/nocturned-spp-reregister.patch` puts each registration under a supervisor loop that re-registers with 1s→30s backoff, re-asserts adapter discoverable/pairable/alias + the pairing agent, and broadcasts `bluetooth.profile` registered/unregistered.

**Handshake:** daemon sends `daemon.ready` event on session open, re-sends every 3s until phone replies `app.ready`; then `daemon.heartbeat` every 10s. Phone→daemon calls the daemon answers itself: `ping`, `device.info`, `device.volume.update`, `media.control.*` (`app/msgpack.rs:279-302,643-707`).

## 3. Static web server

`webapp_server.rs` (33 lines): axum 0.8 + `tower_http::ServeDir` with SPA index fallback. Dir from `NOCTURNE_WEBAPPS_DIR` (default `/opt/nocturne/webapps/ui`; prod sets `/etc/nocturne/ui`). Listen `127.0.0.1:8080` hardcoded. **Missing dir = silent no-server** — Chromium waits forever.

## 4. Hardware access

- **MFi** (`mfi.rs`): `/dev/apple_mfi` ioctls — `0x80107704` cert len, `0x80107705` cert, `0x40107706` set 32B challenge + 100ms sleep + `0x80107707` read 64B ECDSA P-256 sig. Sanity checks reject all-0x00/0xFF/ASCII responses. No cert fallback (AGENTS.md wrong).
- **Audio**: no ALSA bindings — **forks `arecord -D hw:0,0 -f S16_LE -c 1 -r 16000 -t raw`** (`audio.rs:329-346`), 1920B/60ms frames → Opus (VoIP, 24kbps VBR). Wake word runs a **second independent arecord** on same device (`wakeword.rs:432-449`) — mic contention is why capture start pauses detector with ack handshake.
- **Wake word**: `tract-onnx` (pure Rust). openWakeWord 3-stage: melspectrogram → embedding → per-keyword classifier. **Any extra `.onnx` in `/etc/nocturne/models` auto-loads as new keyword** (`wakeword.rs:393-426`). Thresholds via `WAKEWORD_THRESHOLD` env. Mute persisted `/var/lib/wakeword.state`.
- **Bluetooth**: `bluer` 0.17 over system bluetoothd. Registers iAP2 profile UUID `00000000-deca-fade-deca-deafdecacaff` ch 1 (hand-written SDP XML) + SPP ch 2. Raw dbus for pairing agent (`bluetooth_agent.rs`, auto-accepts, PIN 0000) and device enumeration.
- **Buttons/dial: NOT daemon's job.** Kernel evdev → Weston/libinput → Chromium JS. Dial = `event1` wheel events; buttons = keydown `"1"`–`"4"`.
- Sysfs: `/sys/class/efuse/usid` (serial), `/sys/class/backlight/aml-bl/brightness`, `/sys/bus/iio/devices/iio:device0/in_intensity0_raw` (ALS), `/dev/misc` offset 2048 (A/B metadata).

## 5. Internal architecture

`main.rs` (226 lines) flat init: tracing → `Config::load` (`/etc/nocturne/config.json` — one field `debug_logs`, never read) → brightness init → ImageCache (`/var/cache/nocturned/images`; **failure silently exits daemon**) → WS :5000 → webapp :8080 → ALS poll → AudioCapture + wake word → `BluetoothDaemon.run()` blocks until signal.

Channels: `ws_to_app` mpsc (WS→BT daemon); audio broadcast cap 64; `audio_cmd` mpsc; `wakeword_pause` mpsc with oneshot ack (1s timeout); `ea_data` mpsc; `hid` mpsc. Per-connection heart: `run_iap2_connection` (`iap2_wrapper.rs:213-533`) — 7-arm select + 500ms tick (daemon.ready resend, heartbeat, RequestAppLaunch retry max 5).

Protocol handlers: hand-rolled enum `AppProtocolHandlerEnum::{MsgPack, WebSocket}` keyed by protocol string (`app/mod.rs:33-76`). **New protocol = new enum variant** — not externally implementable trait.

## 6. OTA flow

1. UI sends `device.ota.check/.download` — forwarded to **phone** (phone does internet fetch).
2. Phone emits `device.ota.package_state {state:"download_success", name, version, hash(MD5), size}` → daemon **pulls** sequential 1800B chunks via `device.ota.transfer {name,offset,size,version}` calls, writes `/tmp/nocturne-update.swu`, MD5-verifies, emits progress/complete/error (`app/msgpack.rs:1416-1660`). Legacy push path via `device.ota.chunk` events also exists.
3. `device.ota.apply` shells `swupdate-client <file>`; success = exit status + stdout string-match. swupdate daemon (supervisord) verifies signature with `/etc/nocturne.pem` and writes inactive slot.
4. `ab.rs`: 32-byte record at `/dev/misc` offset 2048, magic `\x00AB0`, per-slot {priority, tries_remaining, successful_boot}, CRC32 BE. Boot counter reset = `phb -r 1` (UI sends on every WS connect).

## 7. iap2-rs

~2.9K lines, 8 modules. Deps: tokio, bluer, bytes, thiserror. No serde.

Layers:
- `packet.rs` — framing `FF 5A | len u16 BE | control | seq | ack | session | hdr_cksum | payload | payload_cksum` (two's-complement sum checksum). SYN payload = hardcoded 19-byte reverse-engineered blob.
- `link.rs` — state machine Idle→SynSent→Established. iAP1 probe (`FF 55 02 00 EE 10`), DETECT, SYN seq 0x9D, retry ≤30. `send_data` = synchronous stop-and-wait with inline EAK retransmit. Reader cancellation-safe.
- `auth.rs` — `0xAA01` cert (+ hardcoded trailer `a1 00 31 00`), `0xAA03` challenge response; crypto delegated to `MfiAuthProvider`.
- `connection.rs` — negotiate → auth (`0xAA00`→`0xAA02`→`0xAA05/04`) → identification (`0x1D00/02/03`) → auto-request EA session; handles `0xEA00/01`, `0x5001` NowPlaying, `0x4158` status.
- `session/` — control, ea, hid, now_playing, file_transfer (880 lines, session ID fixed 1).

Consumer must provide: (1) `bluer::rfcomm::Stream` — crate does no sockets/SDP/pairing; (2) `Arc<dyn MfiAuthProvider>` — 2 async methods `read_certificate()` + `challenge_response(&[u8;32])`; (3) `DeviceIdentification` incl. message-ID lists + `ea_protocol_name`. Then drain `conn.events` + `conn.ea_sessions`.

Rough edges: EA protocol name hardcoded `"com.usenocturne.daemon"` at registration (`connection.rs:436`), ignores config; EA sessions registered lazily on **first inbound byte** — can't send before phone speaks. Testing: `MockMfiProvider` only; no integration tests; `empty()` passes cert read but phone rejects auth — link layer only testable without hardware.

## 8. Full daemon capability inventory (non-music)

Time sync (`date -s` from phone datetime), timezone (fetched, logged, never applied), notifications relay, brightness (manual/auto with stock ALS curve, 40ms smoothing), display sleep, ambient light poll, power (reboot/shutdown/factory reset), A/B slot management, boot counter, OTA, BT management + pairing agent, device identity (efuse serial), static web server, voice pipeline (wake word → Opus capture → phone), mic level (~5Hz `audio.level`), image disk cache, phone volume relay, subscription cache merge, network status (logged only).

**Music-coupled surface is thin** — spotify.* is a pass-through string allow-list; NowPlaying/HID in `iap2_wrapper.rs` only real media semantics. Transport, chunking, brightness, power, OTA, A/B, BT, audio, wake word all domain-neutral, reusable as-is.

## 9. Seams for new software

- a) New phone round-trip method: add to allow-list `app/websocket_handler.rs:113-161`. New device-local method: branch in `websocket.rs::handle_incoming_message`.
- b) New wake word: drop `.onnx` in models dir.
- c) New phone→UI event: zero daemon code.
- d) Whole new frontend: change `NOCTURNE_WEBAPPS_DIR` (1-line supervisord env change).
