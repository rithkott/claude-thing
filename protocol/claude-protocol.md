# claude.* protocol

Single source of truth for the Claude Mode RPC surface. Envelope everywhere is
the nocturned JSON envelope:

```json
{"type":"request","id":"<uuid>","method":"claude.sessions.list","params":{}}
{"type":"response","id":"<uuid>","result":{}}
{"type":"error","id":"<uuid>","error":"<string>"}
{"type":"event","topic":"claude.sessions.update","data":{},"server_timestamp_ms":0}
```

Transport chain: device app ⇄ nocturned :5000 ⇄ (emulator claude-bridge | BT →
Swift Nocturne relay) ⇄ daemon `ws://127.0.0.1:8790/ws`. The Swift relay
converts MsgPack↔JSON at the BT boundary; frames are otherwise passed through
with ids preserved.

## Bridge handshake (daemon-internal, relays + webpage only)

First frame from any client of the daemon hub:

```json
{"type":"request","id":"…","method":"bridge.hello","params":{"role":"emulator|connector|webpage","info":{}}}
```

→ `{"result":{"ok":true,"daemonVersion":"…"}}`.

Connector role additionally pushes status (every 10s and on change):

```json
{"type":"request","id":"…","method":"bridge.status","params":{"bt":{"connected":true,"device":"Car Thing","address":"…","serial":"…","firmware":"…"}}}
```

Hub semantics (deliberate deviation from nocturned, daemon-internal only):
responses go **only to the requesting socket**; events broadcast to all
connected clients.

## Requests (device → daemon)

| Method | Params | Result |
|---|---|---|
| `claude.ping` | `{}` | `{daemonVersion, sessions:<n>}` |
| `claude.sessions.list` | `{limit?}` | `{sessions:[SessionSummary], stats:Stats, serverNowMs, tzOffsetMin}` — unbounded unless `limit` given |
| `claude.session.get` | `{id}` | `SessionDetail` (error `"unknown session"` if gone) |
| `claude.permission.answer` | `{requestId, decision:"allow"\|"deny"}` | `{accepted:bool}` — idempotent; `false` when already resolved |
| `claude.queue.list` | `{}` | `{asks:[Ask]}` — everything waiting on a human, oldest first |
| `claude.question.answer` | `{id, answers}` — `answers` is `number[][]`, one entry per question of the ask, each the option indices picked for it (`optionIndex` still accepted for a lone single-select question) | `{accepted, viaKeyboard, option, keys?, focused?, reason?}` (see below) |
| `claude.session.focus` | `{id}` | `{focused, app?, exact?, reason?}` — raises that session's terminal window |
| `claude.usage.get` | `{}` | `Usage` |

## Events (daemon → everyone)

| Topic | Data | Notes |
|---|---|---|
| `claude.sessions.update` | `{sessions:[SessionSummary], stats:Stats, serverNowMs, tzOffsetMin}` | full idempotent snapshot of ALL sessions, debounced 500 ms. The device's clock is wrong in both axes — no RTC battery, no NTP, no timezone data — so it takes both from here: `serverNowMs` = the Mac's `Date.now()`, the epoch every device-side duration and countdown is measured against; `tzOffsetMin` = the Mac's `Date.getTimezoneOffset()`, which renders it as local time. Not the frame's `server_timestamp_ms` — nocturned re-stamps relayed frames with the device clock |
| `claude.session.update` | `SessionDetail` | pushed on change for any live session |
| `claude.permission.request` | `{requestId, sessionId, tool, summary, intent, createdTs, timeoutMs}` | timeoutMs = 55000; `intent` = "you asked: …" from the session's last prompt, "" when unknown |
| `claude.permission.resolved` | `{requestId, resolution:"allow"\|"deny"\|"timeout"}` | closes prompt everywhere; terminal-answered too |
| `claude.question.request` | `Ask` (kind `question`) | a multiple-choice question is on screen in some session |
| `claude.question.resolved` | `{id, resolution:"answered"\|"timeout"}` | the question is gone, however it was answered |
| `claude.usage.update` | `Usage` | pushed once a minute |
| `claude.daemon.status` | `{connected:bool}` | synthesized by relays on daemon link up/down — never sent by the daemon itself |

## Shapes

```ts
SessionSummary = {
  id: string,            // session id
  name: string,          // project dir basename, ≤32 chars
  state: "busy"|"attention"|"celebrate"|"idle",
  lastActivityTs: number,      // epoch ms
  tokens: { in: number, out: number },
  pendingPermission: boolean,
  ended: boolean,       // idle-and-over vs idle-and-quiet
  context: number|null, // 0..1 of the model's context window; null when the
                        // model is unknown, so the device draws no meter
                        // rather than a meter against a guess
  permissionMode: string|null, // "plan"|"bypassPermissions"|"acceptEdits"|
                        // "auto"|"default"; null until a hook or transcript
                        // record says — the device draws no badge for null
                        // or anything it can't name
  effort: string|null,  // reasoning effort of the newest turn, off the
                        // transcript's assistant records ("low"…"max",
                        // "ultrathink"); null until one says — the device
                        // then draws no effort label and keeps the plain
                        // working sprite
}
// ~150 B each, unbounded count — the device grid scrolls sideways through
// them. Over Bluetooth an async event snapshot spans multiple chunks, which the
// chunking layer handles; a *synchronous* response cannot, so a constrained
// client should pass `limit` on claude.sessions.list and rely on the event
// stream for the full set.

SessionDetail = SessionSummary & {
  contextTokens: number, // what the newest turn sent — the raw numerator
  cwd: string,
  model: string,
  startedTs: number,
  currentTool: string|null,
  lastMessage: string,   // ≤200 chars
  permission: { requestId, tool, summary, createdTs, timeoutMs } | null,
}

Stats = { active: number, attention: number }

Ask =
  | { kind:"permission", id, sessionId, sessionName, tool, summary, intent, createdTs, timeoutMs }
  | { kind:"question", id, sessionId, sessionName, intent, createdTs,
      questions: [{ header, question, options:[{label, description}], multiSelect }],
      // mirrors of questions[0] — the card's summary line, and what a client
      // that predates grouping reads
      header, question, options, multiSelect }
// One AskUserQuestion call is ONE dialog and one ask, however many questions it
// carries: the terminal walks them in order and ends on a "Submit answers"
// step. Splitting it per question leaves that step with no card and no
// keypress, and the session blocked on a dialog every question of which was
// answered.
// intent: "you asked: " + the session's last user prompt (≤120 chars,
// whitespace-collapsed), or "" when no prompt has been seen — the device
// omits the hero's intent line rather than inventing one

Usage = {
  updatedTs, updatedLabel, subscription?, stale?, error?,
  limits: [{ key, label, used /* 0..1 */, detail /* "resets Jul 30 at 5:19am" */ }],
  windows: [{
    window /* "Last 24h" */, requests, sessions,
    notes: [string],                        // every bullet, verbatim
    // "Top skills: /x 4%, /y 1%" is a table wearing a sentence; split so the
    // device renders rows. Empty when that bullet is absent.
    skills:    [{ name, pct }],
    subagents: [{ name, pct }],
    mcp:       [{ name, pct }],
  }],
}
```

## Answering questions is not symmetric with permissions

A permission is answered by the daemon: it holds the `PermissionRequest` hook's
HTTP response and replies with the decision. **A multiple-choice question cannot
be.** No Claude Code hook can supply a tool result — `PreToolUse` on
`AskUserQuestion` can only allow, deny, or rewrite the question, and
`PostToolUse` runs after the human has already answered. So the device learns
about questions from the `PreToolUse` hook and answers them the only way
available: focus that session's terminal window and type the keys.

### The keys

This is the one part of the system that cannot be derived from any code here —
it is the terminal UI's contract, read out of the Claude Code CLI itself
(2.1.220). It lives in `keySequence()` in `daemon/src/queue.js`, and the whole
set is typed in **one** osascript call so focus cannot move mid-sequence:

| Step | Keys |
|---|---|
| single-select question | the option's digit — its `onAnswer` defaults `shouldAdvance` to true, so the digit both picks and advances |
| multiSelect question | a digit per pick (each **toggles**), then **Tab** |
| end of a multi-question dialog | Return, for the "Submit answers" confirm |
| a one-question dialog | no trailing Return — it hides the Submit tab, and a stray Return would answer whatever came next |

### One answer at a time

There is one keyboard and one frontmost window, so `claude.question.answer`
serializes: focus and typing run together inside a single lock in
`daemon/src/focus.js`, and `claude.session.focus` takes the same lock. Nothing
else enforces it — the hub handles every socket frame in its own task, so two
answers arriving together would otherwise interleave their keystrokes into
whichever window was in front, which across sessions means digits landing in
the wrong terminal. A raise slipping between an answer's focus and its
keystrokes is the same bug, hence the shared lock.

Answers do arrive in bursts. The device holds each answer for its undo window,
but starting a new one flushes the previous immediately — so answering three
cards quickly sends three answers back to back, and only the last waits.

An answer that is resolved while queued behind another — the terminal answered
it, or Esc killed it — is dropped rather than typed: the dialog it was meant
for is gone, and its keys would answer whatever replaced it.

**Return does not commit a multiSelect.** Inside the list it activates the row
under the cursor, so a Return there toggles option 1 again — which is exactly
what a device answer used to do, twice, instead of submitting. The list's own
move-on control is a button below the options labelled "Next" (or "Submit" on
the last question), reachable only by walking the cursor past every option and
the "Other" row. Tab does not depend on where the cursor is: a multi-question
dialog draws a tab strip ending in a `✓ Submit` tab and hints "Tab/Arrow keys
to navigate", and that Submit tab is the "Review your answers" screen the
trailing Return confirms.

The device holds every answer locally and sends the whole set at once, so a
dialog is never left part-answered by a walk the user abandoned — and so any
answer stays editable until the last press. The daemon validates the set
(one pick per single-select question, in-range indices, no repeats) before
touching the keyboard, for the same reason.

`claude.question.answer` reports how far it got:

| Result | Meaning |
|---|---|
| `accepted:true, viaKeyboard:true` | the whole sequence was typed into the terminal; `keys` is what was sent |
| `accepted:true, viaKeyboard:false` | window focused, but macOS would not let us type — the user answers it |
| `accepted:false` | no window to focus (background agent, or no registry entry), or the answer set did not match the ask; `reason` says which |

Focus uses Claude Code's own session registry: `~/.claude/sessions/<pid>.json`
maps `sessionId → pid`, `ps` maps pid → tty, and Terminal.app's AppleScript
dictionary maps tty → tab. Other emulators can only be raised as an app.
Typing additionally needs Automation → System Events; when macOS denies it we
say so rather than looking for another way in.

## Usage comes from Claude Code itself

`claude -p "/usage"` runs the slash command locally and prints the real plan
figures — session and weekly percentages, reset times, and the "what's
contributing" breakdown. It performs no inference (zero model tokens) and with
`CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` writes no transcript, so the daemon polls it
once a minute and parses the text. Nothing is estimated and no denominator is
invented.

State machine (daemon-side): `busy` while tool/response activity within 10 s;
`attention` when pending permission or waiting for user input; `celebrate` for
20 s after a Stop with no pending input, then `idle`; `idle` otherwise.

## Permission flow

1. Claude Code `PermissionRequest` hook POSTs to daemon `/hook/PermissionRequest`
   (hook timeout configured 60 s; daemon holds ≤55 s).
2. Daemon emits `claude.permission.request`; device auto-surfaces the screen.
3. Device sends `claude.permission.answer`; daemon responds to the held hook
   request with `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}`
   and emits `claude.permission.resolved`.
4. At 55 s with no answer: daemon responds `behavior:"ask"` (falls back to the
   terminal prompt — never auto-denies) and emits `resolved{timeout}`.

## Hardware note

nocturned only forwards allow-listed methods to the phone. `claude.*` requests
on real hardware require the one-arm patch in
`patches/nocturned-claude-forward.patch`. Phone→UI **events** need no nocturned
change (verbatim passthrough).
