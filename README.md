# Branches Explorer (VS Code Extension)

Three sections in the **Source Control** view:

- **Local Branches** — `refs/heads`. HEAD marked with ✓. Shows `↑ahead / ↓behind` against upstream.
- **Remote Branches** — `refs/remotes/*`. Grouped by remote when more than one is configured.
- **Tags** — `refs/tags`.

Multi-repo workspaces show repositories as parent nodes.

## Highlights

- **Inline action icons** on hover (checkout / delete / push / pull) per ref.
- **Quick Switch** Quick Pick across all local + remote branches and tags. Default keybinding `Ctrl+Alt+B` (`Cmd+Alt+B` on macOS).
- **Cherry-pick** from any branch, remote branch or tag (uses `Repository.cherryPick` if available, falls back to `git.run(['cherry-pick', …])`).
- **Per-view filter** shown in the tree's `message` area.
- **Lazy ahead/behind** for non-current local branches via `Repository.getBranch()`, cached per repo, invalidated on state change.
- **Last-commit author + relative date** appended to each row's description, fetched lazily via `Repository.getCommit()`, keyed by commit hash (cache survives state changes).
- **Group remotes** automatically when more than one is configured; per-group fetch.

## Title-bar actions

| View | Actions |
|---|---|
| Local Branches  | Create Branch • Quick Switch • Filter • Refresh |
| Remote Branches | Fetch (all) • Filter • Refresh |
| Tags            | Create Tag • Filter • Refresh |

## Context menu

| Item | Inline | Menu |
|---|---|---|
| Local branch (other) | Checkout, Delete | Checkout • Merge • Rebase • Cherry-pick • Publish • Rename • Delete • Copy Name |
| Local branch (current) | Push, Pull | Push • Publish • Pull • Rename • Copy Name |
| Remote group | Fetch | Fetch (this remote) |
| Remote branch | Checkout, Delete on Remote | Checkout (tracking) • Merge • Rebase • Cherry-pick • Delete on Remote • Copy Name |
| Tag | Checkout, Delete | Checkout • Cherry-pick • Push Tag • Delete (Local) • Delete (Remote) • Copy Name |

## Architecture

- Contributes three views to the built-in `scm` view container.
- Uses official Git extension API (`vscode.git`, version 1) — no shelling out.
- One `TreeDataProvider` per view, filtering `Repository.state.refs` by `RefType`.
- Refresh on `Repository.state.onDidChange` plus toolbar actions.
- Optional low-level `Repository.git.run()` escape hatch for operations not exposed by the typed API (used as fallback for cherry-pick).

## Develop

```bash
cd Src/Tools/VSCodeBranchesExplorer
npm install
npm run build       # bundles to dist/extension.js
npm run compile     # type-check only
# F5 in VS Code → "Run Extension"
```

Package as `.vsix`:

```bash
npx @vscode/vsce package
```

## Roadmap

- Worktree awareness (when `vscode.git` exposes it)
- Reset HEAD (soft / mixed / hard) on a selected ref
- Show last-commit author + date as item description (cached)
- Compare two branches (open `git.diff` view)
