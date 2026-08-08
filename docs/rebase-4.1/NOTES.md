# Nocturne 4.1 — upstream research record

Everything the 2.0.0 rebase rests on, with the command that proves each claim. **Read this instead
of re-deriving it.** Researched 2026-08-07 against `usenocturne/nocturne@v4.1.0`,
`usenocturne/nocturne-connector@v2.1.0` and `JoeyEamigh/yocto-superbird@main`.

Refs used throughout: `?ref=v4.1.0` on the nocturne monorepo, `?ref=v2.1.0` on the connector, and
`41f4d048912d3e9a7e664ad7b9a2526c323f2c55` — the last connector commit that still carried the macOS
Swift app.

---

## 1. What moved

`usenocturne/nocturned` and `usenocturne/nocturne-ui` are both **archived**
(`gh api repos/usenocturne/nocturned --jq .archived` → `true`). Their contents now live in the
`usenocturne/nocturne` monorepo:

```
crates/daemon      nocturned (package name unchanged, version 2.1.0)
crates/shared      libnocturne — protocol, gateway, generated bindings
crates/iap2        iap2-rs
crates/swupdate-sys  vendored libswupdate IPC client (self-contained C, no Yocto needed)
packages/ui        nocturne-ui, now TypeScript + MobX + react-router 7
image/             Yocto: kas + meta-nocturne, BSP JoeyEamigh/yocto-superbird
tools/codegen      wire-protocol codegen → crates/shared/generated/{rust,swift,…}
```

CPU changed: 4.0.7 was armv7; 4.1 is **aarch64** — `meta-superbird/conf/machine/superbird.conf`
requires `amlogic-s905d2.inc` → `arm/armv8a/tune-cortexa53.inc`. The monorepo's `Cross.toml` carries
both `armv7-unknown-linux-gnueabihf` and `aarch64-unknown-linux-gnu` targets.

---

## 2. FINDING — 4.1 forwards unknown WebSocket methods to the host by itself

**This is why 2.0.0 ships stock `nocturned`.**

`crates/daemon/src/http/websocket.rs`, end of `handle_incoming_message` (~:1597-1665). After a long
chain of `if method == "…" { …; return }` early-returns, anything left over is forwarded verbatim:

```rust
let Some(active_app) = self.app_ready_registry.read().await.active() else {
    self.send_error(id, "No active app session".to_string()).await;
    return Ok(());
};
…
let mut app_request = serde_json::json!({ "method": method, "params": params });
if let Some(route) = active_app.route { app_request["_targetConnection"] = serde_json::json!(route); }
let app_msg = AppMessage {
    id, protocol: "com.usenocturne.daemon".to_string(),
    session_id: 1, priority: AppMessagePriority::Normal,
    data: Bytes::from(serde_json::to_vec(&app_request)?),
};
```

There is **no allow-list and no closed enum** anywhere on this path:

- `crates/daemon/src/app/msgpack.rs:1563 outbound_app_message` builds
  `MsgPackMessage::Call { id, method, params }` from a free-form `String`.
- `MsgPackMessage` (`msgpack.rs:526-545`) is `{call|result|error|event}` with `method: String`.
- Replies route home **by id alone** — `msgpack.rs:~2101`,
  `if self.websocket_message_ids.contains(&id) { … ws_server.send_response(request_id, result) }`.
- Inbound events with arbitrary topics reach the UI via `broadcast_event_from_route`.

The typed/closed machinery (`crates/shared/src/protocol/{envelope,bridge}.rs`, magic `0xdead`,
version 2, `GatewayToNocturneMsgData`) exists but is **not used by the daemon** — it is the
gateway/OTA wire. `tools/codegen` runs at build time only and never gates a method name at runtime.

### The one gate: `app.ready`

`AppReadyRegistry::register` (`websocket.rs:322-339`) accepts **any** `app.ready` payload and marks
that route active. No fields are required. But note two 4.1 behaviours:

```rust
if topic == "app.ready" { self.app_ready_registry.write().await.register(route, source_peer, data); }
else if let Some(route) = route {
    let registry = self.app_ready_registry.read().await;
    if registry.active_route.is_some() && !registry.is_active(route) {
        debug!(route, %topic, "Ignoring event from inactive app connection"); return;
    }
}
```

- Only **one** companion route is active at a time, and the newest `app.ready` wins.
- Events from a non-active route are **dropped**.

> **Operational consequence:** an iPhone companion connecting after the Mac steals the active route
> and silences `claude.*`. Check this first if the device goes quiet on hardware.

Proof commands:
```sh
gh api "repos/usenocturne/nocturne/contents/crates/daemon/src/http/websocket.rs?ref=v4.1.0" \
  --jq '.content' | base64 -d | sed -n '1590,1670p;315,345p'
gh api "repos/usenocturne/nocturne/contents/crates/daemon/src/app/msgpack.rs?ref=v4.1.0" \
  --jq '.content' | base64 -d | sed -n '1560,1590p;524,546p'
```

### Corollary — the UI-facing surface is unchanged

- WebSocket still on **port 5000** (`crates/daemon/src/main.rs:66,77`), no path.
- Envelope identical to 4.0.7 (`websocket.rs:24-45`): `#[serde(tag = "type")]` over
  `request{id,method,params}` / `response{id,result}` / `error{id,error}` /
  `event{topic,data,server_timestamp_ms}`.
- Static webapp server still `ServeDir` + root-index SPA fallback on **127.0.0.1:8080**
  (`crates/daemon/src/http/webapp.rs`), kiosk still points at `http://127.0.0.1:8080/`
  (`nocturne.conf`: `CHROMIUM_KIOSK_URL`).

So **`device-app/` and `daemon/` need no protocol changes.** `device-app`'s `base: './'` + hash
routing is exactly what survives at `/claude/` — `ServeDir` serves `claude/index.html` for `/claude/`
when the directory exists, and only falls back to the root index when it does not.

---

## 3. FINDING — where the app must be injected, and why bandaid alone is not enough

Webapp root moved `/etc/nocturne/ui` → `/opt/nocturne/webapps/ui`. `/etc/nocturne/ui` no longer
exists anywhere in 4.1.

The chain, and the trap:

1. `image/meta-nocturne/recipes-core/nocturne-ui/nocturne-ui_4.1.0.bb` installs the UI to
   `WEBAPP_DIR = ${nonarch_libdir}/nocturne/webapps/ui` = **`/usr/lib/nocturne/webapps/ui`**, with
   `RDEPENDS:${PN} = "opt-overlay"`.
   `nocturned_2.1.0.bb` installs the daemon to `/usr/lib/nocturne/daemon/nocturned.current`.
2. `yocto-superbird` `meta-superbird/recipes-core/opt-overlay/files/opt-overlay-bind` binds
   `/var/lib/bandaid/nocturne` → `/opt/nocturne`, seeding from `/usr/lib/nocturne` **only if the
   vendor dir is missing**:
   ```sh
   BANDAID=/var/lib/bandaid/${VENDOR}; FACTORY=/usr/lib/${VENDOR}; TARGET=/opt/${VENDOR}
   if [ ! -d "$BANDAID" ]; then … cp -a "${FACTORY}/." "${BANDAID}/"; fi
   mount --bind "$BANDAID" "$TARGET"
   ```
3. `image/meta-nocturne/recipes-core/nocturne-floor-sync/files/nocturne-floor-sync` runs **every
   boot** and, when the rootfs floor version outranks bandaid's, copies the rootfs floor over
   bandaid — `cp -a "$UI_SRC" "$UI_NEXT"` then `mv` into place, and swaps `nocturned.current`:
   ```sh
   ROOTFS_VERSION=$(cat /etc/nocturne/floor-version)
   BANDAID_VERSION_FILE=/var/lib/bandaid/nocturne/.floor-version   # absent on a fresh flash
   … if rootfs_is_newer "$ROOTFS_VERSION" "$BANDAID_VERSION"; then  # installed=="" → exit 0 → newer
   ```
4. `bandaid-image.bbclass` (yocto-superbird) writes **no `.floor-version`** — it only rebases each
   package's `/usr/lib/${VENDOR}/` payload to `/${VENDOR}/` inside a 192 MiB `mkfs.ext4 -O ^has_journal`.

> **Therefore: on the first boot after any flash, bandaid is always overwritten from the rootfs
> floor.** Anything injected only into `bandaid.ext4` is wiped before the user sees it. The primary
> injection target is the **rootfs floor inside `superbird.wic`**: `/usr/lib/nocturne/webapps/ui/`.
> Inject `bandaid.ext4` too, but only as belt and braces.

Also note `crates/daemon/src/ota/webapp_swap.rs` hardcodes `ui` / `ui.previous` / `ui.next` — there
is no second-webapp registry in 4.1, so Claude Mode ships as a `claude/` subdirectory of the `ui`
bundle, exactly as it did on 4.0.7.

---

## 4. Firmware image layout

4.1 release zip is a **flashthing** zip, totally unlike 4.0.7's flat ext2 slots.

| `nocturne_image_v4.1.0.zip` (423 MB) | uncompressed |
|---|---|
| `superbird-boot.bin` | 2,097,152 |
| `superbird.wic` | 1,430,275,072 |
| `bandaid.ext4` | 201,326,592 |
| `meta.json` | 963 |

vs `nocturne_image_v4.0.7.zip`: `system_a.ext2`, `system_b.ext2` (541,110,272 each), plus
`boot_*/fip_*/dtbo_*/vbmeta_*/misc/bootloader/logo/env` dumps.

`meta.json` (`metadataVersion: 2`, no checksums anywhere — a repacked zip still flashes):

```json
{"steps":[{"type":"bulkcmd","value":"amlmmc key"},
 {"type":"writeBootPartition","value":{"hwpart":1,"data":{"filePath":"superbird-boot.bin"}}},
 {"type":"writeBootPartition","value":{"hwpart":2,"data":{"filePath":"superbird-boot.bin"}}},
 {"type":"writeUserArea","value":{"lba":0,"data":{"filePath":"superbird.wic"},"sparse":true}},
 {"type":"writeUserArea","value":{"lba":2400256,"data":{"filePath":"bandaid.ext4"}}}]}
```

GPT geometry — `image/meta-nocturne/files/wic/nocturne-mainline.wks.in` +
`yocto-superbird/meta-superbird/conf/distro/superbird.conf`:

| partition | size |
|---|---|
| `env` | 8 MiB |
| `boot_a` | 64 MiB |
| `root_a` | 516 MiB |
| `boot_b` | 64 MiB |
| `root_b` | 516 MiB |
| `bandaid` | 192 MiB |

1360 MiB total, matching `superbird.wic` exactly. `bootloader --ptable gpt`. `data` is carved at
first boot, not present in the image.

**The wic also contains a bandaid partition, but `meta.json` overwrites it with the standalone
`bandaid.ext4` member at LBA 2400256** — injecting into the wic's copy would be discarded.

### Is the rootfs writable/injectable?

Yes.
- Prod rootfs is **ext4** — `nocturne-prod-image.bb`: *"ext4 ro rootfs with chromium kiosk"*;
  `EXTRA_IMAGECMD:ext4 = "-i 16384 -m 0 -O ^has_journal -O ^huge_file"`. (The dev image is
  squashfs-lz4; `SUPERBIRD_WKS_ROOTFS_FSTYPE` picks squashfs only when it is in `IMAGE_FSTYPES`.)
- "Read-only" means mounted `ro` via `root=PARTLABEL=root_X`, **not** dm-verity — zero `verity` hits
  in either repo, and 4.0.7's `vbmeta_*.dump` members are gone from the 4.1 zip.
- SWUpdate signing is real (`NOCTURNE_SWUPDATE_SIGNING_MODE ?= "production"`) but applies to `.swu`
  OTA containers at update time, **not** to the flashed image at boot.

Caveat: the ext4 is size-asserted to exactly the slot (`nocturne_assert_prod_ext4_size`) with `-m 0`
and `IMAGE_OVERHEAD_FACTOR = "1.0"`. Free space is whatever the content leaves. The payload is only
~588 KB, but the injector's free-space check must run against the carved image and fail loudly.

### Reading the zip cheaply

The central directory can be listed without downloading 423 MB, via an HTTP range request on the
last ~200 KB of the release asset. See git history of this file / the injector tests for the recipe.

---

## 5. The macOS connector

**The app source was removed from the open-source repo.** The repo itself is still open; the app is
not in it.

- `macos/` 404s at `main` and at tag `v2.1.0`; it resolves only at `41f4d048…`.
- Commit `ae0fb209` ("feat: protocol v2 changes", 2026-07-29) removed **113 `macos/` files**.
- **0** Swift/Xcode paths on all five branches (`main`, `legacy`, `void`, `v1-alpine`,
  `alpine-initrd`); the whole default branch is 155 files.
- No `.gitmodules`; neither `build.sh` nor `Justfile` fetches a macOS app at build time.
- Global code search for its own class names (`MacOSRFCOMMServer`, `SerialProbeListener`,
  `com.usenocturne.connector.mac`) returns **0**. All four active forks synced past the removal.

```sh
gh api "repos/usenocturne/nocturne-connector/git/trees/main?recursive=1" --jq '.tree[].path' \
  | grep -icE "macos|\.swift|xcodeproj"        # → 0
gh api repos/usenocturne/nocturne-connector/commits/ae0fb209 \
  --jq '[.files[]|select(.filename|startswith("macos/"))]|length'   # → 113
```

The shipped `Nocturne_1.0-276.dmg` (v2.1.0 asset, 11.6 MB) is `com.usenocturne.nocturne`,
`CFBundleVersion 44`, `LSUIElement`, macOS 15+, universal Swift/SwiftUI, signed
`Developer ID Application: Neel Patel (A8CCNQDH4A)`, empty entitlements. **No XPC service, no local
HTTP/WS server, no URL scheme, no config plist** — nothing to inject a relay into.

### But the protocol is unchanged, and the Pi connector is the open reference

The DMG is provably the same codebase renamed with a `MacOS` prefix — `strings` recovers
`MacOSRFCOMMServer`, `MacOSRPCClient`, `MacOSSerialProbeListener`, and verbatim log strings that
match the pinned Swift sources (`"Invalid base64 line ("`, `"0100 - ServiceName*"`,
`"SDP publish unavailable on this macOS. Falling back to channel-open listener (no SDP record)."`).
It contains **zero** `iap2` strings — macOS takes the SPP path, no MFi needed.

4.1's daemon still implements exactly that path:

- `crates/daemon/src/bluetooth/mod.rs:1549 register_spp_profile` — UUID
  `00001101-0000-1000-8000-00805f9b34fb`, `role: Server`, `channel: Some(2)`,
  `require_authentication: Some(true)`.
- `MACOS_CONNECTOR_PROBE_CHANNEL = 3` (:2536), 4 s timeout / 750 ms hold — matches the pinned
  `SerialProbeListener.probeChannel = 3`.
- `run_spp_msgpack_handler` (:1682) still splits on `\n`, base64-decodes each line, and hands the
  result to `MsgPackProtocolHandler`; `CHUNK_SIZE = 2000`; greets with `daemon.ready`.
- Chunk framing unchanged: `[1B idLen][id][2B BE index][2B BE total][4B BE CRC32][2B BE len][payload]`,
  CRC32 reflected `0xEDB88320` — `Chunking.swift` says it is a port of `src/server/rpc/chunking.ts`,
  and **that file is unchanged between our pin and v2.1.0**.

New in 4.1: SPP is refused from **unpaired** peers unless an Android wake grant is armed
(`bluetooth/mod.rs:1596`). Likeliest first-hardware-test failure.

### The port surface

Only **4 commits** separate `41f4d048…` from `v2.1.0`, and only two carry substance:

```
ae0fb209 2026-07-29  feat: protocol v2 changes
91e2a2cb 2026-08-02  chore: update readme
fee71026 2026-08-04  fix: device info displays properly
1beea08d 2026-08-05  chore: bump to v2.1.0
```

Changed server files (`gh api repos/usenocturne/nocturne-connector/compare/41f4d048912d3e9a7e664ad7b9a2526c323f2c55...v2.1.0`):

| file | delta | Swift counterpart |
|---|---|---|
| `src/server/rpc/rpc-client.ts` | +138/-47 | `RPC/RPCClient.swift` |
| `src/server/nocturne-manager.ts` | +477/-9 | `Services/RPCManager.swift` |
| `src/server/services/car-thing-ota-service.ts` | NEW +490 | `Services/OTAService.swift` |
| `src/server/services/ota-transfer.ts` | NEW +12 | `Services/OTAService.swift` |
| `src/server/services/bluetooth-service.ts` | +234/-40 | `Services/BluetoothService.swift` |
| `src/server/bluetooth/rfcomm-client.ts` | +50/-21 | `Services/BluetoothService.swift` |
| `src/server/services/auth-service.ts` | +250/-70 | `Services/AuthService.swift` |
| `src/server/utils/resilient-auth-fetch.ts` | NEW +56 | `Services/AuthService.swift` |
| `src/server/services/spotify-commands.ts` | +22/-8 | `Services/SpotifyService.swift` |
| `src/server/bluetooth/rfcomm-server.ts` | +11/-1 | N/A — partial-write loop on a POSIX fd |
| `src/server/config.ts` | +2/-1 | N/A — `NOCTURNE_OTA_SERVER_URL` env override |
| `src/server/rpc/{chunking,protocol}.ts` | **unchanged** | verify only |

`crates/shared/generated/swift/*.swift` in the nocturne monorepo are public generated `Codable`
payload structs — use them instead of hand-writing types. (`iap2.swift` is a stub: daemon-internal.)

### 5a. Port worklist — REQUIRED

| # | Swift file | Edit |
|---|---|---|
| **R1** | `RPC/RPCClient.swift` | Add a two-tier (`normal`/`bulk`) send lock. The pinned Swift has **no lock at all** and sleeps 5 ms between chunks (`:149-160`); `@MainActor` does not help because every `await Task.sleep` is a suspension point, so a `ping`, a `media.nowPlaying.update` and a large OTA reply interleave their base64 lines on one channel. TS classifies bulk as `ota.chunk`, `system.ota.chunk`, `ota.asset_range_chunk`, `system.ota.asset_range_chunk`, and responses to `device.ota.transfer`/`ota.transfer`; bulk yields the lock **per chunk** so a normal reply can cut in. Drop the 5 ms sleep on the normal path; reject waiters on `cleanup()`. |
| **R2** | `RPC/RPCClient.swift` | Take the same lock in `retransmitChunk` (today it writes unlocked and can splice a chunk into another message's stream), and add the 2-minute retention TTL (`RETAINED_MESSAGE_TTL_MS`). Swift already caps at 32, matching `MAX_RETAINED_MESSAGES`. Driven by `RPCManager.swift:266 case "chunk.retransmit_request"`, which 4.1 still emits. |
| **R3** | `Services/Spotify/SpotifyCommandRegistry.swift`, `Services/RPCManager.swift:416` | Accept **both** spellings for the six camelCase Spotify commands (see 5b). Defensive, not currently breaking. |
| **R4** | `Services/RPCManager.swift:285` | **Constraint, not an edit: keep `platform: "web"`.** See 5b. |
| **R5** | `Services/RPCManager.swift:94-113` | `guard channel.isOpen() else { return }` silently truncates a message on a closed channel; TS now throws (`"Write attempted on closed connection"`). Surface the error so `RPCClient` fails the pending call instead of waiting out the 30 s timeout. |

Not required: the TS partial-write loops added to `rfcomm-{client,server}.ts` — Swift's `onWrite`
already loops to `channel.getMTU()`. Only its error handling (R5) needs touching.

### 5b. Method names — no renames required, and one thing that must NOT change

4.1 canonicalises to snake_case **except for web companions**, and the Swift app declares itself as
one. `crates/daemon/src/http/websocket.rs:127-160`:

```rust
fn companion_music_request(method: &str, params: serde_json::Value, platform: Option<&str>) -> … {
    let Some((canonical_method, mut params)) = canonical_music_request(method, params)? else { … };
    if platform != Some("web") { return Ok(Some((canonical_method, params))); }
    let method = match canonical_method.as_str() {
        "spotify.artist.top_tracks"  => "spotify.artist.topTracks",
        "spotify.auth.get_status"    => "spotify.auth.getStatus",
        "spotify.me.recently_played" => "spotify.me.recentlyPlayed",
        "spotify.me.top_artists"     => "spotify.me.topArtists",
        "spotify.me.top_tracks"      => "spotify.me.topTracks",
        "spotify.radio.top_mix"      => "spotify.radio.topMix",
        _ => canonical_method.as_str(), };
```

fed by `websocket.rs:1602` reading `active_app.data.get("platform")`.

> **Do not change `RPCManager.swift:285 (.string("platform"), .string("web"))` to `"macos"`/`"darwin"`.**
> That one edit flips the daemon to canonical snake_case and breaks all six Spotify commands the
> Swift registry declares in camelCase.

Outbound Swift topics are accepted either way — `msgpack.rs:453/472/492` match both
`media.nowPlaying.*` and `media.now_playing.*`. `device.launchApp` and `device.factoryreset` are
device-side methods the Swift app never sends (`grep` over the pinned tree: no occurrences).

Alias map to add anyway (accept both, prefer canonical), mirroring `normalizeSpotifyCommand`:
`spotify.artist.topTracks`, `spotify.me.topArtists`, `spotify.me.topTracks`,
`spotify.me.recentlyPlayed`, `spotify.radio.topMix` (`SpotifyCommandRegistry.swift:51,60,61,62,66`)
and `spotify.auth.getStatus` (`RPCManager.swift:416`, hard-coded `case`).

### 5c. `app.ready` carries no negotiation fields

`sendAppReady()` is byte-for-byte unchanged in the v2 diff:

```ts
await this.broadcastToDevices("app.ready", { platform: "web", timestamp: Date.now(),
  spotifySkipped: false, datetime, time, timezone: { identifier, secondsFromGMT, … } });
```

4.1 requires none of it — `crates/shared/generated/rust/device.rs:13 AppReadyEvent` is all
`Option<…>`, and `msgpack.rs:188 normalize_app_ready_event` accepts snake *or* camel for every
field. `app.ready` matters only because it registers the route.

The transfer-negotiation fields live on **`ota.package_ready`**, not `app.ready`:

```ts
{ updateId, version, size, expectedSha256, resumeFromOffset,
  maxTransferChunkSize: MAX_OTA_TRANSFER_WINDOW_BYTES,
  supportsChunkedTransferResponse: true, transferDataEncoding: "msgpack_binary" }
```

consumed at `msgpack.rs:598-639` — omit them and you get `OTA_LEGACY_PULL_SIZE = 1800` byte windows
instead of `OTA_MAX_PULL_WINDOW_SIZE = 256 * 1024`, i.e. ~71× slower OTA. Not required; the pinned
Swift's legacy `device.ota.package_state` topic is still accepted (`msgpack.rs:1408`).

### 5d. The "binary frame" is Mac-app-private — do not chase it

The shipped DMG contains `"Failed to decode binary frame: "` and `"Binary frame header fields must
not exceed 255 bytes each."`. **Neither string exists anywhere in `nocturne-connector@v2.1.0` or
`nocturne@v4.1.0`** (0 hits case-insensitive over both trees; GitHub code search `user:usenocturne`
returns `total_count: 0`). It is code written after the pin, in the now-private Mac app.

The only framing 4.1's SPP path understands is the documented one —
`msgpack.rs:1519` `[1B id_len][id][2B index BE][2B total BE][4B crc32 BE][2B len BE][payload]`,
with the parser enforcing `id_len == 36`, UUID hyphens at 8/13/18/23, and
`total == 0 || index >= total || total > 1000 → Invalid`. Identical to `chunking.ts` and
`RPC/Chunking.swift:49`.

OTA bytes ride inside an ordinary `result` envelope and 4.1 accepts **either** encoding
(`msgpack.rs:740-748`: *"Transfer data must be base64 string or byte array"*), so the pinned
`OTAService.readChunk` → `base64EncodedString()` is still valid. Port `ota.package_ready` instead.

### 5e. Pairing gate — no change required

Daemon (`bluetooth/mod.rs:1580-1601`) rejects SPP unless `is_paired()` or an armed Android wake
grant. The Swift app only dials channel 2 **after** macOS reports the peer paired — `BluetoothService.swift:194,240,270,311,355,408` all guard on `device.isPaired()`, with a 30×1 s bond wait — so the
daemon always sees `paired == true`. `SerialProbeListener.probeChannel = 3` matches
`MACOS_CONNECTOR_PROBE_CHANNEL = 3`. Android wake grants are never armed for Macs.

### 5f. Feature-tier port items (optional for a first 2.0.0)

`CarThingOTAService.swift` + `OTATransfer.swift` (new) for the v2 manifest OTA — `GET
{OTA}/v2/manifest?channel&from&image_from&bandaid_from`, streamed SHA-256 + size verification,
`active.json` resume, HTTP-Range `fetchAssetRange` requiring `206` with an exact `Content-Range`;
`RPCManager` handlers for `ota.request_check`, `ota.request_install`, `ota.asset_range`,
`ota.asset_range_abandon`, `ota.complete`, `ota.error` and emitters `ota.check_result`,
`ota.package_ready`, `ota.begin`, `ota.download_progress`, `ota.abandon`, `ota.asset_range_reply`,
`ota.asset_range_chunk`, `ota.asset_range_rejected`; `Models/DeviceModels.swift` gains
`imageVersion`/`bandaidVersion` (`parseDeviceInfo` reads only
`device/version/fullVersion/buildDate/gitHash/serialNumber` today).
Auth: port the status-first classification and the `RETRYABLE_AUTH_STATUSES = {408, 425, 429}` + 5xx
remap — Swift's `AuthService` currently signs the user out on any 400/401/403 whose message merely
contains `"invalid"`. Bluetooth: the explicit `[1s, 2s, 4s, 8s, 16s, 30s]` reconnect ladder.
`Utilities/Configuration.swift`: env-overridable OTA URL. `OTAService.readChunk`: window-size guard.

---

## 6. Deferred work

- **SPP re-registration supervisor.** The 1.23.5 hotfix is still absent upstream:
  `crates/daemon/src/bluetooth/mod.rs:1549` registers each profile once with no supervisor, no
  backoff, and no bluetoothd-restart watcher. 4.1 only improved the *startup* race
  (`wait_for_ready_bluetooth`, capped backoff). Re-porting means owning an aarch64 cross-build of
  `nocturned` and swapping the binary in `/usr/lib/nocturne/daemon/nocturned.current`, which 2.0.0
  deliberately avoids. Ship it as its own later release if the failure reappears on 4.1.
- **`patches/nocturne-ui-claude-mode.patch`** targeted `src/components/settings/Settings.jsx`; the
  4.1 UI is TypeScript + MobX (`packages/ui/src/App.tsx`), so the patch needs retargeting or
  dropping. It was always optional polish — the preset-1+4 chord in `device-app/public/switch.js`
  is the real mechanism.
