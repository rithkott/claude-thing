# The `claude.*` relay

How Claude Mode reaches the Mac. The code is tracked in this directory — this
file is why it looks the way it does, and the traps that are not visible from
reading it.

The relay is a WebSocket **client** of the claude-thing daemon
(`ws://127.0.0.1:8790/ws`), not a server: one socket carries request dispatch,
event push and status heartbeats, and its liveness *is* the link state — no
extra port, no polling. Nothing about the existing music/Spotify surface
changes.

| File | Role |
|---|---|
| `Nocturne/Services/ClaudeRelayService.swift` | the socket: `call`, `onEvent`, `statusProvider`, reconnect, `packJSON` |
| `Nocturne/Services/RPCManager.swift` | routes `claude.*` off the device into `call`, broadcasts relay events back out |
| `Nocturne/NocturneApp.swift` | constructs it, supplies the Bluetooth summary, starts it |
| `Nocturne/Services/SessionStore.swift` | `claudeRelayEnabled`, persisted |
| `Nocturne/Views/Pages/SettingsView.swift` | the "Claude Mode" section |

Until 2.0.0 these were an anchored patch script run against a fresh connector
clone. The app is no longer in the open repo, so the tree is vendored and they
are ordinary source — see [README.md](README.md).

## Things that are not obvious from the code

**`packJSON`, not `RPCValueBridge.pack`, on both claude paths.**
`JSONSerialization` hands back `NSNumber`, and on Darwin an `NSNumber` holding
0 or 1 passes `as Bool`. Upstream `wrap()` tests `as Bool` before its `NSNumber`
arm, so every small count crossed Bluetooth as a boolean — a two-session list
arrived as `true`. `packJSON` tests `CFBooleanGetTypeID()` first and falls back
to `RPCValueBridge.pack` for anything it does not recognise. `spotify.*` packing
is deliberately left on the upstream path.

**`claudeRelay` has no default argument in `RPCManager.init`.** Default
arguments are evaluated outside the actor and `ClaudeRelayService` is
`@MainActor`, so `claudeRelay: ClaudeRelayService = ClaudeRelayService()` does
not compile. It is injected instead.

**Both captures in `statusProvider` are weak.** `rpcManager` owns the relay,
which owns this closure; a strong capture of either side is a cycle that keeps
the whole graph alive.

**The toggle defaults to on.** This build exists to relay Claude Code, so a
fresh install should relay without a trip to Settings. `object(forKey:)` is what
distinguishes "never set" from "set to false" — `bool(forKey:)` cannot.

**Reconnect is quiet.** The daemon is optional; a failed dial backs off
`1s → 30s` and never surfaces an error. `stop()` is called first so a dead task
is not left receiving.

**Calls time out at 30 s** and resume their continuation with an error rather
than leaking it — the device's own request would otherwise hang forever.

Optionally call `claudeRelay.pushStatus()` from the Bluetooth connect/disconnect
handlers so the daemon's webpage updates immediately instead of on the next 10 s
tick.

## Verification on hardware

1. Enable the toggle; the daemon's webpage (`http://127.0.0.1:8790`) flips
   *Nocturne connector* to **relaying** and fills in the Bluetooth rows.
2. On the device, hold preset 1 + preset 4 for one second → Claude Mode; the
   session list should populate. 4.1 forwards unknown methods to the registered
   companion with no allow-list, so this needs no daemon patch; `"No active app
   session"` back means no companion is registered (another phone may have
   stolen the route with a later `app.ready`).
3. Trigger a permission prompt in a Claude Code session on the Mac → it appears
   fullscreen on the device; preset 1 allows, preset 4 denies, back skips.
