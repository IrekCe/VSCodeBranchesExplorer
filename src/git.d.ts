// Minimal subset of the vscode.git extension API surface we use.
// Full typings: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
import { Event, Uri, Disposable } from 'vscode';

export interface Ref {
    readonly type: RefType;
    readonly name?: string;
    readonly commit?: string;
    readonly remote?: string;
}

export const enum RefType {
    Head = 0,
    RemoteHead = 1,
    Tag = 2
}

export interface UpstreamRef {
    readonly remote: string;
    readonly name: string;
}

export interface Branch extends Ref {
    readonly upstream?: UpstreamRef;
    readonly ahead?: number;
    readonly behind?: number;
}

export interface Commit {
    readonly hash: string;
    readonly message: string;
    readonly authorName?: string;
    readonly authorEmail?: string;
    readonly authorDate?: Date;
    readonly commitDate?: Date;
}

export interface RepositoryState {
    readonly HEAD: Branch | undefined;
    readonly refs: Ref[];
    readonly remotes: { name: string; fetchUrl?: string; pushUrl?: string }[];
    readonly onDidChange: Event<void>;
}

export interface Repository {
    readonly rootUri: Uri;
    readonly state: RepositoryState;
    getBranch(name: string): Promise<Branch>;
    getCommit(ref: string): Promise<Commit>;
    /** Newer vscode.git API: returns refs explicitly. state.refs may be empty. */
    getRefs?(query?: { contains?: string; pattern?: string; count?: number }): Promise<Ref[]>;
    createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
    renameBranch(name: string): Promise<void>;
    checkout(treeish: string): Promise<void>;
    deleteBranch(name: string, force?: boolean): Promise<void>;
    merge(ref: string): Promise<void>;
    rebase(branch: string): Promise<void>;
    fetch(options?: { remote?: string; ref?: string; all?: boolean }): Promise<void>;
    pull(unshallow?: boolean): Promise<void>;
    push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: boolean): Promise<void>;
    tag(name: string, upstream?: string): Promise<void>;
    deleteTag?(name: string): Promise<void>;
    status(): Promise<void>;
    cherryPick?(commitHash: string): Promise<void>;
    /** Low-level escape hatch present on the underlying repository implementation. */
    readonly git?: { run(args: string[]): Promise<{ stdout: string; stderr: string }> };
}

export interface API {
    readonly state: APIState;
    readonly onDidChangeState: Event<APIState>;
    readonly repositories: Repository[];
    readonly onDidOpenRepository: Event<Repository>;
    readonly onDidCloseRepository: Event<Repository>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: Event<boolean>;
    getAPI(version: 1): API;
}

export type { Disposable };
