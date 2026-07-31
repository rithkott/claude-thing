# claude-thing

## Release process (mandatory for all new features)

All feature work happens in a git worktree on a feature branch, and lands on `main` via a GitHub PR only after claiming a release number in `RELEASES.md`. Never commit feature work directly on `main`.

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

### 3. Claim a release number (only when the feature is done, right before merging)

```sh
git fetch origin && git rebase origin/main
```

Then read `RELEASES.md`, take N = highest existing number + 1, and append a row:

```
| rN | YYYY-MM-DD | <slug> | <one-line summary> |
```

Commit it as `release: claim rN — <slug>`.

Claiming happens last, not at feature start — unfinished features must never reserve numbers. The `RELEASES.md` row is the claim mechanism: if two features race, the first PR to merge wins the number and the other branch gets a merge conflict on `RELEASES.md`, rebases, and takes the next number.

### 4. Merge via GitHub

```sh
git push -u origin feat/<slug>
gh pr create --fill
gh pr merge --squash --delete-branch
```

If the merge conflicts on `RELEASES.md`, someone else claimed rN first: rebase on `origin/main`, bump to the next free number, force-push, merge again.

### 5. Tag the release

After the PR merges:

```sh
git fetch origin
git tag rN origin/main
git push origin rN
gh release create rN --generate-notes
```

Every release ships the current DMG and firmware zip as assets — no asset-less releases:

```sh
# firmware: always rebuilt (device-app may have changed)
npm --prefix device-app run build
node scripts/inject-firmware.js --zip ~/Downloads/nocturne_image_v<ver>.zip \
  --nocturned dist/nocturned --out dist/nocturne_v<ver>_claude_rN.zip

# DMG: rebuild with scripts/build-connector-dmg.sh ONLY if patches/, mac/, or
# the connector relay changed since the last DMG; otherwise reuse dist/Nocturne-claude-*.dmg

gh release upload rN dist/nocturne_v<ver>_claude_rN.zip dist/Nocturne-claude-*.dmg
```

### 6. Clean up

```sh
git worktree remove ../claude-thing-<slug>
git branch -D feat/<slug>
```

### Rules

- Every merge to `main` = exactly one release number, one `RELEASES.md` row, one tag.
- Every GitHub release carries the latest DMG and firmware zip as downloadable assets.
- No direct commits to `main` except the automated parts of this flow.
- Multiple features in flight is the normal case; worktrees keep them independent, the ledger serializes them at merge time.
