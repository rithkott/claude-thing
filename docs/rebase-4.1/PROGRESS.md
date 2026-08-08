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

> Phase 6 — port v2.1.0 into the Swift app, starting with R1.

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
- [ ] **6 — Port v2.1.0 into the Swift app.** One commit per item; REQUIRED before FEATURE.
    - [ ] R1 `RPCClient.swift` — two-tier normal/bulk send lock, drop the 5 ms inter-chunk sleep
    - [ ] R2 `RPCClient.swift` — lock `retransmitChunk`, add the 2-minute retention TTL
    - [ ] R3 Spotify command alias map (accept camelCase **and** snake_case)
    - [ ] R5 `RPCManager.swift:94-113` — surface closed-channel write errors instead of truncating
    - [ ] F3 `ota.package_ready` negotiation (1800 B → 256 KiB transfer windows)
    - [ ] F4 `parseDeviceInfo` gains `imageVersion` / `bandaidVersion`
    - [ ] F1/F2 `CarThingOTAService.swift` + `OTATransfer.swift` (v2 manifest OTA)
    - [ ] F5/F6 auth: status-first classification, retryable 408/425/429/5xx
    - [ ] F7 Bluetooth reconnect backoff ladder
    - [ ] F8/F9 env-overridable OTA URL, `readChunk` window guard
    - **R4 is a constraint, not a task: do NOT change `platform: "web"`** (NOTES §5b)
- [ ] **7 — Release plumbing and docs.** `release.yml:32` → `v4.1.0`, drop the nocturned job and its
      cache keys; DMG job builds the vendored tree; `README.md:7-8,12,108`;
      `protocol/claude-protocol.md:245-248`; `carthing-knowledge/*`.
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
