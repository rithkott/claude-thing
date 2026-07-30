# claude-thing

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
git clone <your-fork-url> claude-thing
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

## Flashing the firmware

The device runs Nocturne with the Claude app added alongside it. You need a
Nocturne firmware zip (from [Nocturne releases](https://github.com/usenocturne/nocturne/releases)
or your own build) — the ones containing `system_a.ext2`.

**1. Build the Claude app and inject it into the zip.**

```sh
cd device-app && npm run build && cd ..
node scripts/inject-firmware.js
```

This writes `nocturne_<version>_claude.zip` next to the source zip. It adds the
Claude app at `/etc/nocturne/ui/claude` in **both** rootfs slots and grafts the
mode-switch script into the music UI's `index.html`. It never touches the
original zip, and re-running it replaces a previous injection cleanly.

**2. For device→Mac requests, patch nocturned.**

nocturned only forwards an allow-listed set of methods to the phone, so `claude.*`
requests need one extra match arm — see
[`patches/nocturned-claude-forward.patch`](patches/nocturned-claude-forward.patch).
Build nocturne with that applied, or pass an already-built binary to the
injection script:

```sh
node scripts/inject-firmware.js --nocturned /path/to/nocturned
```

Events flowing the other way (Mac → device) need no patch at all, so an
unpatched device will still show sessions pushed to it — it just can't make
requests.

**3. Add the relay to the Nocturne macOS app.**

The Mac's Bluetooth link is owned by Nocturne.app, so the `claude.*` relay lives
there. [`patches/swift/ClaudeRelayService.swift`](patches/swift/ClaudeRelayService.swift)
is the complete service, and [`patches/swift-connector.md`](patches/swift-connector.md)
has the three call sites to wire it into `RPCManager` and `NocturneApp`, plus the
settings toggle. Build in Xcode with automatic signing — do **not** disable code
signing, or you'll lose the app's Bluetooth and Keychain grants.

**4. Flash.**

Flash the produced zip with [Terbium](https://terbium.app) over WebUSB (works in
Chrome on macOS). Then pair the Car Thing in System Settings → Bluetooth, enable
the Claude relay in Nocturne's settings, and watch the control page's Bluetooth
section confirm the link.

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

MIT — see [LICENSE](LICENSE). Nocturne and the Car Thing platform work belong to
their respective authors; this repo only adds to them.
