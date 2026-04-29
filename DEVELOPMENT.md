# Branches Explorer — Developer Guide

Internal notes for maintaining, building and shipping the
`vyer-eco.ecocloud-branches-explorer` VS Code extension.
This file is for **us** (not end users) — keep it current after every change.

---

## Layout

```
Src/Tools/VSCodeBranchesExplorer/
├── package.json           # manifest: commands, views, menus, version
├── src/
│   ├── extension.ts       # everything: providers, items, activate()
│   └── git.d.ts           # vendored vscode.git API typings
├── media/icon.png         # marketplace icon (Vyer "Y", 16703 bytes)
├── docs/                  # screenshots used by README (not rendered today)
├── README.md              # marketplace description (end-user facing)
├── DEVELOPMENT.md         # this file
└── dist/extension.js      # esbuild output (~32 KB), gitignored
```

The folder is currently **untracked** on branch `VSCodeExtensions`
(`?? Src/Tools/VSCodeBranchesExplorer/`). Nothing has been pushed.

## Tech stack

- VS Code Extension API `^1.90.0` (we run on VS Code 1.117.0 / Linux)
- TypeScript, bundled with **esbuild** (no webpack)
- `vscode.git` API v1 — typings vendored at `src/git.d.ts`
- Packaged with `@vscode/vsce`

No tests. No CI. Manual install loop.

## Build / package / install loop

Always run from the extension folder:

```bash
cd /home/irek/GIT/EcoCloud/Src/Tools/VSCodeBranchesExplorer

# 1. bump version in package.json (semver patch for fixes)
sed -i 's/"version": "X.Y.Z"/"version": "X.Y.W"/' package.json

# 2. build (esbuild bundles src/extension.ts -> dist/extension.js)
npm run build

# 3. package (use --no-rewrite-relative-links so README links survive)
npx vsce package --no-rewrite-relative-links \
    --out ecocloud-branches-explorer-X.Y.W.vsix
# vsce will prompt about missing LICENSE — answer `y`.

# 4. install into the running VS Code
code --install-extension ecocloud-branches-explorer-X.Y.W.vsix --force

# 5. user must reload the window (Ctrl+Shift+P → "Developer: Reload Window")
```

`npm run build` runs:
`esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --target=node18`

`vsce package` invokes `vscode:prepublish` which re-runs `npm run build`,
so step 2 is technically redundant — but keep it; it surfaces TS errors early.

Installed copy lives at:
`~/.vscode/extensions/vyer-eco.ecocloud-branches-explorer-X.Y.W/`

Useful for inspecting what actually shipped (e.g. README processing,
icon size, bundled docs).

## Git API gotchas (learned the hard way)

- `repo.state.refs` is **often empty** on newer vscode.git — refs are
  fetched lazily via async `repo.getRefs()`. Never trust `state.refs.length`
  as a freshness signal.
- `repo.state.onDidChange` fires for many but not all mutations. We treat
  every fire as "invalidate caches and re-query".
- `git.onDidOpenRepository` / `onDidCloseRepository` must both be wired,
  including for repos already present at activation time
  (loop `git.repositories` once on startup).
- The `RefType` enum in `git.d.ts` is a `const enum`; esbuild cannot inline
  it across files, so we redefine the constants locally:
  `const RefType = { Head: 0, RemoteHead: 1, Tag: 2 } as const;`

## Architecture cheat sheet

`extension.ts` contains:

- `RefItem`, `RepoItem`, `RemoteGroupItem`, `FolderItem` — `TreeItem`s.
  `RefItem` deliberately has **no `command`** so a single click only selects
  (double-click / context menu performs actions).
- `RefsTreeProvider` — implements `TreeDataProvider`; one instance per
  section (local / remote / tag).
  - Caches keyed by `repo.rootUri.fsPath`:
    `refsCache`, `refsInFlight`, `aheadBehind`, `commitInfo`, `lastStateSig`.
  - `refresh()` clears caches then fires `_onDidChange` (debounced 50 ms).
  - `r.state.onDidChange` handler also clears that repo's caches.
  - `viewMode: 'tree' | 'list'`; tree mode groups by `/` segments via
    `buildTreeLevel` and `FolderItem`.
- `activate()`:
  - Waits for `vscode.git` extension to activate.
  - Creates 3 providers + 3 `TreeView`s (`gitBranchesExplorer.local`,
    `…remote`, `…tags`).
  - Registers commands listed below.
  - Persists view mode in `context.globalState` and mirrors it via
    `setContext('gitBranchesExplorer.mode.<kind>', 'tree'|'list')`
    so menu `when` clauses can show the right toggle button.

## Commands (must exist in both `package.json` and `extension.ts`)

| Command id | Purpose |
|---|---|
| `gitBranchesExplorer.refresh` | Manual refresh button — clears caches in all 3 providers |
| `gitBranchesExplorer.local.viewAsTree` / `…viewAsList` | Toggle local view mode |
| `gitBranchesExplorer.remote.viewAsTree` / `…viewAsList` | Toggle remote view mode |
| `gitBranchesExplorer.tags.viewAsTree` / `…viewAsList` | Toggle tags view mode |
| `gitBranchesExplorer.filterLocal` / `…filterRemote` / `…filterTags` | Per-section filter input ($(search) icon) |
| `gitBranchesExplorer.checkout`, `.delete`, `.create`, … | Branch ops invoked from context menu |

Adding a command requires three places: `package.json` `contributes.commands`,
`contributes.menus` (view/title or view/item/context), and
`vscode.commands.registerCommand(...)` in `activate()`.

## Refresh contract (current)

- `refresh()` — fires `_onDidChange` (debounced 50 ms). Does **not** touch caches.
- `forceRefresh()` — clears caches, then `refresh()`. Use for manual refresh
  command, repo open, and the file-system watcher.
- `state.onDidChange` per repo — guarded by `stateSig` (HEAD name/commit,
  ahead/behind, refs.length, remotes.length). If sig unchanged → no-op.
  This guard is essential: vscode.git fires state events very frequently
  (working-tree polls etc.) and without it we infinite-loop:
  `refresh → getChildren → getRefs → state event → refresh`.
- `git.onDidChangeState` is **deliberately not subscribed** — it fires far
  too often and would defeat the per-repo guard.
- A `FileSystemWatcher` on `.git/{HEAD,packed-refs,refs/**}` per repo
  catches external `git branch`, `git tag`, `git push --delete` etc. that
  vscode.git's state event misses (because `state.refs` is often empty,
  refs.length never bumps).

## Versioning

- Semver. Patch bump for fixes, minor for new commands or visible UX.
- The version in `package.json` is the only source of truth — VS Code
  uses it both for the installed folder name and for "update available"
  detection when reinstalling the same vsix.
- Always reinstall with `--force` when shipping the same major.minor.

## Known limitations

- No publisher account / Marketplace listing. Distribution is sideloaded
  vsix only.
- README screenshots embedded as base64 data URIs are blocked by the
  Extension Details webview CSP. Relative paths work only after a
  Marketplace publish (vsce rewrites them) or a public GitHub URL.
  v0.4.5 removed the screenshot section as a workaround.
- No LICENSE file — `vsce` warns on every package; we accept and continue.

## Quick verification after install

1. Reload window.
2. Open Source Control view — three sections must appear.
3. Create a branch from terminal (`git branch test-foo`) → it should
   show up within ~50–500 ms without manual refresh.
4. Click the refresh icon — caches drop, list re-renders.
5. Toggle tree/list via title-bar icons — persists across reloads.
