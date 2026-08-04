# Releases

Claimed versions. One row per merge to `main`. See CLAUDE.md → Release process.

Versioning is semver-shaped: **major** only when explicitly asked for, **minor** for a feature addition, **patch** for a bug fix or docs.

A row ships to the **dev** channel as `X.Y.Z-dev` the moment its PR merges. It becomes production `X.Y.Z` only when the `promote` workflow is run, so rows below the newest promoted version may exist as dev prereleases and nothing else.

**The two branches carry different copies of this file, on purpose.** `dev` has the full ledger; `main` has production history only, and a promote brings the rows in between over along with the code they describe. `git diff main dev -- RELEASES.md` reads out the difference, which is exactly the set of unpromoted versions. Keep it that way: `release-meta.mjs` releases the highest row it can see, so a row for unshipped work sitting on `main` would number a hotfix against a version production has never run.

A hotfix therefore numbers itself against production, not against `dev` — which is why 1.17.3 sits below versions that were released before it. Its change reaches `dev` under its own number too, so one fix can hold two rows: 1.17.3 is what production shipped, 1.23.1 is what dev shipped.

| Version | Date | Type | Branch | Summary |
|---------|------|------|--------|---------|
| 1.0.0 | 2026-07-30 | initial | initial | Car Thing as a Claude Code monitor |
| 1.1.0 | 2026-07-30 | feature | device-reach-mac | The device can actually reach the Mac |
| 1.2.0 | 2026-07-31 | feature | readability-redesign | Readability redesign |
| 1.2.1 | 2026-07-31 | fix | ask-option-clipping | Question options fit the screen; dial scrolling visibly works |
| 1.2.2 | 2026-07-31 | fix | session-wipe-hysteresis | Session tiles no longer vanish/reappear on one bad registry poll |
| 1.2.3 | 2026-07-31 | fix | clock-timezone | Device clock shows Mac-local time instead of UTC |
| 1.3.0 | 2026-07-31 | feature | emulator-fidelity | Emulator matches real hardware: true-scale dial, CPU/RAM caps, chrome69 code path, 40ms key polling, device fonts |
| 1.4.0 | 2026-07-31 | feature | plan-approval-bridge | Plan approvals surface on the device as questions; hook allow never worked for ExitPlanMode |
| 1.5.0 | 2026-07-31 | feature | release-assets | Every release ships the DMG and firmware zip as assets |
| 1.5.1 | 2026-07-31 | fix | dial-accuracy | Dial matches real Car Thing photos: plain 36mm disc upper-right, overhangs face edge |
| 1.6.0 | 2026-07-31 | feature | list-peek | Sessions grid drops the scrollbar; the next column peeks past the bezel instead |
| 1.6.1 | 2026-07-31 | fix | device-clock | Device wall clock and every duration run on Mac time, not the device's unset epoch |
| 1.6.2 | 2026-07-31 | fix | bool-counts | Session counts of 0/1 render as numbers again; the connector packs them as booleans |
| 1.7.0 | 2026-07-31 | feature | tile-mode | Each session tile shows its window's permission mode: PLAN / BYPASS / AUTO / EDITS / MANUAL |
| 1.8.0 | 2026-07-31 | feature | touch-scroll | Every screen the dial scrolls now scrolls by finger too: drag becomes dial ticks, taps still land |
| 1.8.1 | 2026-07-31 | fix | session-dupes | One conversation is one tile: a window parked on a background job stops showing as a second session |
| 1.9.0 | 2026-07-31 | feature | dancing-claude | A dancing Claude mascot roams the clock screen on a ~50 second routine |
| 1.9.1 | 2026-07-31 | fix | usage-state-flap | Usage screen stops flipping between a real figure and a stale lower one, and survives a daemon restart |
| 1.10.0 | 2026-07-31 | feature | bt-menu-claude-mode | Bluetooth management without leaving Claude mode: hold the settings key for pairing, paired devices, and per-device actions |
| 1.10.1 | 2026-07-31 | fix | session-order | Session list stops reshuffling: a working session only moves past idle ones, never past another working one |
| 1.10.2 | 2026-08-01 | fix | perf-event-flood | Device stops freezing under many sessions: daemon event flood debounced at the source, device repaints only when the screen actually changes |
| 1.10.3 | 2026-08-01 | fix | duplicate-question-alert | One alert per question: a multiple-choice ask stops also raising a permission card with a raw JSON body |
| 1.10.4 | 2026-08-01 | fix | relay-coalesce | Bluetooth relay coalesces state frames, offscreen tiles stop animating, faceplate stops double-parsing broadcasts |
| 1.10.5 | 2026-08-01 | fix | relay-default | Claude Code relay toggle is on by default in a fresh DMG install |
| 1.11.0 | 2026-08-01 | feature | hw-frontend | Mode chips take Claude Code's colours, questions answered inside the queue hero, working mascot runs at the session's effort level |
| 1.12.0 | 2026-08-01 | feature | option-expand | The queue option under the cursor expands, label over description, both wrapped in full |
| 1.12.1 | 2026-08-01 | fix | parked-window-focus | Answering a backgrounded job from the device raises the window parked on it instead of reporting no window |
| 1.12.2 | 2026-08-01 | fix | expired-answer | A timed-out question still raises its terminal when answered from the device, and every failed answer says why on the Mac |
| 1.12.3 | 2026-08-01 | fix | orphan-jobs | A background job whose terminal window is gone leaves the grid once it goes idle, instead of sitting there until killed by hand |
| 1.13.0 | 2026-08-01 | feature | type-parked | A backgrounded job's question is answered from the device outright — the keypress is typed into the window parked on it |
| 1.13.1 | 2026-08-01 | fix | nul-byte | A stray NUL byte in the session poller is gone, so the file diffs, blames and greps as text again |
| 1.13.2 | 2026-08-01 | fix | queue-sync | Stale asks disappear: the daemon pushes its waiting list on every client hello and the device drops cards it no longer vouches for |
| 1.14.0 | 2026-08-01 | feature | tile-model-meter | Each tile names its model; the context meter carries its own CONTEXT NN% label inside a taller track |
| 1.14.1 | 2026-08-01 | fix | meter-legibility | Context label stays readable at every fill: dark copy clipped inside the bar, light copy on the bare track |
| 1.15.0 | 2026-08-01 | feature | hw2-device-ui | The device drives itself: drift home + wake to queue, pulsing blocked edge, destructive two-press arming with 6s undo, intent line on every ask, desk-clock ambient, tile spec line with 56px mascot |
| 1.16.0 | 2026-08-02 | feature | mascot-toggle | Tap the clock screen to turn the wandering sprite off or back on; the choice survives reboots |
| 1.16.1 | 2026-08-02 | fix | readme-install | README rewritten as a step-by-step install guide for non-technical readers, with verification and troubleshooting |
| 1.16.2 | 2026-08-02 | fix | empty-fleet | The clock screen shows no session lamp when nothing is running, instead of one stray gray box |
| 1.16.3 | 2026-08-02 | fix | esc-clears-asks | Esc in the terminal now clears the device ask too — no more stuck question cards re-raising dead dialogs |
| 1.16.4 | 2026-08-02 | fix | no-drift | The device stops drifting back to the clock after 5s idle — the screen you leave it on stays put |
| 1.17.0 | 2026-08-02 | feature | multi-question | A multi-question AskUserQuestion is one card you walk, edit and submit — multiSelect answerable at last, and every tap on the device works again |
| 1.17.1 | 2026-08-02 | fix | answer-serialization | Answers given in quick succession are typed one at a time, so keystrokes can no longer interleave into the wrong session's terminal |
| 1.17.2 | 2026-08-02 | fix | semver-ledger | The ledger is semver end to end — every past release renumbered to match its tag, and the release process documents the bump rules |
| 1.17.3 | 2026-08-04 | fix | usage-limits-carryover | Hotfix, straight to production: a `/usage` run that prints no limit lines is a reading, not a parse failure, so the usage screen stops freezing on the last poll that parsed — the same change dev shipped as 1.23.1 |
| 1.17.4 | 2026-08-04 | fix | daemon-banner-stuck | Hotfix, straight to production: DAEMON OFFLINE clears itself — on hardware nothing but the boot handshake ever set the flag, so a connector that had not finished linking when the app started left the banner up for the whole session over a working link. Any daemon event now takes it back, and a retry keeps asking while it is up (#55) |
| 1.18.0 | 2026-08-03 | feature | dev-channel | Every merge auto-publishes an X.Y.Z-dev prerelease from CI; production is a separate promote step, so features reach dev without touching what users install |
| 1.18.1 | 2026-08-03 | fix | preview-question-keys | A question whose options carry previews is answerable from the device again — its dialog reads digits as cursor moves, so answers are walked with Down and taken with Return |
| 1.18.2 | 2026-08-03 | fix | dmg-asset-name | The release DMG is named Nocturne-claude-<connector version>.dmg again, so it is distinguishable from a stock Nocturne download on the release page |
| 1.18.3 | 2026-08-03 | fix | readme-debug | README gains a debug path: three ordered checks, where and how to grant the macOS Automation permissions (and why the dialog says a version number), and the prompts that keep a session answerable from the dial |
| 1.19.0 | 2026-08-03 | feature | answer-progress | Answering on the device shows the answer on its way — a ring drains over the undo window, then spins while the Mac types it, so the wait before it lands in the terminal no longer looks like nothing happened |
| 1.20.0 | 2026-08-03 | feature | queue-idle-exit | An empty queue hands the screen back to the session list after a minute, so the device never sits on a dead end — every other page stays put |
| 1.20.1 | 2026-08-03 | fix | boot-list-chunk-fit | Boot session list fits one Bluetooth chunk: device asks for 4, the daemon caps relay roles that forget and follows up with the full grid as an async push |
| 1.21.0 | 2026-08-03 | feature | session-watch | The device tells the daemon which session it is looking at, and only that detail stream crosses the link — unwatched sessions no longer repaint the grid |
| 1.22.0 | 2026-08-03 | feature | host-ask-flags-usage-slim | The daemon sends the device only what it draws: usage events slim to the rendered subset, and permissions arrive pre-classified destructive against the full command instead of the truncated summary |
| 1.22.1 | 2026-08-04 | fix | connector-int-bool-source | The Mac connector packs claude.* frames without coercing 0/1 to booleans, and an intProbe on every snapshot lets the device skip its per-frame repair walk on a clean link |
| 1.23.0 | 2026-08-04 | feature | dev-branch | Dev releases live on their own `dev` branch and main is the production branch — promoting fast-forwards main onto the promoted commit, so the default branch is always the tree users are running |
| 1.23.1 | 2026-08-04 | fix | usage-limits-carryover | A `/usage` run that prints no limit lines is a reading, not a parse failure: the last limits actually read carry across it, dated by when they were read, so the contributing breakdown keeps refreshing instead of the whole screen freezing on the last poll that parsed |
| 1.23.2 | 2026-08-04 | fix | connector-pin | The DMG build fetches the connector at the pinned commit that still carries the macOS app, so releases keep building after upstream force-pushed its default branch to a line without one |
| 1.23.3 | 2026-08-04 | fix | daemon-banner-stuck | DAEMON OFFLINE clears itself: on hardware nothing but the boot handshake ever set the flag, so a connector that had not finished linking when the app started left the banner up for the whole session over a working link — any daemon event now takes it back, and a retry keeps asking while it is up (#55) |
