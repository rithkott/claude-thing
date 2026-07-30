# claude-thing

> **A fork of [Nocturne](https://github.com/usenocturne/nocturne) 4.0**, the
> custom Car Thing firmware by [usenocturne](https://github.com/usenocturne).
> Nothing Nocturne does is removed — this adds a second mode alongside it and
> ships the changes as patches against the upstream repos.

Turn a Spotify Car Thing into a desk monitor for Claude Code: every session at a
glance, a queue of everything waiting on you, live usage bars, and permission
approve/deny from the dial.

It ships as an **extension of [Nocturne](https://github.com/usenocturne/nocturne)**
— music mode and Claude mode live side by side in one firmware image and swap at
runtime, so the device stays a music player when you want one.

```
Car Thing kiosk ⇄ nocturned :5000 ⇄ [emulator bridge │ Bluetooth → Nocturne.app]
                                   ⇄ Mac daemon :8790 ⇄ Claude Code hooks
                                                        claude agents --json
                                                        transcripts, /usage
```

**You do not need the hardware to run this.** The repo includes a full Car Thing
emulator that boots your real firmware image, renders at the device's true
800×480, and drives it with the same events the physical buttons produce.

---

## What's on the device

| Button | Screen |
|---|---|
| **Preset 1** | **Sessions** — a two-row grid that scrolls sideways, unbounded. Each tile shows state, current activity, token counts, and an animated 8-bit Claude mascot acting out what the session is doing. Pressing a tile also raises that session's terminal window on the Mac. |
| **Preset 2** | **Queue** — everything waiting on a human: tool permissions and Claude's multiple-choice questions, oldest first, with wait timers. |
| **Preset 3** | **Usage** — the real `/usage` figures: session and weekly limits with reset times, plus what's driving them. Refreshed every minute. |
| **Preset 4** | Denies the permission currently on screen. |
| **Dial** | Turn to move, press to open or confirm. |
| **Back** | Up a level; on a prompt, leaves it for the terminal. |
| **M** | Ambient clock. |
| **Touch** | Everything on screen is tappable. |

Mode switch: hold **preset 1 + preset 4** together for one second. The choice is
sticky across reboots.

---

## Install on the Mac

Requires macOS, **Node 18+**, and Claude Code on your `PATH`.

```sh
git clone https://github.com/rithkott/claude-thing.git
cd claude-thing
./mac/install.sh
```

That installs dependencies, builds the control page and the device app, merges
the Claude Code hooks into `~/.claude/settings.json` (writing a timestamped
backup first), and loads a LaunchAgent so the daemon runs at login and restarts
if it dies. Pass `--no-agent` to skip the LaunchAgent and run the daemon by hand
with `npm --prefix daemon start`.

Then open the control page at **http://127.0.0.1:8790** — it shows daemon
status, whether the hooks are live, and the Bluetooth link once you have
hardware paired.

`./mac/uninstall.sh` reverses all of it, hooks included.

Optional: `brew install e2fsprogs` — needed to read firmware images, so required
for the emulator and for firmware injection but not for the daemon itself.

### Run the emulator

```sh
node emulator/scripts/deploy-dev.js
```

or just say **"deploy to dev"** to Claude Code in this repo (there's a skill for
it). It finds your newest firmware zip, extracts the webapp out of the rootfs,
grafts the Claude app in, starts the daemon, and opens a Chrome window with a
clickable Car Thing faceplate rendered 1:1 at 800×480.

`CLAUDE_THING_MOCK=1` runs it with fake sessions plus a scripted permission every
60s and a question every 90s, which is the easiest way to see the queue work.

---

## Build and install on the hardware

The device ends up running Nocturne with the Claude app added alongside it, and
the Mac ends up running Nocturne.app with a small relay added to it. Nothing here
replaces Nocturne — every step below starts from an upstream artifact and adds to
it.

### What you need first

| | |
|---|---|
| A Car Thing | already unbrickable/flashable — [Terbium](https://terbium.app) in Chrome handles the flash itself |
| A Nocturne firmware zip | from [Nocturne releases](https://github.com/usenocturne/nocturne/releases), or your own Buildroot build. Must be a zip containing `system_a.ext2` (that's the Terbium-style package, not a `.swu`) |
| macOS | Node 18+, `brew install e2fsprogs` (the injector needs `debugfs`), Chrome for Terbium's WebUSB |
| Xcode | only for step 4, the connector relay |

Steps 1 and 4 are the minimum for a working device. Step 2 is only needed if you
want the device to *ask* the Mac for things (session list, permissions, usage) —
events pushed Mac→device work on stock nocturned. Step 3 is optional polish.

### 1. Build the Claude app and inject it into the firmware zip

```sh
cd device-app && npm run build && cd ..
node scripts/inject-firmware.js
```

With no arguments it picks the newest `nocturne*.zip` from `firmware/`,
`~/Desktop`, or `~/Downloads`; point at one explicitly with `--zip <path>` and
choose the output with `--out <path>`. It writes
`nocturne_<version>_claude.zip` next to the source zip.

What it does to the image: adds the built app at `/etc/nocturne/ui/claude` in
**both** rootfs slots (so an OTA slot swap doesn't lose it) and grafts
`switch.js` into the music UI's `index.html`, which is what makes holding
preset 1 + preset 4 toggle between `/` and `/claude/`. It never modifies the
source zip, and re-running it replaces a previous injection cleanly rather than
stacking.

### 2. Patch nocturned so the device can call the Mac

nocturned routes only an allow-listed set of methods to the connector and
answers `Unknown method` to everything else, so `claude.*` needs one extra match
arm. The edit is a single new arm ahead of the `_ =>` default in
`src/app/websocket_handler.rs`, described in full in
[`patches/nocturned-claude-forward.patch`](patches/nocturned-claude-forward.patch).

Two ways to get a patched binary onto the device:

**Full firmware build (reliable path).** Fork
[`usenocturne/nocturned`](https://github.com/usenocturne/nocturned), apply the
arm, then build [`usenocturne/nocturne`](https://github.com/usenocturne/nocturne)
with `external/package/nocturned/nocturned.mk` pointed at your fork
(`NOCTURNED_SITE` + `NOCTURNED_VERSION`; run `just cleandeps` after changing it,
or Buildroot keeps the old checkout). That produces a complete zip — then run
step 1 against *that* zip. The target is armv7 hard-float glibc from Buildroot's
own toolchain; see [`carthing-knowledge/firmware.md`](carthing-knowledge/firmware.md)
for the build's shape.

**Inject a binary you already have.** If you can produce a compatible
`armv7-unknown-linux-gnueabihf` build another way:

```sh
node scripts/inject-firmware.js --nocturned /path/to/nocturned
```

That drops the binary into both slots in the same pass as the app.

### 3. Optional: a "Claude Mode" entry in Nocturne's settings menu

The button chord already switches modes with no source change. If you build
nocturne-ui from source anyway and want a visible menu item too, apply
[`patches/nocturne-ui-claude-mode.patch`](patches/nocturne-ui-claude-mode.patch)
(two edits in `src/components/settings/Settings.jsx`).

### 4. Add the relay to the Nocturne macOS app

The Mac's Bluetooth link to the device is owned by Nocturne.app, so the
`claude.*` relay lives there — it's a WebSocket *client* of the daemon on
`ws://127.0.0.1:8790/ws`, carrying request dispatch, event push, and status
heartbeats over one socket.

Clone [`usenocturne/nocturne-connector`](https://github.com/usenocturne/nocturne-connector)
and work in `macos/Nocturne/`. [`patches/swift/ClaudeRelayService.swift`](patches/swift/ClaudeRelayService.swift)
is the complete new service to drop in at `Services/`, and
[`patches/swift-connector.md`](patches/swift-connector.md) gives the exact call
sites: one branch in `RPCManager.dispatch`, the event hookup, construction in
`NocturneApp.init()`, and a persisted settings toggle.

Build in Xcode with **automatic signing** — do *not* disable code signing, or the
app loses its Bluetooth and Keychain grants and the link silently stops working.

### 5. Flash, pair, verify

1. Flash `nocturne_<version>_claude.zip` with [Terbium](https://terbium.app)
   over WebUSB (Chrome on macOS works).
2. Pair the Car Thing in **System Settings → Bluetooth**.
3. Launch your built Nocturne.app and enable the Claude relay in its settings.
4. Open the control page at <http://127.0.0.1:8790> — *Nocturne connector* should
   read **relaying**, with the Bluetooth rows filled in.
5. On the device, hold preset 1 + preset 4 for a second. The session list should
   populate. If it instead errors with `Unknown method`, the running firmware
   doesn't have step 2's patch.
6. Trigger a tool permission in any Claude Code session — it should take over the
   device screen; preset 1 allows, preset 4 denies, back leaves it to the
   terminal.

---

## Repo layout

| Path | What |
|---|---|
| `daemon/` | Mac host daemon on `127.0.0.1:8790`. Session discovery, the permission bridge, the queue, usage, window focus, and the WebSocket hub. |
| `device-app/` | The Claude mode kiosk app (Vite + vanilla JS, Chrome 69 target, hash routing). Sprites are generated from ASCII pixel grids by `npm run sprites`. |
| `webpage/` | The Mac control page (React + Tailwind): status, Bluetooth verification, hook management. |
| `emulator/` | The Car Thing emulator: firmware extraction, static server, mock nocturned, faceplate, `claude.*` bridge. |
| `mac/` | `install.sh`, `uninstall.sh`, LaunchAgent template. |
| `patches/` | Hardware-side changes: the nocturned arm, the Swift relay, an optional nocturne-ui menu entry. |
| `scripts/` | `inject-firmware.js`, `test-all.sh`. |
| `protocol/claude-protocol.md` | The `claude.*` contract — the single source of truth. |
| `carthing-knowledge/` | Research notes on the device platform. |
| `design-handoff/` | The original screen designs. |

## Tests

```sh
./scripts/test-all.sh          # unit tests + builds + firmware extraction
./scripts/test-all.sh --full   # also boots a daemon and runs the WS integration test
```

60 unit assertions cover the usage parser, the session state machine, the
permission bridge (including the timeout path), the queue's focus/typing
fallbacks, and every device screen's rendering. The integration test drives a
real permission round trip over the WebSocket hub.

---

## Two things worth knowing

**Permissions are answered properly; questions are typed.** A `PermissionRequest`
hook is held open by the daemon, so allow/deny from the dial is the real
decision. Multiple-choice questions can't work that way — no Claude Code hook
can supply a tool result — so answering one focuses that session's terminal and
types the option number. That needs Automation → System Events; if macOS denies
it, the device focuses the window and tells you to press the key. It never
routes around the denial.

**Nothing auto-denies.** If the daemon is down, unreachable, or nobody answers
within 55 seconds, the hook is released with "ask" and the normal terminal
prompt takes over.

## Status

Working and verified end to end in the emulator against real Claude Code
sessions, including a full permission round trip. **Not yet exercised on real
hardware:** the Swift relay and the nocturned patch — the emulator stands in for
the Bluetooth link, so those two are the remaining hardware-only unknowns.

## License

GPL-3.0 — see [LICENSE](LICENSE), matching
[Nocturne](https://github.com/usenocturne/nocturne) upstream, which this forks.
Nocturne and the Car Thing platform work belong to their respective authors;
this repo only adds to them.
