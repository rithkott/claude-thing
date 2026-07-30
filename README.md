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

Two prebuilt artifacts are on the [releases page](https://github.com/rithkott/claude-thing/releases/latest):

| Asset | What it is |
|---|---|
| `nocturne_v4.0.7_claude.zip` | Nocturne 4.0.7 with the Claude app already injected, ready for Terbium |
| `Nocturne-claude-1.0.dmg` | Nocturne.app 2.0.5 with the `claude.*` relay built in |

You still need a Car Thing that Terbium can talk to, Chrome for its WebUSB
flashing, and the Mac daemon from the section above.

> **One caveat before you flash.** The released zip carries Nocturne's **stock**
> nocturned, and stock nocturned only forwards an exact allow-list of methods to
> the Mac — `claude.*` isn't on it, so every request the device makes comes back
> `Unknown method` and the session list stays empty. Fixing that needs a
> nocturned rebuilt from a Buildroot cross-toolchain, which can't be produced on
> macOS; see [step 3](#3-patch-nocturned-so-the-device-can-call-the-mac). Until
> that lands upstream, the released zip is the right image to flash but Claude
> mode is not yet functional on real hardware. The
> [emulator](#run-the-emulator) has no such limitation.

### 1. Install the Nocturne app with the relay

Mount `Nocturne-claude-1.0.dmg`, drag Nocturne.app to Applications, then clear
the quarantine flag:

```sh
xattr -cr /Applications/Nocturne.app
```

The DMG is **ad-hoc signed, not notarized** — no Apple Developer certificate was
involved — so without that command macOS refuses to open it. The same command
also strips the Finder metadata the DMG packaging adds, which is what leaves the
signature valid afterwards (`codesign --verify --deep --strict` passes).

Launch it, sign in as you would with stock Nocturne, then turn on
**Settings → Claude Mode → Claude Code relay**. It connects to the daemon at
`ws://127.0.0.1:8790/ws`; the subtitle flips to *Relaying* when it's up.

To build the DMG yourself instead:

```sh
./scripts/build-connector-dmg.sh                                   # clones the connector
./scripts/build-connector-dmg.sh --connector /path/to/checkout     # or use your own
```

That copies a [`nocturne-connector`](https://github.com/usenocturne/nocturne-connector)
checkout into `build/`, adds `ClaudeRelayService.swift`, applies the four call-site
edits, and runs the connector's own DMG script. Your checkout is never modified,
and it refuses to build if any anchor stops matching. Pass `-- --skip-notarize`
(or nothing after `--`) if you have a Developer ID certificate and want a real
signed build; [`patches/swift-connector.md`](patches/swift-connector.md) has the
same edits written out for doing it by hand.

### 2. Flash the firmware

Flash `nocturne_v4.0.7_claude.zip` with [Terbium](https://terbium.app) over
WebUSB, then pair the Car Thing in **System Settings → Bluetooth**.

To build the image yourself, against any Nocturne zip that contains
`system_a.ext2` (that's the Terbium-style package, not a `.swu`) — this needs
`brew install e2fsprogs` for `debugfs`:

```sh
cd device-app && npm run build && cd ..
node scripts/inject-firmware.js
```

With no arguments it picks the newest `nocturne*.zip` from `firmware/`,
`~/Desktop`, or `~/Downloads`; `--zip <path>` and `--out <path>` override that.

What it does to the image: adds the built app at `/etc/nocturne/ui/claude` in
**both** rootfs slots (so an OTA slot swap doesn't lose it) and grafts
`switch.js` into the music UI's `index.html`, which is what makes holding
preset 1 + preset 4 toggle between `/` and `/claude/`. It never modifies the
source zip, and re-running it replaces a previous injection cleanly rather than
stacking.

### 3. Patch nocturned so the device can call the Mac

This is the step no prebuilt artifact can cover, and without it Claude mode has
nothing to display. nocturned matches an explicit list of method names and
answers `Unknown method` to everything else — it is not a `spotify.*` prefix
test, so there's no existing arm `claude.*` can ride in on. The fix is one new
match arm ahead of the `_ =>` default in `src/app/websocket_handler.rs`, written
out in [`patches/nocturned-claude-forward.patch`](patches/nocturned-claude-forward.patch).

**Full firmware build.** Fork [`usenocturne/nocturned`](https://github.com/usenocturne/nocturned),
apply the arm, then build [`usenocturne/nocturne`](https://github.com/usenocturne/nocturne)
with `external/package/nocturned/nocturned.mk` pointed at your fork
(`NOCTURNED_SITE` + `NOCTURNED_VERSION`; run `just cleandeps` after changing it,
or Buildroot keeps the old checkout). That produces a complete zip — then run
step 2's injector against *that* zip. The target is armv7 hard-float glibc from
Buildroot's own toolchain, and nocturned pulls in `bluer`, `dbus` and `opus`, so
it wants that toolchain's sysroot rather than a bare `rustup target add`; see
[`carthing-knowledge/firmware.md`](carthing-knowledge/firmware.md) for the
build's shape.

**Inject a binary you already have.** If you can produce a compatible
`armv7-unknown-linux-gnueabihf` build another way:

```sh
node scripts/inject-firmware.js --nocturned /path/to/nocturned
```

That drops the binary into both slots in the same pass as the app.

### 4. Optional: a "Claude Mode" entry in Nocturne's settings menu

The button chord already switches modes with no source change. If you build
nocturne-ui from source anyway and want a visible menu item too, apply
[`patches/nocturne-ui-claude-mode.patch`](patches/nocturne-ui-claude-mode.patch)
(two edits in `src/components/settings/Settings.jsx`).

### 5. Verify

1. Open the control page at <http://127.0.0.1:8790> — *Nocturne connector*
   should read **relaying**, with the Bluetooth rows filled in.
2. On the device, hold preset 1 + preset 4 for a second. The session list should
   populate. If it stays empty and the logs show `Unknown method`, the running
   firmware doesn't have step 3's patch.
3. Trigger a tool permission in any Claude Code session — it should take over the
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
| `scripts/` | `inject-firmware.js`, `build-connector-dmg.sh`, `test-all.sh`. |
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
sessions, including a full permission round trip.

On real hardware, two pieces are still unproven. The Swift relay **compiles and
ships** in the release DMG but has never carried traffic over an actual
Bluetooth link — the emulator stands in for it. The nocturned patch has never
been built at all, because its cross-toolchain doesn't exist on macOS, and
without it the device can't reach the Mac. Getting that arm into an upstream
Nocturne release is what would make a flashed device work as designed.

## License

GPL-3.0 — see [LICENSE](LICENSE), matching
[Nocturne](https://github.com/usenocturne/nocturne) upstream, which this forks.
Nocturne and the Car Thing platform work belong to their respective authors;
this repo only adds to them.
