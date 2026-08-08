# Building new software for the Car Thing — synthesis

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

Everything here derives from [hardware.md](hardware.md), [firmware.md](firmware.md), [daemon.md](daemon.md), [ui.md](ui.md).

## The device in one paragraph

Amlogic S905D2, 4×A53, **512 MB RAM**, 4 GB eMMC, 480×800 MIPI panel rotated to 800×480, capacitive touch, rotary dial + 7 GPIO keys, 4 PDM mics (no speaker), BT-only radio (**no Wi-Fi**), single USB-C (power/burn/gadget), Apple MFi auth chip. Bootloader unlocked by design (signed Spotify BL2 → U-Boot shell). All input reaches userland as plain evdev; in a browser that's `wheel` deltaX (dial), `Enter`, `Escape`, `Digit1-4`, `KeyM`.

## Hard constraints (memorize)

1. **32-bit armv7 EABIHF userspace** on arm64 4.9 vendor kernel (if staying on Nocturne/stock base). Prebuilt armv7 musl binaries work.
2. **512 MB RAM** with Chromium eating most of it; swapfile on eMMC (wear vector). Thermal critical poweroff at 85°C.
3. **No Wi-Fi.** Internet = USB RNDIS host, BT (phone/connector), or external hardware.
4. **Read-only rootfs** (~516 MB budget); persist only to `/var` (data) or `/var/lib` (settings).
5. **Chrome 69-era browser** if using Nocturne's kiosk: no top-level await, no `#private` fields, no `crypto.randomUUID`, no CSS `inset:` shorthand. Copy `nocturne-ui/vite.config.js` verbatim.
6. GPU = Mali blob + Weston 3 only. Native GUI apps effectively impossible; **the browser is the UI layer**.

## Decision tree: 4 ways to ship software

### Path 1 — Web app on Nocturne firmware (days, easiest)
Keep entire Nocturne stack; replace/add the SPA.
- nocturned serves `NOCTURNE_WEBAPPS_DIR` (`/etc/nocturne/ui`) on :8080 with SPA fallback; kiosk URL overridable via `NOCTURNE_CHROMIUM_URL` in supervisord.
- Talk to `ws://localhost:5000` for device services you get FREE: brightness/auto-brightness, display sleep/wake, power, A/B + boot counter, OTA plumbing, BT management + pairing agent, wake word (drop new `.onnx` in `/etc/nocturne/models`), mic capture → Opus, image cache, time sync.
- Phone→UI events pass through daemon **verbatim** — new companion-app features need zero daemon changes.
- Dev loop: point kiosk at dev machine's Vite server (edit `--app=` URL, `supervisorctl restart chromium`); debug via Chromium CDP on device port 2222.
- Non-music example: dashboard, smart-home panel, timer — anything whose data comes over BT from a companion or needs no internet.

### Path 2 — Fork the companion (weeks; new data source)
Device untouched or lightly touched; implement the phone-side RPC contract.
- Contract: MsgPack `call/result/error/event`, chunked `[36B UUID][u16 idx][u16 total][u32 CRC32][u16 len][≤2000B]`, base64+newline framing on SPP ch 2 (iOS: raw chunks in iAP2 EA over ch 1, needs MFi handshake — daemon handles it).
- Must send `app.ready` (UI readiness gate), answer `ping`, `device.info`, `device.time.get`, `device.timezone.get`; keep-alive ping every 15s.
- Easiest fork base: `nocturne-connector/src` (TypeScript/Bun, runs on any Linux box or the macOS Swift port). Replace the 38-method `spotify.*` dispatcher Map with your own namespace; daemon forwards unknown methods if added to allow-list (`nocturned app/websocket_handler.rs:113-161`).
- Filter/strip payloads before the ~2 KB-chunk BT link — bandwidth is tiny.

### Path 3 — New daemon / Buildroot package (weeks; needs device capabilities)
Fork `nocturne/` firmware tree.
- Add package: `external/package/<name>/{Config.in,<name>.mk}` + source line in `external/Config.in` + `BR2_PACKAGE_X=y` in defconfig. Cargo/cmake/prebuilt-binary patterns all exist as examples.
- New long-running service: install a `.conf` into `/etc/supervisor.d/` (include dir already declared in supervisord.conf, must be created).
- Rust cross story proven (nocturned = 4-line cargo-package .mk). Persistent state → create dir in `bin/reset-settings`.
- Full hardware access: ALSA mics, evdev, backlight sysfs, ALS iio, BT via BlueZ/bluer, MFi ioctls, `/dev/misc` A/B.

### Path 4 — Whole new OS (months; greenfield)
Skip Nocturne. Mainline kernel now viable (Linux 6.18 patches in `alexcaoys/notes-superbird`; everything works except touch = vendor module carry-forever). Best base: `JoeyEamigh/yocto-superbird` (mainline kernel + mainline U-Boot, signed FIP, `flashthing-cli`). Or prototype-tier: stock firmware + ADB bind-mount webapp (`pajowu/superbird-custom-webapp`) — zero flash risk, host-tethered.

**What public source gets you** (details in [spotify-sources.md](spotify-sources.md)): Spotify's `spsgsb` GPL dump = kernel-common (rebuildable **tlsc6x touch** + PDM mic + backlight + panel drivers, superbird DTS) + U-Boot + the **leaked `superbird_production/aml-user-key.sig`** → sign a fully custom FIP (BL33+BL31; BL2 stays OTP-locked) that boots persistently. The Amlogic reference SDK (`reference/superbird-buildroot`) gives from-source recipes Nocturne skipped: Weston 6 + Mali r16p0 + **libgbm-from-blob** wiring, reproducible signed `.swu` construction (`ota_package_create.sh`: sha256-inject → `openssl dgst -sign` → double `cpio -H crc`), and the `res_packer`/`aml_encrypt_g12a` image+logo+FIP tools. Not public: stock userspace/app, MFi driver source.

## Quick-reference: reusable wire contracts

**Browser ↔ daemon (WS :5000):** `{type:"request"|"response"|"error"|"event", id, method/topic, params/result/data}` — broadcast to ALL clients, correlate by id client-side, no subscribe protocol. First message on connect should be `reset_boot_counter` (cancels A/B rollback).

**Daemon ↔ companion (BT):** MsgPack `call/result/error/event` in chunk envelopes (above). Handshake: daemon sends `daemon.ready` every 3s until companion replies `app.ready`; heartbeat 10s.

**Input (browser):** dial = `wheel.deltaX`; prefer `event.code` (`Digit1-4`, `KeyM`, `Escape`, `Enter`); long-press = userspace timer + ignore-next-release latch; keys polled 40ms.

## This machine's dev environment (macOS-specific)

- **USB SSH to device impossible from this Mac** — RNDIS gadget has no macOS driver. `just flash a`, `just copy`, live-reload flows in the repos assume Linux host.
- Working deploy loop here: build rootfs → **debugfs-inject changes into release zip** → flash via **Terbium** (WebUSB, works in Chrome on macOS).
- Alternatives worth setting up if iterating hard: Linux VM/box for RNDIS SSH; or UART FPC/pads for console.
- macOS connector app (Swift, IOBluetooth) reimplements the RPC surface — usable as local companion for Path 2 testing without a Pi.

## Traps

- Editing sibling checkouts does nothing to firmware builds — `.mk` files pin released tags; bump `_VERSION` + `just cleandeps`.
- `fastboot flashing unlock` = permanent brick.
- Missing `NOCTURNE_WEBAPPS_DIR` dir → daemon silently serves nothing, Chromium waits forever on :8080.
- Rotary dead without `ID_INPUT_MOUSE=1` udev tag.
- Backlight scale inverted (1=brightest, 255=darkest).
- OTA needs private key matching `/etc/nocturne.pem` — replace pem for own update channel.
- Two arecord processes can't share the mic — pause wake word before capture (ack handshake).
- MsgPack chunk format is a public wire contract across shipped iOS/Android/macOS apps.
