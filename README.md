# claude-thing

> **A fork of [Nocturne](https://github.com/usenocturne/nocturne) 4.0**, the
> custom Car Thing firmware by [usenocturne](https://github.com/usenocturne).
> Nothing Nocturne does is removed — this adds a second mode alongside it.

Turn a Spotify Car Thing into a desk monitor for Claude Code: every session at a
glance, a queue of everything waiting on you, live usage bars, and permission
approve/deny from the dial. Music mode and Claude mode live in one firmware
image and swap at runtime, so the device stays a music player when you want one.

```
Car Thing kiosk ⇄ nocturned :5000 ⇄ [emulator bridge │ Bluetooth → Nocturne.app]
                                   ⇄ Mac daemon :8790 ⇄ Claude Code hooks
                                                        claude agents --json
                                                        transcripts, /usage
```

**You don't need the hardware.** The repo includes a Car Thing emulator that
boots your real firmware image at the device's true 800×480 and drives it with
the same events the physical buttons produce.

---

## What's on the device

| Button | Screen |
|---|---|
| **Preset 1** | **Sessions** — a two-row grid that scrolls sideways, unbounded. Each tile shows state, current activity, how full the context window is, and an animated 8-bit Claude mascot acting out what the session is doing. Pressing a tile also raises that session's terminal window on the Mac. |
| **Preset 2** | **Queue** — everything waiting on a human. The one you'd answer next owns the screen and can be allowed or denied without leaving it; the rest stack underneath. |
| **Preset 3** | **Usage** — the real `/usage` figures: session and weekly limits with reset times, plus what's driving them. |
| **Preset 4** | Denies the permission on screen — on the prompt or on the queue. |
| **Dial** | Turn to move, press to open or confirm. |
| **Back** | Up a level; on a prompt, leaves it for the terminal. |
| **M** | Ambient clock. |
| **Touch** | Everything on screen is tappable. |

Mode switch: hold **preset 1 + preset 4** for one second. Sticky across reboots.

---

## Install

**1. The Mac daemon** — needs Node 18+ and Claude Code on your `PATH`.

```sh
git clone https://github.com/rithkott/claude-thing.git
cd claude-thing && ./mac/install.sh
```
Installs dependencies, builds the control page and device app, merges the Claude
Code hooks into `~/.claude/settings.json` (backup written first), and loads a
LaunchAgent. Control page: <http://127.0.0.1:8790>. `./mac/uninstall.sh` reverses
all of it. `--no-agent` skips the LaunchAgent.


**2. `Nocturne-claude-*.dmg`** — Nocturne.app with the `claude.*` relay, which is
what carries traffic between the device and the daemon. Drag it to Applications,
then:

```sh
xattr -cr /Applications/Nocturne.app
```

It's ad-hoc signed rather than notarized, so macOS blocks it without that.
An alternative is to open it without doing that, then go to System Settings -> Privacy and Security. Scroll to the bottom and click Open Anyway

Launch it and turn on **Settings → Claude Mode → Claude Code relay**.


**3. `nocturne_*_claude.zip`** — flash with [Terbium](https://terbium.app) in
Chrome. 

Hold **preset 1 and preset 4** while plugging in USB-C to enter burn mode. Follow the instructions in Terbium. When it's time to select firmware, click local archive and drag in the zip file, and flash.

Car thing enters pairing mode automatically when first plugged in, connect from your Mac's Bluetooth menu.

The control page should show *Nocturne connector* relaying, and holding
preset 1 + preset 4 on the device should bring up your sessions.


## Repo layout

| Path | What |
|---|---|
| `daemon/` | Mac host daemon on `127.0.0.1:8790`. Session discovery, permission bridge, queue, usage, window focus, WebSocket hub. |
| `device-app/` | The Claude mode kiosk app (Vite + vanilla JS, Chrome 69 target). |
| `webpage/` | The Mac control page (React + Tailwind). |
| `emulator/` | Firmware extraction, static server, mock nocturned, faceplate, `claude.*` bridge. |
| `mac/` | `install.sh`, `uninstall.sh`, LaunchAgent template. |
| `patches/` | The nocturned arm, the Swift relay, an optional nocturne-ui menu entry. |
| `scripts/` | Firmware injection, the two builders, `test-all.sh`. |
| `protocol/claude-protocol.md` | The `claude.*` contract — the single source of truth. |
| `carthing-knowledge/` | Research notes on the device platform. |
| `design-handoff/` | The original screen designs. |

## Tests

```sh
./scripts/test-all.sh          # unit tests + builds + firmware extraction
./scripts/test-all.sh --full   # also boots a daemon and runs the WS integration test
```

84 unit assertions cover the usage parser, session state machine, permission
bridge including its timeout path, the queue's focus/typing fallbacks, and every
device screen. The integration test drives a real permission round trip.

## Two things worth knowing

**Permissions are answered properly; questions are typed.** A `PermissionRequest`
hook is held open by the daemon, so allow/deny from the dial is the real
decision. Multiple-choice questions can't work that way — no Claude Code hook can
supply a tool result — so answering one focuses that session's terminal and types
the option number. That needs Automation → System Events; if macOS denies it, the
device focuses the window and tells you to press the key.

**Nothing auto-denies.** If the daemon is down or nobody answers within ten
minutes, the hook is released with "ask" and the terminal prompt takes over —
the device says so rather than letting the prompt vanish.

## Status

Working on real hardware. A flashed Car Thing pairs, the Nocturne relay carries
`claude.*` over Bluetooth, and live sessions from this Mac render on the device —
the cross-compiled `nocturned` and the Swift relay have both now been exercised
outside the emulator.

## License

GPL-3.0 — see [LICENSE](LICENSE), matching
[Nocturne](https://github.com/usenocturne/nocturne) upstream, which this forks.
Nocturne and the Car Thing platform work belong to their respective authors;
this repo only adds to them.
