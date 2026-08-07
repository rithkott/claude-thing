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

> Phase 2 — rewrite `scripts/inject-firmware.js` for the flashthing zip.

## Phases

- [x] **1 — Scaffold.** Worktree `../claude-thing-nocturne-41` on `feat/nocturne-41` off `origin/dev`;
      `NOTES.md` + this ledger; `*.wic`/`*.ext4` gitignored; base image cached at
      `firmware/nocturne_image_v4.1.0.zip` (423 MB, gitignored via `*.zip`).
- [ ] **2 — `scripts/inject-firmware.js`.** Parse `meta.json`, extract `superbird.wic`, parse GPT,
      carve `root_a`/`root_b`, `debugfs` the payload into `/usr/lib/nocturne/webapps/ui/claude/` and
      graft `<script src="/claude/switch.js">` into that `index.html`; write the carved images back
      and repack. Same edit against the standalone `bandaid.ext4` member (belt and braces — the
      wic's own bandaid partition is overwritten at flash time). Drop `--nocturned`.
      Output `nocturne_v4.1.0_claude_<version>.zip`. See NOTES §3, §4.
- [ ] **3 — Emulator.** `emulator/src/firmware.js` onto the GPT-carve path + new UI dir; no
      `version.json` in 4.1 so the filename regex is the only version source;
      `deploy-dev.js:75-95` new path; `ws-server.js` must **forward** unknown methods rather than
      answer `"Unknown method"`, and `smoke-ws.js:33-36` asserts the old behaviour — invert it.
- [ ] **4 — Retire the nocturned patches.** Delete `patches/nocturned-claude-forward.patch` (4.1
      forwards natively, NOTES §2), `patches/nocturned-spp-reregister.patch` (deferred, NOTES §6),
      `scripts/build-nocturned.sh`, `scripts/nocturned.Dockerfile`. Retarget or drop
      `patches/nocturne-ui-claude-mode.patch`.
- [ ] **5 — Vendor the Mac app.** Copy `macos/` from `nocturne-connector@41f4d048…` to
      `mac/Nocturne/`; fold `patches/swift/ClaudeRelayService.swift` in as a normal file and write
      its call sites directly into `RPCManager.swift`, `NocturneApp.swift`, `SessionStore.swift`,
      `Views/Pages/SettingsView.swift`. Drop `CONNECTOR_REF`, the clone, and the ten anchored Python
      edits in `build-connector-dmg.sh:115-281`. Keep Apache-2.0 LICENSE + headers.
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
