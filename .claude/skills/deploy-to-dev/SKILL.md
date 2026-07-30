---
name: deploy-to-dev
description: Deploy the latest Car Thing firmware plus the Claude mode app to the local dev emulator, starting the host daemon too. Trigger on "deploy to dev", "deploy dev", "run the emulator", "test on the emulator", "open the car thing", "spin up the car thing".
---

Run (from the project root `/Users/rithvikkottapalli/Desktop/Projects/claude-thing`):

```bash
node emulator/scripts/deploy-dev.js
```

That one command: finds the newest `nocturne*.zip` firmware (searching
`firmware/`, `~/Desktop`, `~/Downloads`; zips without a `system_a.ext2` rootfs
are skipped), extracts the webapp from the rootfs (cached per zip+mtime), builds
`device-app` and grafts it in at `/claude/` with the mode-switch script, starts
the claude-thing daemon on `127.0.0.1:8790`, restarts the emulator (static UI on
`:8080`, mock nocturned on `:5000`), and opens a Chrome app-mode window with the
Car Thing faceplate.

The window opens at 1120×700 physical pixels with
`--force-device-scale-factor=1`, so the 800×480 panel renders 1:1 with no HiDPI
supersampling (it closes any previous window on the emulator's own Chrome
profile first, since those flags only apply at process start).

Report to the user: firmware version + zip name, whether Claude Code hooks are
installed (the script prints it), and that the window is at
<http://127.0.0.1:8080/__emulator__/> with the Mac control page at
<http://127.0.0.1:8790>.

Usage notes worth passing along:
- Music mode boots first. Hold **preset 1 + preset 4** for one second to enter
  Claude mode; same chord returns. Sticky across reboots.
- `CLAUDE_THING_MOCK=1 node emulator/scripts/deploy-dev.js` uses fake sessions and
  a scripted permission prompt every 60 s.

Troubleshooting:
- `debugfs not found` → `brew install e2fsprogs`, rerun.
- `No firmware zip found` → the error lists the searched dirs; dirs are
  configurable in `emulator/src/config.js` (`ZIP_SEARCH_DIRS`).
- Port 8080 or 8790 held by a foreign process → show
  `lsof -nP -iTCP:8080 -iTCP:8790 -sTCP:LISTEN` and ask before killing anything.
  Port 5000 is shared with macOS AirPlay Receiver — expected and fine.
- Claude mode shows "DAEMON OFFLINE" → daemon died; see `daemon/logs/daemon.log`.
- Hooks not installed → `cd daemon && npm run install-hooks` (writes a backup),
  or use the webpage's Settings page. Only affects sessions started afterwards.
- Logs: `daemon/logs/daemon.log`, `emulator/logs/{server,ws}.log`.
