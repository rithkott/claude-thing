# Releases

Claimed release numbers. One row per merge to `main`. See CLAUDE.md → Release process.

| Release | Date | Branch | Summary |
|---------|------|--------|---------|
| r1 | 2026-07-31 | ask-option-clipping | Question options fit the screen; dial scrolling visibly works |
| r2 | 2026-07-31 | session-wipe-hysteresis | Session tiles no longer vanish/reappear on one bad registry poll |
| r3 | 2026-07-31 | clock-timezone | Device clock shows Mac-local time instead of UTC |
| r4 | 2026-07-31 | emulator-fidelity | Emulator matches real hardware: true-scale dial, CPU/RAM caps, chrome69 code path, 40ms key polling, device fonts |
| r5 | 2026-07-31 | plan-approval-bridge | Plan approvals surface on the device as questions; hook allow never worked for ExitPlanMode |
| r6 | 2026-07-31 | release-assets | Every release ships the DMG and firmware zip as assets |
| r7 | 2026-07-31 | dial-accuracy | Dial matches real Car Thing photos: plain 36mm disc upper-right, overhangs face edge |
| r8 | 2026-07-31 | list-peek | Sessions grid drops the scrollbar; the next column peeks past the bezel instead |
| r9 | 2026-07-31 | device-clock | Device wall clock and every duration run on Mac time, not the device's unset epoch |
| r10 | 2026-07-31 | bool-counts | Session counts of 0/1 render as numbers again; the connector packs them as booleans |
| r11 | 2026-07-31 | tile-mode | Each session tile shows its window's permission mode: PLAN / BYPASS / AUTO / EDITS / MANUAL |
| r12 | 2026-07-31 | touch-scroll | Every screen the dial scrolls now scrolls by finger too: drag becomes dial ticks, taps still land |
| r13 | 2026-07-31 | session-dupes | One conversation is one tile: a window parked on a background job stops showing as a second session |
| r14 | 2026-07-31 | dancing-claude | A dancing Claude mascot roams the clock screen on a ~50 second routine |
| r15 | 2026-07-31 | usage-state-flap | Usage screen stops flipping between a real figure and a stale lower one, and survives a daemon restart |
| r16 | 2026-07-31 | bt-menu-claude-mode | Bluetooth management without leaving Claude mode: hold the settings key for pairing, paired devices, and per-device actions |
| r17 | 2026-07-31 | session-order | Session list stops reshuffling: a working session only moves past idle ones, never past another working one |
| r18 | 2026-08-01 | perf-event-flood | Device stops freezing under many sessions: daemon event flood debounced at the source, device repaints only when the screen actually changes |
| r19 | 2026-08-01 | duplicate-question-alert | One alert per question: a multiple-choice ask stops also raising a permission card with a raw JSON body |
| r20 | 2026-08-01 | relay-coalesce | Bluetooth relay coalesces state frames, offscreen tiles stop animating, faceplate stops double-parsing broadcasts |
| r21 | 2026-08-01 | relay-default | Claude Code relay toggle is on by default in a fresh DMG install |
| r22 | 2026-08-01 | hw-frontend | Mode chips take Claude Code's colours, questions answered inside the queue hero, working mascot runs at the session's effort level |
| r23 | 2026-08-01 | option-expand | The queue option under the cursor expands, label over description, both wrapped in full |
| r24 | 2026-08-01 | parked-window-focus | Answering a backgrounded job from the device raises the window parked on it instead of reporting no window |
| r25 | 2026-08-01 | expired-answer | A timed-out question still raises its terminal when answered from the device, and every failed answer says why on the Mac |
