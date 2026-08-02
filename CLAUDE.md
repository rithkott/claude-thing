# claude-thing

## Release process (mandatory for all new features)

All feature work happens in a git worktree on a feature branch, and lands on `main` via a GitHub PR only after claiming a version in `RELEASES.md`. Never commit feature work directly on `main`.

### 1. Start a feature

```sh
git fetch origin
git worktree add ../claude-thing-<slug> -b feat/<slug> origin/main
```

- `<slug>` is a short kebab-case name (e.g. `feat/volume-knob`).
- One worktree per feature. Parallel features = parallel worktrees, each isolated.
- Hotfixes use the same flow with a `fix/<slug>` branch.

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

### 5. Tag the release

After the PR merges (tags are the bare version — no `v` prefix):

```sh
git fetch origin
git tag X.Y.Z origin/main
git push origin X.Y.Z
gh release create X.Y.Z --generate-notes --title "X.Y.Z — <slug>"
```

Every release ships the current DMG and firmware zip as assets — no asset-less releases:

```sh
# firmware: always rebuilt (device-app may have changed)
npm --prefix device-app run build
node scripts/inject-firmware.js --zip ~/Downloads/nocturne_image_v<ver>.zip \
  --nocturned dist/nocturned --out dist/nocturne_v<ver>_claude_X.Y.Z.zip

# DMG: rebuild with scripts/build-connector-dmg.sh ONLY if patches/, mac/, or
# the connector relay changed since the last DMG; otherwise reuse dist/Nocturne-claude-*.dmg

gh release upload X.Y.Z dist/nocturne_v<ver>_claude_X.Y.Z.zip dist/Nocturne-claude-*.dmg
```

Then refresh the local knowledge graph so the next feature starts current:

```sh
node .gitnexus/run.cjs analyze --pdg
```

### 6. Clean up

```sh
git worktree remove ../claude-thing-<slug>
git branch -D feat/<slug>
```

### Rules

- Every merge to `main` = exactly one version, one `RELEASES.md` row, one tag.
- Major version bumps happen only on explicit instruction from the user.
- Every GitHub release carries the latest DMG and firmware zip as downloadable assets.
- No direct commits to `main` except the automated parts of this flow.
- Multiple features in flight is the normal case; worktrees keep them independent, the ledger serializes them at merge time.
- GitNexus index artifacts (`.gitnexus/`, `AGENTS.md`, `.claude/skills/gitnexus/`) are gitignored and never pushed — they are rebuilt locally.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claude-thing** (6526 symbols, 13610 relationships, 161 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
