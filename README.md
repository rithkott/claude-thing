# claude-thing

Turn a Spotify Car Thing into a desk monitor for Claude Code: every session at a
glance, a queue of everything waiting on you, live usage bars, and permission
approve/deny from the dial.

> **A fork of [Nocturne](https://github.com/usenocturne/nocturne) 4.0**, the
> custom Car Thing firmware by [usenocturne](https://github.com/usenocturne).
> Nothing Nocturne does is removed — this adds a second mode alongside it, and
> the two swap at runtime, so the device stays a music player when you want one.

**No Car Thing? You can still run this.** Skip to
[Try it without the hardware](#try-it-without-the-hardware).

---

## What you'll need

- A **Mac** (Apple Silicon or Intel) — this only runs on macOS.
- A **Spotify Car Thing** and a **USB-C cable** that carries data — the cheap
  charge-only cables will not work.
- **Google Chrome**, for the flashing tool. Safari cannot do it.
- **Claude Code** already installed and working in your terminal.
- About **30 minutes**, most of it waiting on downloads.

Steps 1–4 below all use the Terminal app. If you've never opened it: press
`Cmd+Space`, type `Terminal`, press Return. Commands in grey boxes get pasted in
one at a time, each followed by Return. Nothing here asks you to write code.

---

## Step 1 — Install the two prerequisites

Paste this to check whether you already have them:

```sh
node -v && claude --version
```

Two version numbers means you're set — go to Step 2. An error like
`command not found` means that piece is missing:

- **Node** — download the "LTS" installer from
  [nodejs.org](https://nodejs.org) and run it. Version 18 or newer.
- **Claude Code** — follow
  [the install guide](https://docs.claude.com/en/docs/claude-code/overview),
  then run `claude` once and sign in.

Close and reopen Terminal after installing either one, then run the check again.

---

## Step 2 — Set up the Mac side

This is the piece that watches your Claude Code sessions and feeds the device.

```sh
git clone https://github.com/rithkott/claude-thing.git
cd claude-thing
./mac/install.sh
```

It prints a checklist as it goes, and takes a few minutes. It installs its
dependencies, merges the Claude Code hooks into `~/.claude/settings.json` (a
backup is written first, and nothing you already had is removed), and sets the
daemon to start automatically when you log in.

When it finishes, open <http://127.0.0.1:8790> in a browser. That's the control
page — if it loads, this step worked.

To undo everything this step did, run `./mac/uninstall.sh` from the same folder.

---

## Step 3 — Install the Nocturne app

This app carries the traffic between your Mac and the Car Thing over Bluetooth.

1. Go to the [latest release](https://github.com/rithkott/claude-thing/releases/latest).
2. Under **Assets**, download the file named **`Nocturne-claude-….dmg`** — the
   number in it is Nocturne's own version, not this project's, so take whichever
   one is there.
3. Open the downloaded file and drag **Nocturne** into your Applications folder.
4. Paste this into Terminal:

   ```sh
   xattr -cr /Applications/Nocturne.app
   ```

   The app is signed but not notarized by Apple, so macOS blocks it until you do
   this. If you'd rather not run that command: double-click the app, let macOS
   refuse, then open **System Settings → Privacy & Security**, scroll to the
   bottom, and click **Open Anyway**.

5. Launch Nocturne. Open its **Settings → Claude Mode** and confirm
   **Claude Code relay** is on. (It ships on by default.)

---

## Step 4 — Flash the Car Thing

This replaces the software on the device. It's reversible — Nocturne's own
firmware can be flashed back the same way — but it does wipe what's on there now.

1. From the same [release page](https://github.com/rithkott/claude-thing/releases/latest),
   download the firmware: **`nocturne_v4.0.7_claude_1.17.2.zip`** (again, the
   number may be higher). It's large — around 365 MB.
2. **Do not unzip it.** The flashing tool wants the zip as-is.
3. Open [terbium.app](https://terbium.app) **in Chrome**.
4. Put the Car Thing into burn mode: hold **preset button 1 and preset button 4**
   together while you plug the USB-C cable in, and keep holding for a few seconds
   after. The preset buttons are the four along the top; 1 is leftmost, 4 is
   rightmost. The screen stays dark in burn mode — that's correct, not a failure.
5. Follow Terbium's on-screen steps. When it asks which firmware to use, choose
   **local archive** and drag in the zip you downloaded.
6. Flash, and leave it alone until it says it's done. Do not unplug partway.

---

## Step 5 — Pair and check

The Car Thing enters pairing mode by itself the first time it boots after
flashing. Open the **Bluetooth menu** on your Mac and connect to it.

Two things tell you it worked:

- The control page at <http://127.0.0.1:8790> shows **Nocturne connector**
  relaying.
- On the device, hold **preset 1 + preset 4** for one second. Your Claude Code
  sessions appear.

If you're reflashing your Car Thing to update to a newer version of the firmware, make sure to forget device in your bluetooth menu and repair from scratch. It will not automatically reconnect.

That same hold is the mode switch from then on — Claude mode to music mode and
back. It sticks across reboots.

---

## Using the device

| Button | What it does |
|---|---|
| **Preset 1** | **Sessions** — a scrolling grid of every session. Each tile shows its state, its model, what it's doing, how full its context window is, and an animated Claude mascot acting it out. Pressing a tile raises that session's terminal window on your Mac. |
| **Preset 2** | **Queue** — everything waiting on a human. The one you'd answer next fills the screen and can be allowed or denied right there; the rest stack underneath. |
| **Preset 3** | **Usage** — your real session and weekly limits, with reset times. |
| **Preset 4** | Denies the permission on screen. |
| **Dial** | Turn to move, press to open or confirm. |
| **Back** | Up a level; on a prompt, hands it back to the terminal. |
| **M** | Ambient clock. Tap the screen to hide or bring back the wandering sprite. |
| **Touch** | Everything on screen is tappable. |

Two things worth knowing:

**Permissions are answered for real; questions are typed.** Allow/deny from the
dial is the actual decision — the daemon holds Claude Code's permission hook open
until you answer. Multiple-choice questions can't work that way, so answering one
focuses that session's terminal and types the option number instead. That needs
macOS **Automation → System Events** permission; if it's denied, the device
raises the window and tells you to press the key yourself.

**Nothing ever auto-denies.** If the daemon is down, or nobody answers within ten
minutes, the prompt goes back to the terminal untouched and the device says so.

---

## Try it without the hardware

The repo includes an emulator that boots the real firmware image at the device's
true 800×480 and drives it with the same events the physical buttons produce.

Do Steps 1 and 2 above, then:

```sh
brew install e2fsprogs        # needed to read the firmware image
node emulator/scripts/deploy-dev.js
```

You'll need a firmware zip on hand — download one from the
[releases page](https://github.com/rithkott/claude-thing/releases/latest) as in
Step 4. If you use Claude Code, saying "deploy to dev" runs all of this for you.

---

## Release channels

Every release page carries both a DMG and a firmware zip. There are two kinds:

- **Production** — the newest release *without* a **Pre-release** badge, and
  what [releases/latest](https://github.com/rithkott/claude-thing/releases/latest)
  points at. Install this one.
- **Dev** — tagged `X.Y.Z-dev` and marked **Pre-release**. Published
  automatically the moment a change merges, so it has the newest features and
  the least testing. Install it the same way if you want them early.

---

## When something doesn't work

### Three checks, in this order

**1. Is the daemon up, and what does it see?**

```sh
curl -s http://127.0.0.1:8790/status
```

It answers with JSON: `sessions` is how many Claude Code sessions it found,
`pendingPermissions` is what's waiting on you right now, `connector` is whether
Nocturne is relaying, `hooks` is whether the Claude Code hooks are installed.
No answer at all means the daemon is down:

```sh
launchctl kickstart -k gui/$(id -u)/com.claudething.daemon   # restart it
tail -20 daemon/logs/launchd.err.log                         # find out why
```

**2. Was the session started after the install?** The hooks are written into
`~/.claude/settings.json`, and Claude Code reads them at startup. A `claude`
window that was already open when `./mac/install.sh` ran keeps working normally
but never reports to the device. Quit it and open a new one.

**3. Is the connector relaying?** The control page at <http://127.0.0.1:8790>
says so directly. If it isn't, the Mac and the device aren't talking at all —
that's Bluetooth and Nocturne, not Claude Code.

### Symptoms

**`./mac/install.sh` stops with "command not found".** Node or Claude Code isn't
installed, or Terminal hasn't picked it up yet. Redo Step 1 and open a fresh
Terminal window.

**The control page won't load.** Check the daemon's log:

```sh
tail -20 daemon/logs/launchd.err.log
```

**Sessions appear, but permissions and questions never do.** The hooks aren't
reaching the daemon. Check `hooks` in `/status` above; if it's false, re-run
`node daemon/scripts/install-hooks.js`. If it's true, the sessions predate the
install — restart them.

**macOS refuses to open Nocturne.** The `xattr` command in Step 3 was skipped, or
was run before the app was moved into Applications. Run it again.

**Terbium doesn't see the Car Thing.** Usually a charge-only USB-C cable, or the
button hold didn't catch. Unplug, hold preset 1 + preset 4 *first*, then plug in
while still holding.

**Device connects but the screen stays on music mode.** Hold preset 1 + preset 4
for a full second. If nothing happens, check that Nocturne's **Claude Code relay**
toggle is on and that the control page shows the connector relaying.

**Answering a question does nothing.** An Automation permission is missing or
was denied. See the next section — this is the single most common failure, and
the one that comes back on its own after a Claude Code update.

**It worked yesterday and stopped today.** Same section. Claude Code updated,
and the permission didn't follow it.

---

## Granting macOS permission

Permissions on the device are answered over the hook and need nothing from
macOS. **Questions** — multiple-choice asks and plan approvals — can't be
answered that way, so the daemon raises the session's window and types the
answer. Typing is what macOS gates.

Two grants, both under **System Settings → Privacy & Security → Automation**:

| Grant | What breaks without it |
|---|---|
| → **Terminal** | Pressing a tile can't raise that session's window. |
| → **System Events** | The device can raise the window but can't type the answer. It tells you to press the key yourself. |

macOS asks the first time each one is needed — a dialog reading *"… wants to
control …"*. Click **OK**. **If you ever click "Don't Allow", macOS remembers
the refusal and never asks again**; the only way back is to switch the toggle on
by hand in that pane.

### The dialog probably won't say "Claude"

An Automation grant belongs to one exact binary, and Claude Code's binary is
its own version number: it lives at `~/.local/share/claude/versions/2.1.220`,
and the file is literally named `2.1.220`. So the dialog can read **"2.1.220"
wants to control "System Events"**, and the Automation pane lists an entry
called **2.1.220** with no other clue what it is. That is Claude Code. Allow it.

Newer installs identify themselves as **Claude** (`com.anthropic.claude-code`)
instead — one stable name that survives updates. If you see both, leave both on
and prefer the **Claude** one.

This is also why the grant evaporates: **every Claude Code update is a new
version number, so it's a new binary, with no grant.** The old versions keep
their rows forever, including the denied ones, which never re-prompt. If
answering questions quietly stopped working, look for a fresh version-numbered
entry in the Automation pane and switch it on.

The dialog names whoever macOS holds responsible for the daemon, which is
whatever started it — Claude Code, the terminal you launched it from, or `node`
under the LaunchAgent. Grant what it names. If you change how the daemon starts,
expect to be asked once more.

### Read what macOS actually recorded

```sh
sqlite3 ~/Library/"Application Support"/com.apple.TCC/TCC.db \
  "select client, indirect_object_identifier, auth_value from access
   where service='kTCCServiceAppleEvents'"
```

`auth_value` is `2` for allowed and `0` for denied. The rows that matter name
`com.anthropic.claude-code` or a `…/versions/<number>` path on the left, and
`com.apple.systemevents` or `com.apple.Terminal` on the right. A `0` there is a
denial that will never prompt you again.

To wipe the slate and be asked afresh at the next answer:

```sh
tccutil reset AppleEvents
```

> That resets **every** app's Automation grants, not only Claude's. Each app
> asks again the next time it needs one — nothing is lost permanently, but
> other automations you rely on will prompt once.

---

## Prompts that work better with the device

None of this is required — the device works against a stock Claude Code. These
are the habits that keep more of a session answerable from the dial instead of
sending you back to the keyboard. The first three are worth putting in your
`~/.claude/CLAUDE.md` so every session inherits them.

**Ask for decisions as multiple choice.** Only two things reach the device
queue: tool permissions, and `AskUserQuestion` cards. A question typed as free
prose — *"what should I call it?"* — shows up nowhere and blocks the session
until you walk over. Something like *"When you need a decision from me, ask it
as a multiple-choice question with concrete options rather than open prose"*
converts most of them. Batching is fine: a multi-question ask is one card you
walk through and submit.

**Leave the session in a mode that actually asks.** Manual approve and plan mode
route every permission through the hook, so they land on the device.
`--dangerously-skip-permissions` asks nobody, and accept-edits swallows file
edits before the hook sees them — those sessions show up as tiles but never
queue anything. Each tile prints its mode, so you can see which is which.

**Keep every request coming from the same place.** macOS grants are per-binary,
so one terminal app and one Claude Code install means one set of permissions to
grant, once. Running some sessions from Terminal, some from another emulator,
some from a second Claude install gives you several separate macOS clients —
each needing its own grant, each silently failing to type until you notice and
give it one.

**Run Claude Code in Terminal.app if you can.** It's the only mainstream
emulator that exposes a per-tab tty, which is how the daemon finds the exact
window for a session. In iTerm2, Ghostty or WezTerm the device raises the app
and leaves the keypress to you. VS Code's integrated terminal isn't an OS window
at all and can't be targeted.

---

## For developers

<details>
<summary>Architecture, repo layout, and tests</summary>

```
Car Thing kiosk ⇄ nocturned :5000 ⇄ [emulator bridge │ Bluetooth → Nocturne.app]
                                   ⇄ Mac daemon :8790 ⇄ Claude Code hooks
                                                        claude agents --json
                                                        transcripts, /usage
```

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

```sh
./scripts/test-all.sh          # unit tests + builds + firmware extraction
./scripts/test-all.sh --full   # also boots a daemon and runs the WS integration test
```

84 unit assertions cover the usage parser, session state machine, permission
bridge including its timeout path, the queue's focus/typing fallbacks, and every
device screen. The integration test drives a real permission round trip.

`./mac/install.sh --no-agent` skips the LaunchAgent if you'd rather start the
daemon yourself with `npm --prefix daemon start`.

Release process is documented in [CLAUDE.md](CLAUDE.md); shipped versions are
listed in [RELEASES.md](RELEASES.md).

</details>

## Status

Working on real hardware. A flashed Car Thing pairs, the Nocturne relay carries
`claude.*` over Bluetooth, and live sessions render on the device.
The codebase has reached a stable and relatively bug-free state.

## License

GPL-3.0 — see [LICENSE](LICENSE), matching
[Nocturne](https://github.com/usenocturne/nocturne) upstream, which this forks.
Nocturne and the Car Thing platform work belong to their respective authors;
this repo only adds to them.
