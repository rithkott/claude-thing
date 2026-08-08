# 2.0.0 rebase onto Nocturne 4.1 — progress ledger

**Resume here.** This file is the single source of truth for what is done and what is next. Read it
and `NOTES.md` (the upstream research — never re-derive it) before touching anything.

```sh
cd ../claude-thing-nocturne-41            # the worktree; branch feat/nocturne-41
git log --oneline origin/dev..HEAD        # what has already landed
```

Every phase ends with the box ticked here plus `git commit -m "wip(4.1): <phase>" && git push`.
Stopping mid-phase is fine — commit as `wip(4.1): <phase> (partial — <what is left>)` and write the
remainder under **Next action** below. Never end a session with a dirty tree.

`RELEASES.md` is **not** touched until Phase 9. An unfinished feature must not reserve a version.

---

## Next action

> Phase 8 — verification.

## Worktree setup (needed once per fresh worktree)

`daemon/node_modules` is a tracked relative symlink, but `device-app` and `emulator` are not. Create
them the same way — **relative, never absolute**:

```sh
ln -s ../../claude-thing/device-app/node_modules device-app/node_modules
ln -s ../../claude-thing/emulator/node_modules   emulator/node_modules
```

## Phases

- [x] **1 — Scaffold.** Worktree `../claude-thing-nocturne-41` on `feat/nocturne-41` off `origin/dev`;
      `NOTES.md` + this ledger; `*.wic`/`*.ext4` gitignored; base image cached at
      `firmware/nocturne_image_v4.1.0.zip` (423 MB, gitignored via `*.zip`).
- [x] **2 — `scripts/inject-firmware.js`.** Rewritten for the flashthing zip: reads the real GPT out
      of `superbird.wic`, carves `root_a`/`root_b` by offset, drives `debugfs` against each carved
      ext4 writing `/usr/lib/nocturne/webapps/ui/claude/` and grafting
      `<script src="/claude/switch.js">` into that `index.html`, writes the images back at the same
      offsets, and repacks. Same edit against the standalone `bandaid.ext4` member. `--nocturned`
      dropped. **Verified** against the cached v4.1.0 zip: both slots carry `claude/` (14 assets +
      `index.html` + `switch.js`) with the graft present, bandaid too, and a region-by-region
      SHA-256 shows *only* `root_a`/`root_b` changed — GPT, `env`, `boot_a`, `boot_b` and the wic's
      bandaid region are byte-identical, wic size unchanged at 1,430,275,072.
- [x] **3 — Emulator.** `firmware.js` carves `root_a`/`root_b` out of `superbird.wic` by GPT
      offset, streaming (`unzip -p | tail -c | head -c`) so the 1.43 GB image never hits disk;
      cold extract ~22s. UI dir `/usr/lib/nocturne/webapps/ui`; version from the zip filename
      (minus its extension). `ws-server.js` forwards unknown methods to the registered app and
      answers `"No active app session"` when there is none — `"Unknown method"` now comes only
      from the phone sim; `smoke-ws.js` asserts both branches. **Extra, not in the original
      plan:** 4.1's UI dropped `vite-plugin-legacy`, so `EMU_FORCE_LEGACY` would have stripped
      the only entry script and served a blank page — `static-server.js` now applies the rewrite
      only to a bundle that carries a `nomodule` twin. Verified live on the emulator: stock 4.1
      UI and the grafted `/claude/` app both render, WS smoke green.
- [x] **4 — Retire the nocturned patches.** Deleted both `nocturned-*.patch`, `build-nocturned.sh`
      and `nocturned.Dockerfile`. `nocturne-ui-claude-mode.patch` retargeted onto
      `packages/ui/src/components/settings/Settings.tsx` (checked against v4.1.0: the item still
      belongs in `settingsStructure.general.items` before `factory-reset`, ~:119, and `handleAction`
      is still an untyped switch, ~:365). **Pulled forward from phase 7 because they referenced the
      deleted files:** `release.yml` lost the cross-compile job + `NOCTURNED_EPOCH` cache key,
      `NOCTURNE_IMAGE_TAG` → `v4.1.0`, `--nocturned` flag dropped; `protocol/claude-protocol.md`
      and `patches/swift-connector.md` now describe the forwarding registry.
- [x] **5 — Vendor the Mac app.** `mac/Nocturne/` is `macos/@41f4d048` verbatim + its Apache-2.0
      LICENSE; the eleven edits are tracked source and `ClaudeRelayService.swift` a normal file
      under `Services/` (the pbxproj needed no change — `objectVersion 77` file-system-synchronized
      root group). `build-connector-dmg.sh` lost `CONNECTOR_REF`/clone/patch step and absorbed
      upstream's `build-macos-dmg.sh`; it now clears xattrs off the in-repo source and refuses a
      tree with no `ClaudeRelayService.swift`. `release.yml` DMG cache key drops `patches/**`.
      **Extra:** `patches/swift-connector.md` (288 lines duplicating now-tracked source) became
      `mac/Nocturne/RELAY.md`, keeping only the rationale; `mac/Nocturne/README.md` records
      provenance and licensing. Verified: `xcodebuild` Release succeeds and the binary carries the
      relay (Nocturne 2.0.5).
- [x] **6 — Port v2.1.0 into the Swift app.** One commit per item, each building clean.
    - [x] R1 two-tier normal/bulk send lock; the lock is handed to the next waiter rather than
          unlocked, so bulk cannot starve normal. 5 ms sleep gone; `call()` now fails on send error
    - [x] R2 `retransmitChunk` takes the lock (so it is `async`; the `chunk.retransmit_request`
          handler hands it to a Task) and retained chunks expire at the 2-minute TTL
    - [x] R3 alias map, **inverted** vs upstream: we register camelCase and fold snake_case onto it
    - [x] R5 `onWrite` throws; `RPCManager`'s RFCOMM writer reports which failure mode and how far
          a partial write got
    - [x] F4 `imageVersion`/`bandaidVersion` on `CarThingInfo`; `parseDeviceInfo` reads both
          spellings of every multi-word field
    - [x] F8/F9 `NOCTURNE_OTA_SERVER_URL` override; `OTATransfer.requireWindow` bounds `readChunk`
    - [x] F1/F2 `CarThingOTAService.swift` + `OTATransfer.swift`
    - [x] F3 the full v2 OTA event surface in `RPCManager` + `ota.package_ready` negotiation
    - [x] F5/F6 status-first auth classification; 408/425/429/5xx never sign out
    - [x] F7 reconnect ladder 1/2/4/8/16/30 s on failures; the in-flight poll stays flat at 1 s
    - [x] R4 constraint held — `RPCManager.swift:623` still `platform: "web"`
    - **Reordered from the plan:** F4 and F8/F9 landed before F1/F2, and F3 after, because F3's
      handlers call `CarThingOTAService` and `OTATransfer.maxWindowBytes` — doing F3 first would
      have meant writing it against the legacy `.swu` path and then rewriting it.
    - **Correction to NOTES §5f:** the transfer window is **128 KiB**, not 256 KiB.
      `MAX_OTA_TRANSFER_WINDOW_BYTES` in `ota-transfer.ts` is `128 * 1024`; 256 KiB is the
      *device-side* `OTA_MAX_PULL_WINDOW_SIZE`. The connector advertises the tighter of the two.
- [x] **7 — Release plumbing and docs.** `release.yml` and `claude-protocol.md` were done in
      phase 4; this phase did `README.md` (4.1, daemon unmodified, new zip name/size, repo table)
      and `carthing-knowledge/*`. The knowledge base is **banner-marked, not rewritten**: its
      device-behaviour half (the :5000 envelope, MsgPack/SPP framing, input handling, hardware) is
      still correct, so each stale file states what 4.1 moved and points at `NOTES.md`.
      **Bug caught here:** the phase-5 rewrite of `build-connector-dmg.sh` had made Developer ID +
      notarization the no-argument default, which would have failed every CI release —
      `release.yml` invokes it bare on a runner with no certificate. `--local` is the default
      again; `--developer-id` opts in. DMG verified end to end (5.1 MB, mounts, adhoc-signed
      universal app carrying the relay and the OTA service).
- [ ] **8 — Verification.** Injector round-trip; emulator + CDP screenshots; `scripts/test-all.sh`;
      updated `smoke-ws.js`; then hardware — DMG installed, real Car Thing flashed with the injected
      zip, `bridge.status` reporting `bt.connected` and a live `claude.sessions.update`.
- [ ] **9 — Claim, clean, ship.** Rebase on `origin/dev`, append the `2.0.0` row to `RELEASES.md`,
      `release: claim 2.0.0 — nocturne-41`, `gh pr create --fill --base dev`, squash-merge, watch
      `release.yml`, refresh the GitNexus index, remove the worktree. Decide whether
      `docs/rebase-4.1/` stays.

## Surprises log

Anything that contradicted the plan, so a later session does not re-learn it.

- 4.1 forwards unknown WebSocket methods to the host with no allow-list, so the `claude.*`
  forwarding patch and the entire aarch64 cross-build are unnecessary. (NOTES §2)
- Injecting only into `bandaid.ext4` would be wiped on first boot by `nocturne-floor-sync`; the
  rootfs floor inside `superbird.wic` is the real target. (NOTES §3)
- The macOS app source was removed from `nocturne-connector` at `ae0fb209`; the repo is still open,
  the app is not in it. The open Pi connector is the reference for the port. (NOTES §5)
- No snake_case renames are needed: the app declares `platform: "web"` and 4.1 deliberately
  down-converts for web companions. Changing that string would break six Spotify commands. (§5b)
- The DMG's "binary frame" strings exist in no public source — Mac-app-private, do not chase. (§5d)
- The 4.1 prod rootfs has only **17.2 MiB free** (`Free blocks: 4403 × 4096`). The device app is
  543 KB so it fits, but there is no room for a second large payload — this is why swapping a 17 MB
  `nocturned` into the rootfs floor would have been tight even if we still wanted to.
- The bandaid tree is owned **1000:1000**, the rootfs floor **0:0**. The injector mirrors whichever
  the existing `ui` directory uses rather than assuming root.
- Bash tool commands run under **zsh**: unquoted `$var` does not word-split, so `set -- $pair`
  yields one argument. Bit me while writing a verification loop; use explicit arguments.
