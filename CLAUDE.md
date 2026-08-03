# claude-thing

## Release process (mandatory for all new features)

All feature work happens in a git worktree on a feature branch, and lands on `main` via a GitHub PR only after claiming a version in `RELEASES.md`. Never commit feature work directly on `main`.

Two channels ship from `main`, both published by CI (`.github/workflows/`):

| Channel | Tag | GitHub | Cut by |
|---------|-----|--------|--------|
| **dev** | `X.Y.Z-dev` | prerelease | automatic, every merged PR |
| **production** | `X.Y.Z` | Latest | the `promote` workflow, only when the user asks |

Merging never touches production. `releases/latest` — what the README links to — stays on the last promoted build, so dev builds are invisible to anyone who did not go looking for them.

### 1. Start a feature

```sh
git fetch origin
git worktree add ../claude-thing-<slug> -b feat/<slug> origin/main
```

- `<slug>` is a short kebab-case name (e.g. `feat/volume-knob`).
- One worktree per feature. Parallel features = parallel worktrees, each isolated.
- Ordinary bug fixes use the same flow with a `fix/<slug>` branch — they ship to dev like everything else.
- `hotfix/<slug>` is the one branch prefix that goes straight to production, skipping dev. Reserve it for things that must reach users now; a PR labelled `prod` does the same.

### 2. Work

Commit normally inside the worktree. `main` stays clean and always releasable.

Consult GitNexus before every code change — see the GitNexus section at the bottom of this file. In short: `query` to find the flow, `context` on the symbol, `impact` before editing it, `detect_changes` before committing. Always pass `repo: "claude-thing"`.

### 3. Claim a version (only when the feature is done, right before merging)

```sh
git fetch origin && git rebase origin/main
```

Versions are `MAJOR.MINOR.PATCH`. Read `RELEASES.md`, take the highest existing version, and bump exactly one field:

| Change | Bump | Example |
|--------|------|---------|
| Bug fix, perf fix, docs | **patch** (third) | 1.16.4 → 1.16.5 |
| Feature addition, new capability | **minor** (second), patch resets to 0 | 1.16.4 → 1.17.0 |
| Anything else | **major** (first) — **only when the user explicitly asks for it**, never on your own judgement | 1.16.4 → 2.0.0 |

Append a row:

```
| X.Y.Z | YYYY-MM-DD | fix\|feature\|major | <slug> | <one-line summary> |
```

Commit it as `release: claim X.Y.Z — <slug>`.

Claiming happens last, not at feature start — unfinished features must never reserve versions. The `RELEASES.md` row is the claim mechanism: if two features race, the first PR to merge wins the version and the other branch gets a merge conflict on `RELEASES.md`, rebases, and takes the next one.

### 4. Merge via GitHub

```sh
git push -u origin feat/<slug>
gh pr create --fill
gh pr merge --squash --delete-branch
```

If the merge conflicts on `RELEASES.md`, someone else claimed that version first: rebase on `origin/main`, bump to the next free version, force-push, merge again.

### 5. Watch the dev release land

The merge fires `.github/workflows/release.yml`. Nothing to run by hand — it reads the top version out of `RELEASES.md`, builds the firmware zip (device app + cross-compiled `nocturned` injected into the stock Nocturne image) and the connector DMG, and publishes `X.Y.Z-dev` as a prerelease pinned to the merge commit. Tags are bare — no `v` prefix.

```sh
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh release view X.Y.Z-dev
```

Re-running the workflow for a version that already has a dev release replaces it; production releases are immutable and the workflow refuses to overwrite one.

Then refresh the local knowledge graph so the next feature starts current:

```sh
node .gitnexus/run.cjs analyze --pdg
```

### 6. Clean up

```sh
git worktree remove ../claude-thing-<slug>
git branch -D feat/<slug>
```

### 7. Promote to production (only when the user asks)

Production is a deliberate act, never a side effect of merging. Promotion re-publishes the assets that already shipped on dev, at the same commit — no rebuild, so what was tested is what ships.

```sh
gh workflow run promote.yml                        # newest dev prerelease
gh workflow run promote.yml -f dev_tag=X.Y.Z-dev   # a specific one
```

`X.Y.Z-dev` becomes `X.Y.Z`, marked Latest. Dev versions in between (1.18.0-dev, 1.18.1-dev …) stay prereleases forever — they were never production, and their numbers are not reused.

### Rules

- Every merge to `main` = exactly one version, one `RELEASES.md` row, one dev prerelease.
- Production releases are cut only on explicit instruction from the user, via `promote.yml` or a `hotfix/` branch.
- Major version bumps happen only on explicit instruction from the user.
- Every GitHub release carries the latest DMG and firmware zip as downloadable assets.
- A published production version is immutable: never retag or re-release `X.Y.Z`, claim the next version instead.
- No direct commits to `main` except the automated parts of this flow.
- Multiple features in flight is the normal case; worktrees keep them independent, the ledger serializes them at merge time.
- GitNexus index artifacts (`.gitnexus/`, `AGENTS.md`, `.claude/skills/gitnexus/`) are gitignored and never pushed — they are rebuilt locally.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claude-thing** (7108 symbols, 15028 relationships, 197 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user. For unified PDG impact, add `mode: "pdg"` with optional `line: <N>` — it returns statement-level `affectedStatements` over CDG + REACHING_DEF and inter-procedural symbols in `interproceduralByDepth`/`byDepth`; no-layer/degraded PDG results are UNKNOWN-risk notes (`--pdg` layer).
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).
- For control/data dependence, `pdg_query({mode: "controls", target: "fileOrSymbol"})` answers "under what condition does X run?" (CDG, incl. guard clauses) and `pdg_query({mode: "flows", target, variable})` traces "where does variable Y flow?" (REACHING_DEF). `--pdg` layer.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/claude-thing/context` | Codebase overview, check index freshness |
| `gitnexus://repo/claude-thing/clusters` | All functional areas |
| `gitnexus://repo/claude-thing/processes` | All execution flows |
| `gitnexus://repo/claude-thing/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
