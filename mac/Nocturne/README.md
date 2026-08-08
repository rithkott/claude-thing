# Nocturne.app — vendored

The macOS connector, vendored rather than fetched. `scripts/build-connector-dmg.sh`
builds this tree directly; nothing is cloned or patched at build time.

## Where it came from

`macos/` of [usenocturne/nocturne-connector](https://github.com/usenocturne/nocturne-connector)
at commit `41f4d048912d3e9a7e664ad7b9a2526c323f2c55`, plus that repo's
`LICENSE` (Apache-2.0) alongside it.

## Why it is vendored and not fetched

The app is no longer in the open repo. Commit `ae0fb209` ("feat: protocol v2
changes", 2026-07-29) deleted all 113 `macos/` files; `macos/` 404s at `main`
and at tag `v2.1.0`, and resolves only at `41f4d048…`. There are zero
Swift/Xcode paths on any of the five branches, no `.gitmodules`, and all four
active forks synced past the removal. The shipped DMG is the same codebase with
a `MacOS` class-name prefix, built somewhere private.

So the pin was not a version choice — it was the last commit that still had an
app to fetch, and a build that clones it depends on a tree upstream may prune at
any time. Vendoring makes the source we ship the source you can read.

`docs/rebase-4.1/NOTES.md` §5 records the commands that establish all of the
above; don't re-derive it.

## What we changed

`Nocturne/Services/ClaudeRelayService.swift` is ours — it dials the claude-thing
daemon on `127.0.0.1:8790` and bridges `claude.*` in both directions. Its call
sites were an anchored patch script until 2.0.0 and are now plain source:

| File | Change |
|---|---|
| `Nocturne/NocturneApp.swift` | constructs `ClaudeRelayService`, wires `statusProvider`, calls `start()` |
| `Nocturne/Services/RPCManager.swift` | holds the relay, forwards its events to paired devices, routes `claude.*` calls |
| `Nocturne/Services/SessionStore.swift` | `claudeRelayEnabled`, persisted, defaults on |
| `Nocturne/Views/Pages/SettingsView.swift` | the "Claude Mode" section and its toggle |

Everything else is upstream, unmodified.

The Xcode project uses a file-system-synchronized root group
(`objectVersion = 77`), so new files under `Nocturne/` are picked up without
touching `project.pbxproj`.

## Licensing

Upstream is Apache-2.0 (`LICENSE` in this directory); claude-thing is GPL-3.0.
Apache-2.0 is one-way compatible with GPL-3.0, so the combined work ships under
the GPL while this directory keeps its own licence and attribution.
