import * as vscode from 'vscode';
import type { API as GitAPI, Branch, Commit, GitExtension, Ref, Repository } from './git';

// Numeric RefType constants from vscode.git API (Head=0, RemoteHead=1, Tag=2).
// Defined locally because the .d.ts const enum cannot be inlined by esbuild.
const RefType = { Head: 0, RemoteHead: 1, Tag: 2 } as const;

type RefKind = 'local' | 'remote' | 'tag';
type ViewMode = 'tree' | 'list';

/** Compute path used for tree-grouping (strips remote prefix for remote refs). */
function refPath(ref: Ref, kind: RefKind): string {
    const name = ref.name ?? '';
    if (kind === 'remote' && ref.remote && name.startsWith(ref.remote + '/')) {
        return name.substring(ref.remote.length + 1);
    }
    return name;
}

interface CommitInfo {
    author?: string;
    date?: Date;
}

/** Format Date as relative time, e.g. "3 hours ago", "5 days ago". */
function formatRelative(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) { return `${sec}s ago`; }
    const min = Math.round(sec / 60);
    if (min < 60) { return `${min}m ago`; }
    const hr = Math.round(min / 60);
    if (hr < 24) { return `${hr}h ago`; }
    const day = Math.round(hr / 24);
    if (day < 30) { return `${day}d ago`; }
    const mon = Math.round(day / 30);
    if (mon < 12) { return `${mon}mo ago`; }
    return `${Math.round(mon / 12)}y ago`;
}

// ---------- Tree items ----------

class RefItem extends vscode.TreeItem {
    constructor(
        public readonly repo: Repository,
        public readonly ref: Ref,
        public readonly kind: RefKind,
        isCurrent: boolean,
        ahead?: number,
        behind?: number,
        commit?: CommitInfo,
    ) {
        const name = ref.name ?? '<unknown>';
        // For remote branches, drop the "<remote>/" prefix when shown under a remote group.
        const label = kind === 'remote' && ref.remote && name.startsWith(ref.remote + '/')
            ? name.substring(ref.remote.length + 1)
            : name;

        // Render the active branch with the highlight color so it stands out
        // (TreeItem has no native bold). We achieve this via a FileDecorationProvider
        // keyed on a synthetic resourceUri (see CurrentBranchDecorationProvider).
        super(label, vscode.TreeItemCollapsibleState.None);
        if (isCurrent) {
            // Synthetic uri the FileDecorationProvider will recognise.
            this.resourceUri = vscode.Uri.parse(`git-branch://current/${encodeURIComponent(name)}`);
        }

        this.contextValue =
            kind === 'local' ? (isCurrent ? 'localBranch.current' : 'localBranch') :
                kind === 'remote' ? 'remoteBranch' : 'tag';

        this.iconPath = new vscode.ThemeIcon(
            kind === 'tag' ? 'tag' :
                kind === 'remote' ? 'cloud' :
                    isCurrent ? 'check' : 'git-branch'
        );

        const parts: string[] = [];
        if (ref.commit) { parts.push(ref.commit.substring(0, 7)); }
        if (isCurrent) { parts.push('current'); }
        if (typeof ahead === 'number' && ahead > 0) { parts.push(`↑${ahead}`); }
        if (typeof behind === 'number' && behind > 0) { parts.push(`↓${behind}`); }
        if (commit?.author) { parts.push(commit.author); }
        if (commit?.date) { parts.push(formatRelative(commit.date)); }
        this.description = parts.join(' • ');

        const tooltipLines: string[] = [name];
        if (ref.commit) { tooltipLines.push(ref.commit); }
        if (commit?.author) { tooltipLines.push(`Author: ${commit.author}`); }
        if (commit?.date) { tooltipLines.push(`Date: ${commit.date.toISOString()}`); }
        this.tooltip = tooltipLines.join('\n');
    }
}

class RepoItem extends vscode.TreeItem {
    constructor(public readonly repo: Repository) {
        super(
            vscode.workspace.asRelativePath(repo.rootUri, false) || repo.rootUri.fsPath,
            vscode.TreeItemCollapsibleState.Expanded
        );
        this.iconPath = new vscode.ThemeIcon('repo');
        this.contextValue = 'repository';
    }
}

class RemoteGroupItem extends vscode.TreeItem {
    constructor(public readonly repo: Repository, public readonly remoteName: string, count: number) {
        super(remoteName, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('cloud');
        this.description = `${count} branch${count === 1 ? '' : 'es'}`;
        this.contextValue = 'remoteGroup';
    }
}

class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly repo: Repository,
        public readonly kind: RefKind,
        public readonly path: string,
        public readonly remote: string | undefined,
        count: number,
    ) {
        super(path.split('/').pop() ?? path, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('folder');
        this.description = `${count}`;
        this.contextValue = 'refFolder';
        this.tooltip = path;
    }
}

type Node = RepoItem | RemoteGroupItem | FolderItem | RefItem;

// ---------- Tree provider ----------

class RefsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private readonly disposables: vscode.Disposable[] = [];
    private filter = '';
    /** Cache of ahead/behind per repo/branch, populated lazily. */
    private aheadBehind = new Map<string, Map<string, { ahead?: number; behind?: number }>>();
    /** Cache of last commit info per repo/commit-hash, populated lazily. */
    private commitInfo = new Map<string, Map<string, CommitInfo>>();
    private commitInfoInFlight = new Map<string, Set<string>>();
    /** Cache of refs per repo (newer vscode.git API requires async getRefs()). */
    private refsCache = new Map<string, Ref[]>();
    private refsInFlight = new Map<string, Promise<Ref[]>>();
    /** Last-seen state signature per repo, used to ignore no-op state.onDidChange events. */
    private lastStateSig = new Map<string, string>();
    private aheadBehindInFlight = new Map<string, Set<string>>();
    private refreshTimer: NodeJS.Timeout | undefined;
    private viewMode: ViewMode = 'tree';

    setViewMode(mode: ViewMode): void {
        if (this.viewMode === mode) { return; }
        this.viewMode = mode;
        this.refresh();
    }

    get currentViewMode(): ViewMode { return this.viewMode; }

    private repoKey(r: Repository): string { return r.rootUri.fsPath; }

    private stateSig(r: Repository): string {
        const head = r.state.HEAD;
        // On newer vscode.git state.refs is always [] (deprecated); only use it as
        // a signal on older builds where getRefs() doesn't exist yet.
        const refsLen = typeof (r as any).getRefs === 'function' ? -1 : r.state.refs.length;
        return [
            head?.name ?? '',
            head?.commit ?? '',
            head?.ahead ?? -1,
            head?.behind ?? -1,
            refsLen,
            r.state.remotes.length,
        ].join('|');
    }

    constructor(private readonly git: GitAPI, private readonly kind: RefKind) {
        const wire = (r: Repository) => {
            const key = this.repoKey(r);
            this.lastStateSig.set(key, this.stateSig(r));
            this.disposables.push(r.state.onDidChange(() => {
                // vscode.git fires state events constantly (working tree polls etc).
                // Only invalidate caches if our composite signature actually changed,
                // otherwise we loop: refresh -> getChildren -> getRefs -> state event.
                const sig = this.stateSig(r);
                if (this.lastStateSig.get(key) === sig) {
                    return;
                }
                this.lastStateSig.set(key, sig);
                this.aheadBehind.delete(key);
                this.refsCache.delete(key);
                this.refresh();
            }));
        };
        git.repositories.forEach(wire);
        this.disposables.push(git.onDidOpenRepository(r => { wire(r); this.forceRefresh(); }));
        this.disposables.push(git.onDidCloseRepository(r => {
            this.refsCache.delete(this.repoKey(r));
            this.aheadBehind.delete(this.repoKey(r));
            this.refresh();
        }));
        // Note: do NOT subscribe to git.onDidChangeState — it fires very frequently
        // and would defeat the per-repo signature guard above.
    }

    /** Drop all cached refs/branch info for every known repo. */
    private invalidateAllCaches(): void {
        this.refsCache.clear();
        this.aheadBehind.clear();
        this.lastStateSig.clear();
    }

    /** Manual / programmatic refresh: drop caches and re-render. */
    forceRefresh(): void {
        this.invalidateAllCaches();
        this.refresh();
    }

    refresh(): void {
        // Coalesce rapid bursts of refresh() calls into a single fire.
        if (this.refreshTimer) { return; }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this._onDidChange.fire();
        }, 50);
    }

    setFilter(value: string): void {
        this.filter = value.trim().toLowerCase();
        this.refresh();
    }

    get currentFilter(): string { return this.filter; }

    getTreeItem(el: Node): vscode.TreeItem {
        return el;
    }

    async getChildren(element?: Node): Promise<Node[]> {
        const repos = this.git.repositories;
        if (repos.length === 0) {
            return [];
        }

        if (!element) {
            return repos.length === 1 ? await this.topLevelFor(repos[0]) : repos.map(r => new RepoItem(r));
        } else if (element instanceof RepoItem) {
            return await this.topLevelFor(element.repo);
        } else if (element instanceof RemoteGroupItem) {
            const items = await this.refsFor(element.repo);
            const filtered = items.filter(i =>
                i.ref.type === RefType.RemoteHead && i.ref.remote === element.remoteName);
            return this.viewMode === 'tree'
                ? this.buildTreeLevel(element.repo, filtered, '', element.remoteName)
                : filtered;
        } else if (element instanceof FolderItem) {
            const items = await this.refsFor(element.repo);
            const pool = element.remote
                ? items.filter(i => i.ref.remote === element.remote)
                : items;
            return this.buildTreeLevel(element.repo, pool, element.path + '/', element.remote);
        }
        return [];
    }

    /** For Remote view we group by remote; otherwise return refs directly (or as a tree). */
    private async topLevelFor(repo: Repository): Promise<Node[]> {
        const items = await this.refsFor(repo);
        if (this.kind === 'remote') {
            const remotes = new Map<string, number>();
            for (const i of items) {
                const remote = i.ref.remote ?? '(unknown)';
                remotes.set(remote, (remotes.get(remote) ?? 0) + 1);
            }
            if (remotes.size > 1) {
                return [...remotes.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, count]) => new RemoteGroupItem(repo, name, count));
            }
            // Single remote: flatten (still apply tree if enabled).
            const onlyRemote = [...remotes.keys()][0];
            return this.viewMode === 'tree'
                ? this.buildTreeLevel(repo, items, '', onlyRemote)
                : items;
        }
        return this.viewMode === 'tree'
            ? this.buildTreeLevel(repo, items, '', undefined)
            : items;
    }

    /** Group RefItems by the first path segment after `prefix`, emitting folders + leaves. */
    private buildTreeLevel(repo: Repository, items: RefItem[], prefix: string, remote: string | undefined): Node[] {
        const groups = new Map<string, RefItem[]>();
        for (const it of items) {
            const path = refPath(it.ref, this.kind);
            if (prefix && !path.startsWith(prefix)) { continue; }
            const rest = path.substring(prefix.length);
            if (!rest) { continue; }
            const slash = rest.indexOf('/');
            const seg = slash === -1 ? rest : rest.substring(0, slash);
            const arr = groups.get(seg) ?? [];
            arr.push(it);
            groups.set(seg, arr);
        }
        const result: Node[] = [];
        for (const [seg, arr] of groups) {
            const fullPath = prefix + seg;
            const leaves = arr.filter(it => refPath(it.ref, this.kind) === fullPath);
            const hasSubs = arr.some(it => refPath(it.ref, this.kind) !== fullPath);
            if (hasSubs) {
                result.push(new FolderItem(repo, this.kind, fullPath, remote, arr.length));
            }
            for (const leaf of leaves) {
                // Override label to the last segment in tree view.
                leaf.label = seg;
                result.push(leaf);
            }
        }
        result.sort((a, b) => {
            const af = a instanceof FolderItem ? 0 : 1;
            const bf = b instanceof FolderItem ? 0 : 1;
            if (af !== bf) { return af - bf; }
            return String(a.label ?? '').localeCompare(String(b.label ?? ''));
        });
        return result;
    }

    /** Public so activate() can warm caches eagerly. */
    async warmRefs(repo: Repository): Promise<void> {
        await this.loadRefs(repo);
    }

    /** Fetch refs from cache (or kick off async load). May return [] on first call. */
    private async loadRefs(repo: Repository): Promise<Ref[]> {
        const key = this.repoKey(repo);
        const cached = this.refsCache.get(key);
        if (cached) { return cached; }

        // newer vscode.git API: getRefs() — preferred, returns full list incl. tags
        if (typeof repo.getRefs === 'function') {
            let pending = this.refsInFlight.get(key);
            if (!pending) {
                pending = repo.getRefs()
                    .then(list => {
                        this.refsCache.set(key, list);
                        return list;
                    })
                    .catch(() => [])
                    .finally(() => { this.refsInFlight.delete(key); });
                this.refsInFlight.set(key, pending);
            }
            return await pending;
        }

        // Fallback for older vscode.git: state.refs
        const list = repo.state.refs;
        this.refsCache.set(key, list);
        return list;
    }

    private async refsFor(repo: Repository): Promise<RefItem[]> {
        const head = repo.state.HEAD;
        const headName = head?.name;
        const wantedType =
            this.kind === 'local' ? RefType.Head :
                this.kind === 'remote' ? RefType.RemoteHead : RefType.Tag;

        const key = this.repoKey(repo);
        const cache = this.aheadBehind.get(key);
        const commitCache = this.commitInfo.get(key);

        const allRefs = await this.loadRefs(repo);
        const refs = allRefs
            .filter(r => r.type === wantedType && r.name)
            .filter(r => !this.filter || r.name!.toLowerCase().includes(this.filter))
            .sort((a, b) => a.name!.localeCompare(b.name!));

        // Schedule async fill of ahead/behind for local branches (only ones not in cache).
        if (this.kind === 'local') {
            this.scheduleAheadBehind(repo, refs.map(r => r.name!));
        }
        // Schedule async fill of last-commit info for every visible ref with a known commit.
        const commitHashes = refs.map(r => r.commit).filter((c): c is string => !!c);
        this.scheduleCommitInfo(repo, commitHashes);

        return refs.map(r => {
            const isCurrent = this.kind === 'local' && r.name === headName;
            let ahead: number | undefined;
            let behind: number | undefined;
            if (this.kind === 'local') {
                if (isCurrent) { ahead = head?.ahead; behind = head?.behind; }
                else {
                    const c = cache?.get(r.name!);
                    ahead = c?.ahead;
                    behind = c?.behind;
                }
            }
            const commit = r.commit ? commitCache?.get(r.commit) : undefined;
            return new RefItem(repo, r, this.kind, isCurrent, ahead, behind, commit);
        });
    }

    private scheduleAheadBehind(repo: Repository, names: string[]): void {
        const key = this.repoKey(repo);
        let cache = this.aheadBehind.get(key);
        if (!cache) { cache = new Map(); this.aheadBehind.set(key, cache); }
        let inflight = this.aheadBehindInFlight.get(key);
        if (!inflight) { inflight = new Set(); this.aheadBehindInFlight.set(key, inflight); }

        const toFetch = names.filter(n => !cache!.has(n) && !inflight!.has(n));
        if (toFetch.length === 0) { return; }
        toFetch.forEach(n => inflight!.add(n));

        let anyNew = false;
        void Promise.all(toFetch.map(async n => {
            try {
                const b: Branch = await repo.getBranch(n);
                cache!.set(n, { ahead: b.ahead, behind: b.behind });
                if (b.ahead !== undefined || b.behind !== undefined) { anyNew = true; }
            } catch {
                cache!.set(n, {});
            } finally {
                inflight!.delete(n);
            }
        })).then(() => { if (anyNew) { this.refresh(); } });
    }

    private scheduleCommitInfo(repo: Repository, hashes: string[]): void {
        if (typeof repo.getCommit !== 'function') { return; }
        const key = this.repoKey(repo);
        let cache = this.commitInfo.get(key);
        if (!cache) { cache = new Map(); this.commitInfo.set(key, cache); }
        let inflight = this.commitInfoInFlight.get(key);
        if (!inflight) { inflight = new Set(); this.commitInfoInFlight.set(key, inflight); }

        const unique = Array.from(new Set(hashes));
        const toFetch = unique.filter(h => !cache!.has(h) && !inflight!.has(h));
        if (toFetch.length === 0) { return; }
        toFetch.forEach(h => inflight!.add(h));

        // Fire-and-forget; refresh once batch completes.
        // Limit concurrency to avoid spawning N git processes at once.
        const concurrency = 4;
        const queue = [...toFetch];
        let anyNew = false;
        const worker = async () => {
            while (queue.length > 0) {
                const h = queue.shift()!;
                try {
                    const c: Commit = await repo.getCommit(h);
                    cache!.set(h, {
                        author: c.authorName,
                        date: c.authorDate ?? c.commitDate,
                    });
                    if (c.authorName || c.authorDate || c.commitDate) { anyNew = true; }
                } catch {
                    cache!.set(h, {});
                } finally {
                    inflight!.delete(h);
                }
            }
        };
        const workers = Array.from({ length: Math.min(concurrency, toFetch.length) }, () => worker());
        void Promise.all(workers).then(() => { if (anyNew) { this.refresh(); } });
    }

    dispose(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = undefined; }
        this.disposables.forEach(d => d.dispose());
    }
}

// ---------- Helpers ----------

async function getGitAPI(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) { return undefined; }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports.enabled) { return undefined; }
    return exports.getAPI(1);
}

async function pickRepository(git: GitAPI): Promise<Repository | undefined> {
    if (git.repositories.length === 0) { return undefined; }
    if (git.repositories.length === 1) { return git.repositories[0]; }
    const pick = await vscode.window.showQuickPick(
        git.repositories.map(r => ({
            label: vscode.workspace.asRelativePath(r.rootUri, false) || r.rootUri.fsPath,
            repo: r,
        })),
        { placeHolder: 'Select repository' }
    );
    return pick?.repo;
}

async function pickRemote(repo: Repository): Promise<string | undefined> {
    const remotes = repo.state.remotes;
    if (remotes.length === 0) {
        vscode.window.showErrorMessage('No remotes configured.');
        return undefined;
    }
    if (remotes.length === 1) { return remotes[0].name; }
    const pick = await vscode.window.showQuickPick(remotes.map(r => r.name), { placeHolder: 'Select remote' });
    return pick;
}

interface RefQuickPickItem extends vscode.QuickPickItem {
    ref?: Ref;
    refKind?: RefKind;
}

/** Build a flat Quick Pick list (with separators) from a repository's refs. */
async function buildRefQuickPickItems(repo: Repository, includeKinds: RefKind[]): Promise<RefQuickPickItem[]> {
    const head = repo.state.HEAD?.name;
    const items: RefQuickPickItem[] = [];

    const sections: Array<{ kind: RefKind; type: number; label: string; icon: string }> = [
        { kind: 'local', type: RefType.Head, label: 'Local Branches', icon: 'git-branch' },
        { kind: 'remote', type: RefType.RemoteHead, label: 'Remote Branches', icon: 'cloud' },
        { kind: 'tag', type: RefType.Tag, label: 'Tags', icon: 'tag' },
    ];

    const allRefs: Ref[] = typeof repo.getRefs === 'function'
        ? await repo.getRefs().catch(() => repo.state.refs)
        : repo.state.refs;

    for (const s of sections) {
        if (!includeKinds.includes(s.kind)) { continue; }
        const refs = allRefs
            .filter(r => r.type === s.type && r.name)
            .sort((a, b) => a.name!.localeCompare(b.name!));
        if (refs.length === 0) { continue; }

        items.push({ label: s.label, kind: vscode.QuickPickItemKind.Separator });

        for (const r of refs) {
            const isCurrent = s.kind === 'local' && r.name === head;
            items.push({
                label: `$(${isCurrent ? 'check' : s.icon}) ${r.name}`,
                description: [r.commit?.substring(0, 7), isCurrent ? 'current' : undefined].filter(Boolean).join(' • '),
                ref: r,
                refKind: s.kind,
            });
        }
    }
    return items;
}

function showError(prefix: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`${prefix}: ${msg}`);
}

async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title },
        async () => task(),
    );
}

// ---------- Decoration provider ----------

/**
 * Highlights the active branch by applying a colored badge + foreground
 * color to RefItems whose resourceUri uses the `git-branch://current/...`
 * scheme. This is the closest stand-in for "bold" available to TreeView items.
 */
class CurrentBranchDecorationProvider implements vscode.FileDecorationProvider {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'git-branch') { return undefined; }
        if (uri.authority !== 'current') { return undefined; }
        return {
            badge: '●',
            tooltip: 'Current branch',
            color: new vscode.ThemeColor('gitBranchesExplorer.currentBranchForeground'),
            propagate: false,
        };
    }
}

// ---------- Activation ----------

export async function activate(context: vscode.ExtensionContext) {
    const git = await getGitAPI();
    if (!git) {
        vscode.window.showWarningMessage('Branches Explorer: built-in Git extension is not available.');
        return;
    }

    const local = new RefsTreeProvider(git, 'local');
    const remote = new RefsTreeProvider(git, 'remote');
    const tags = new RefsTreeProvider(git, 'tag');

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(new CurrentBranchDecorationProvider()),
    );

    const warmAll = () => {
        for (const r of git.repositories) {
            void local.warmRefs(r);
            void remote.warmRefs(r);
            void tags.warmRefs(r);
        }
    };
    if (git.repositories.length > 0) { warmAll(); }
    git.onDidOpenRepository(() => warmAll());

    const localView = vscode.window.createTreeView('gitBranchesExplorer.local', { treeDataProvider: local, showCollapseAll: true });
    const remoteView = vscode.window.createTreeView('gitBranchesExplorer.remote', { treeDataProvider: remote, showCollapseAll: true });
    const tagsView = vscode.window.createTreeView('gitBranchesExplorer.tags', { treeDataProvider: tags, showCollapseAll: true });

    // ---------- File system watcher: detect external branch/tag mutations ----------
    // vscode.git's state.onDidChange does not always fire (and our stateSig does
    // not include refs.length because state.refs is often empty). Watch the
    // .git refs directly so external `git branch ...`, `git tag ...` etc. show up.
    const watchRepo = (r: Repository) => {
        const trigger = () => {
            local.forceRefresh();
            remote.forceRefresh();
            tags.forceRefresh();
        };
        const pattern = new vscode.RelativePattern(r.rootUri, '.git/{HEAD,packed-refs,refs/**}');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidCreate(trigger);
        watcher.onDidChange(trigger);
        watcher.onDidDelete(trigger);
        context.subscriptions.push(watcher);
    };
    git.repositories.forEach(watchRepo);
    context.subscriptions.push(git.onDidOpenRepository(watchRepo));

    // ---------- View mode (tree | list) ----------
    const applyMode = async (kind: RefKind, provider: RefsTreeProvider, mode: 'tree' | 'list') => {
        provider.setViewMode(mode);
        await context.globalState.update(`gitBranchesExplorer.mode.${kind}`, mode);
        await vscode.commands.executeCommand('setContext', `gitBranchesExplorer.mode.${kind}`, mode);
    };
    const initMode = (kind: RefKind, provider: RefsTreeProvider) => {
        const m = context.globalState.get<'tree' | 'list'>(`gitBranchesExplorer.mode.${kind}`, 'tree');
        provider.setViewMode(m);
        void vscode.commands.executeCommand('setContext', `gitBranchesExplorer.mode.${kind}`, m);
    };
    initMode('local', local);
    initMode('remote', remote);
    initMode('tag', tags);
    context.subscriptions.push(
        vscode.commands.registerCommand('gitBranchesExplorer.local.viewAsTree', () => applyMode('local', local, 'tree')),
        vscode.commands.registerCommand('gitBranchesExplorer.local.viewAsList', () => applyMode('local', local, 'list')),
        vscode.commands.registerCommand('gitBranchesExplorer.remote.viewAsTree', () => applyMode('remote', remote, 'tree')),
        vscode.commands.registerCommand('gitBranchesExplorer.remote.viewAsList', () => applyMode('remote', remote, 'list')),
        vscode.commands.registerCommand('gitBranchesExplorer.tags.viewAsTree', () => applyMode('tag', tags, 'tree')),
        vscode.commands.registerCommand('gitBranchesExplorer.tags.viewAsList', () => applyMode('tag', tags, 'list')),
    );

    const setMessage = (view: vscode.TreeView<unknown>, p: RefsTreeProvider) => {
        view.message = p.currentFilter ? `Filter: ${p.currentFilter}` : undefined;
    };

    const filterFor = async (view: vscode.TreeView<unknown>, p: RefsTreeProvider) => {
        const value = await vscode.window.showInputBox({
            prompt: 'Filter (substring, case-insensitive). Leave empty to clear.',
            value: p.currentFilter,
        });
        if (value === undefined) { return; }
        p.setFilter(value);
        setMessage(view, p);
    };

    context.subscriptions.push(
        localView, remoteView, tagsView,
        local, remote, tags,

        // Refresh
        vscode.commands.registerCommand('gitBranchesExplorer.refresh', () => {
            local.forceRefresh(); remote.forceRefresh(); tags.forceRefresh();
        }),

        // Filter
        vscode.commands.registerCommand('gitBranchesExplorer.filterLocal', () => filterFor(localView, local)),
        vscode.commands.registerCommand('gitBranchesExplorer.filterRemote', () => filterFor(remoteView, remote)),
        vscode.commands.registerCommand('gitBranchesExplorer.filterTags', () => filterFor(tagsView, tags)),
        vscode.commands.registerCommand('gitBranchesExplorer.clearFilter', () => {
            local.setFilter(''); setMessage(localView, local);
            remote.setFilter(''); setMessage(remoteView, remote);
            tags.setFilter(''); setMessage(tagsView, tags);
        }),

        // ----- Branch operations -----

        vscode.commands.registerCommand('gitBranchesExplorer.checkout', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            try { await item.repo.checkout(item.ref.name); }
            catch (e) { showError('Checkout failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.checkoutRemote', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const shortName = item.ref.name.includes('/')
                ? item.ref.name.split('/').slice(1).join('/')
                : item.ref.name;
            try { await item.repo.checkout(shortName); }
            catch (e) { showError('Checkout failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.createBranch', async (item?: RefItem | RepoItem) => {
            const repo = item?.repo ?? await pickRepository(git);
            if (!repo) { return; }
            const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
            if (!name) { return; }
            const checkout = (await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Checkout new branch?' })) === 'Yes';
            const ref = item instanceof RefItem ? item.ref.name : undefined;
            try { await repo.createBranch(name, checkout, ref); }
            catch (e) { showError('Create branch failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.renameBranch', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const headName = item.repo.state.HEAD?.name;
            if (item.ref.name !== headName) {
                const proceed = await vscode.window.showWarningMessage(
                    `Renaming requires '${item.ref.name}' to be the current branch. Checkout now?`,
                    { modal: true }, 'Checkout & Rename');
                if (!proceed) { return; }
                try { await item.repo.checkout(item.ref.name); }
                catch (e) { showError('Checkout failed', e); return; }
            }
            const newName = await vscode.window.showInputBox({ prompt: 'New branch name', value: item.ref.name });
            if (!newName || newName === item.ref.name) { return; }
            try { await item.repo.renameBranch(newName); }
            catch (e) { showError('Rename failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.deleteBranch', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const choice = await vscode.window.showWarningMessage(
                `Delete branch '${item.ref.name}'?`, { modal: true }, 'Delete', 'Force Delete');
            if (!choice) { return; }
            try { await item.repo.deleteBranch(item.ref.name, choice === 'Force Delete'); }
            catch (e) { showError('Delete failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.merge', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const ok = await vscode.window.showInformationMessage(
                `Merge '${item.ref.name}' into current branch?`, { modal: true }, 'Merge');
            if (!ok) { return; }
            try { await withProgress(`Merging ${item.ref.name}…`, () => item.repo.merge(item.ref.name!)); }
            catch (e) { showError('Merge failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.rebase', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const ok = await vscode.window.showInformationMessage(
                `Rebase current branch onto '${item.ref.name}'?`, { modal: true }, 'Rebase');
            if (!ok) { return; }
            try { await withProgress(`Rebasing onto ${item.ref.name}…`, () => item.repo.rebase(item.ref.name!)); }
            catch (e) { showError('Rebase failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.push', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            try { await withProgress(`Pushing ${item.ref.name}…`, () => item.repo.push(undefined, item.ref.name!, false)); }
            catch (e) { showError('Push failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.publish', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const remoteName = await pickRemote(item.repo);
            if (!remoteName) { return; }
            try { await withProgress(`Publishing ${item.ref.name}…`, () => item.repo.push(remoteName, item.ref.name!, true)); }
            catch (e) { showError('Publish failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.pull', async (item?: RefItem | RepoItem) => {
            const repo = item?.repo ?? await pickRepository(git);
            if (!repo) { return; }
            try { await withProgress('Pulling…', () => repo.pull()); }
            catch (e) { showError('Pull failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.fetch', async (item?: RefItem | RepoItem | RemoteGroupItem) => {
            const repos = item?.repo ? [item.repo] : git.repositories;
            if (repos.length === 0) { return; }
            const remoteName = item instanceof RemoteGroupItem ? item.remoteName : undefined;
            try {
                await withProgress('Fetching (with prune)…', async () => {
                    for (const r of repos) {
                        // Fetch
                        await r.fetch(remoteName ? { remote: remoteName } : { all: true });
                        // Prune via git command
                        if (r.git?.run) {
                            const pruneArgs = ['remote', 'prune'];
                            if (remoteName) {
                                pruneArgs.push(remoteName);
                            } else {
                                // Prune all remotes
                                for (const remote of r.state.remotes) {
                                    await r.git.run(['remote', 'prune', remote.name]);
                                }
                                continue;
                            }
                            await r.git.run(pruneArgs);
                        }
                    }
                });
                // Refresh all views after fetch+prune
                local.forceRefresh(); remote.forceRefresh(); tags.forceRefresh();
            } catch (e) { showError('Fetch failed', e); }
        }),

        // ----- Remote branch -----

        vscode.commands.registerCommand('gitBranchesExplorer.deleteRemoteBranch', async (item: RefItem) => {
            if (!item?.ref?.name || !item.ref.remote) { return; }
            const branch = item.ref.name.substring(item.ref.remote.length + 1);
            const ok = await vscode.window.showWarningMessage(
                `Delete REMOTE branch '${item.ref.remote}/${branch}'? This pushes a deletion to the remote.`,
                { modal: true }, 'Delete on Remote');
            if (!ok) { return; }
            try { await withProgress(`Deleting ${item.ref.name}…`, () => item.repo.push(item.ref.remote!, `:${branch}`)); }
            catch (e) { showError('Delete remote branch failed', e); }
        }),

        // ----- Tag operations -----

        vscode.commands.registerCommand('gitBranchesExplorer.createTag', async (item?: RefItem | RepoItem) => {
            const repo = item?.repo ?? await pickRepository(git);
            if (!repo) { return; }
            const name = await vscode.window.showInputBox({ prompt: 'Tag name' });
            if (!name) { return; }
            const message = await vscode.window.showInputBox({ prompt: 'Tag message (optional)' });
            try { await repo.tag(name, message || undefined); }
            catch (e) { showError('Create tag failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.pushTag', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const remoteName = await pickRemote(item.repo);
            if (!remoteName) { return; }
            try { await withProgress(`Pushing tag ${item.ref.name}…`, () => item.repo.push(remoteName, item.ref.name!)); }
            catch (e) { showError('Push tag failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.deleteTag', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            if (typeof item.repo.deleteTag !== 'function') {
                vscode.window.showErrorMessage('Tag deletion is not supported by the installed Git extension version.');
                return;
            }
            const ok = await vscode.window.showWarningMessage(
                `Delete tag '${item.ref.name}' (local only)?`, { modal: true }, 'Delete');
            if (!ok) { return; }
            try { await item.repo.deleteTag(item.ref.name); }
            catch (e) { showError('Delete tag failed', e); }
        }),

        vscode.commands.registerCommand('gitBranchesExplorer.deleteRemoteTag', async (item: RefItem) => {
            if (!item?.ref?.name) { return; }
            const remoteName = await pickRemote(item.repo);
            if (!remoteName) { return; }
            const ok = await vscode.window.showWarningMessage(
                `Delete tag '${item.ref.name}' on remote '${remoteName}'?`,
                { modal: true }, 'Delete on Remote');
            if (!ok) { return; }
            try { await withProgress(`Deleting remote tag…`, () => item.repo.push(remoteName, `:refs/tags/${item.ref.name}`)); }
            catch (e) { showError('Delete remote tag failed', e); }
        }),

        // ----- Misc -----

        vscode.commands.registerCommand('gitBranchesExplorer.copyName', async (item: RefItem) => {
            if (item?.ref?.name) { await vscode.env.clipboard.writeText(item.ref.name); }
        }),

        // ----- Quick Switch (Quick Pick across all refs) -----

        vscode.commands.registerCommand('gitBranchesExplorer.quickSwitch', async () => {
            const repo = await pickRepository(git);
            if (!repo) { return; }
            const items = await buildRefQuickPickItems(repo, ['local', 'remote', 'tag']);
            if (items.length === 0) {
                vscode.window.showInformationMessage('No refs available.');
                return;
            }
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a branch, remote branch or tag to checkout',
                matchOnDescription: true,
            });
            if (!pick?.ref?.name) { return; }
            const target = pick.refKind === 'remote' && pick.ref.name.includes('/')
                ? pick.ref.name.split('/').slice(1).join('/')
                : pick.ref.name;
            try { await repo.checkout(target); }
            catch (e) { showError('Checkout failed', e); }
        }),

        // ----- Cherry-pick -----

        vscode.commands.registerCommand('gitBranchesExplorer.cherryPick', async (item?: RefItem) => {
            const repo = item?.repo ?? await pickRepository(git);
            if (!repo) { return; }

            // Resolve the commit to cherry-pick.
            let commit: string | undefined = item?.ref?.commit;
            if (!commit) {
                const input = await vscode.window.showInputBox({
                    prompt: 'Commit hash, branch, tag or rev-spec to cherry-pick',
                });
                commit = input?.trim();
            }
            if (!commit) { return; }

            const exec = async () => {
                if (typeof repo.cherryPick === 'function') {
                    await repo.cherryPick(commit!);
                    return;
                }
                if (repo.git?.run) {
                    await repo.git.run(['cherry-pick', commit!]);
                    return;
                }
                throw new Error('Cherry-pick is not supported by the installed Git extension version.');
            };

            try { await withProgress(`Cherry-picking ${commit.substring(0, 12)}…`, exec); }
            catch (e) { showError('Cherry-pick failed', e); }
        }),
    );
}

export function deactivate() { }
