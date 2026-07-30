# carthing-knowledge

Knowledge base for building new software on the Spotify Car Thing ("superbird") hardware, distilled from reading the [Nocturne](https://github.com/usenocturne/nocturne) sources and online research.

Not a code repo — reference docs only.

## Contents

- [hardware.md](hardware.md) — SoC, display, inputs, radios, boot/unlock, partition layout, quirks
- [firmware.md](firmware.md) — Nocturne Buildroot image: boot chain, runtime process tree, adding packages, read-only rootfs, OTA/swupdate
- [daemon.md](daemon.md) — nocturned architecture, WebSocket API on :5000, MsgPack RPC wire contract, iap2-rs
- [ui.md](ui.md) — kiosk UI patterns: input handling (dial/buttons/touch), Chrome 69 constraints, connector RPC surface
- [spotify-sources.md](spotify-sources.md) — what Spotify open-sourced (`spsgsb`: kernel/uboot/bluez/swupdate), the leaked FIP signing key, and the Amlogic reference build tooling (Weston+Mali, signed .swu, image/logo/FIP)
- [building-new-software.md](building-new-software.md) — synthesis: the practical paths to shipping your own app on this hardware

## Source material

- The usenocturne repos: `nocturne/`, `nocturne-ui/`, `nocturned/`, `iap2-rs/`, `nocturne-connector/`
- Thing Labs wiki, usenocturne GitHub org, superbird-tool
