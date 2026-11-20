// store.ts — the forge's in-memory state and every domain operation the surfaces share
// (REST, GraphQL and MCP all read and write the same objects, ids stable across reads).
//
// Identity is fixed by the scenario seed: the viewer is always `adaiversen` (id 1000).
// Nothing here reads the clock or randomness: stored state is fully deterministic.

import {
  CONFORMANCE_IDENTITY,
  ObjIndex,
  buildCommitBytes,
  buildTreeBytes,
  collectReachable,
  isAncestor,
  isOid,
  lineDiff,
  listCommitsFrom,
  parseCommit,
  type Obj,
  type ObjType,
  type TreeEntry,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const TEAMMATE_LOGIN = 'quinnkeller';

/** Fixed timestamp strings in views (stored state carries no clock). */
export const FIXED_TS = '2025-01-01T00:00:00Z';
export const FIXED_DATE_ISO = '2023-11-14T22:13:20Z';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  /** Pre-serialized REST view (rebuilt on mutation); the read workload serves this directly. */
  jsonBuf: Buffer;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export class Repo {
  readonly owner = VIEWER_LOGIN;
  readonly name: string;
  readonly id: number;
  private: boolean;
  description: string;
  readonly index = new ObjIndex();
  /** ref name -> tip oid. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  /** Issues and PRs share one numbering sequence per repo, as on GitHub. */
  nextNumber = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  private seqCounter = 0;
  /** Bumped on any mutation; response caches validate against it. */
  version = 0;
  /** Cached v2 fetch responses: key -> {version, body}. */
  readonly fetchCache = new Map<string, { version: number; body: Buffer }>();
  cachedLsRefs: { version: number; body: Buffer } | null = null;
  cachedAdvV0: { version: number; body: Buffer } | null = null;

  constructor(name: string, id: number, isPrivate: boolean, description: string) {
    this.name = name;
    this.id = id;
    this.private = isPrivate;
    this.description = description;
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  touch(): void {
    this.version += 1;
    this.fetchCache.clear();
    this.cachedLsRefs = null;
    this.cachedAdvV0 = null;
  }

  defaultTip(): string | undefined {
    return this.refs.get('refs/heads/main');
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextGlobalIssueId = 1;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(Store.key(VIEWER_LOGIN, name))) return null;
    const repo = new Repo(name, this.nextRepoId, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(Store.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(Store.key(owner, name)) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(Store.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  nextIssueGlobalId(): number {
    const id = this.nextGlobalIssueId;
    this.nextGlobalIssueId += 1;
    return id;
  }
}

// ---------------------------------------------------------------- global ids

/** Opaque, stable, decodable global ids: base64url of a structured string. */
export function globalId(kind: 'R' | 'I' | 'PR' | 'C', owner: string, name: string, num?: number, sub?: number): string {
  let raw = `${kind}:${owner}/${name}`;
  if (num !== undefined) raw += `#${num}`;
  if (sub !== undefined) raw += `:${sub}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; num?: number; sub?: number } | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = /^([RIP][RC]?):([^/#:]+)\/([^#:]+)(?:#(\d+))?(?::(\d+))?$/.exec(raw);
  if (m === null) return null;
  return {
    kind: m[1],
    owner: m[2],
    name: m[3],
    num: m[4] === undefined ? undefined : Number.parseInt(m[4], 10),
    sub: m[5] === undefined ? undefined : Number.parseInt(m[5], 10),
  };
}

// ---------------------------------------------------------------- views

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: 'main',
    fork: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Rebuild an issue's cached REST bytes after a mutation. */
export function refreshIssueJson(repo: Repo, issue: Issue): void {
  issue.jsonBuf = Buffer.from(JSON.stringify(issueView(repo, issue)), 'utf8');
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PR', repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: !pullConflict(repo, pull),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function commentView(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', repo.owner, repo.name, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function branchView(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: '' }, protected: false };
}

export function refView(ref: string, sha: string): Record<string, unknown> {
  return { ref, object: { sha, type: 'commit', url: '' }, node_id: '' };
}

export function commitView(index: ObjIndex, sha: string): Record<string, unknown> | null {
  const parsed = index.commit(sha);
  if (parsed === null) return null;
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (m === null) return { name: line, email: '', date: FIXED_DATE_ISO };
    return { name: m[1], email: m[2], date: new Date(Number.parseInt(m[3], 10) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      message: parsed.message,
      author: parseIdentity(parsed.author),
      committer: parseIdentity(parsed.committer),
    },
    parents: parsed.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
  };
}

// ---------------------------------------------------------------- refs

/** Resolve a branch name, full ref, or oid to a commit oid, or null. */
export function resolveRefish(repo: Repo, refish: string): string | null {
  if (refish === 'HEAD') return repo.defaultTip() ?? null;
  if (refish.startsWith('refs/')) {
    const tip = repo.refs.get(refish);
    return tip ?? null;
  }
  const branchTip = repo.refs.get(`refs/heads/${refish}`);
  if (branchTip !== undefined) return branchTip;
  if (isOid(refish) && repo.index.has(refish)) return refish;
  return null;
}

/** List branch names (short names) that exist in the repo. */
export function listBranches(repo: Repo): string[] {
  const out: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) out.push(ref.slice('refs/heads/'.length));
  }
  return out.sort();
}

// ---------------------------------------------------------------- issues

export type CreateIssueResult =
  | { ok: true; issue: Issue }
  | { ok: false; status: number; message: string };

export function createIssue(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): CreateIssueResult {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) {
      return { ok: false, status: 422, message: `Validation Failed: label "${name}" does not exist` };
    }
  }
  const issue: Issue = {
    number: repo.nextNumber,
    id: store.nextIssueGlobalId(),
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
    seq: repo.nextSeq(),
    jsonBuf: Buffer.alloc(0),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  refreshIssueJson(repo, issue);
  repo.touch();
  return { ok: true, issue };
}

export function listIssues(
  repo: Repo,
  opts: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number },
): Issue[] {
  const state = opts.state ?? 'open';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((i) => i.state === state);
  const direction = opts.direction ?? 'desc';
  const sort = opts.sort ?? 'created';
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const perPage = opts.perPage ?? 30;
  const page = opts.page ?? 1;
  const start = (page - 1) * perPage;
  return list.slice(start, start + perPage);
}

export function closeIssue(repo: Repo, issue: Issue): void {
  if (issue.state === 'closed') return;
  issue.state = 'closed';
  refreshIssueJson(repo, issue);
  repo.touch();
}

export function addComment(repo: Repo, issue: Issue, body: string): Comment {
  const comment: Comment = { id: repo.nextCommentId, body };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  refreshIssueJson(repo, issue);
  repo.touch();
  return comment;
}

// ---------------------------------------------------------------- pulls

export type CreatePullResult =
  | { ok: true; pull: Pull }
  | { ok: false; status: number; message: string };

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): CreatePullResult {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) {
    return { ok: false, status: 422, message: 'Validation Failed: head or base branch does not exist' };
  }
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
      return { ok: false, status: 422, message: 'Validation Failed: a pull request already exists for this head and base' };
    }
  }
  const pull: Pull = {
    number: repo.nextNumber,
    id: repo.nextPullId,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    seq: repo.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.nextPullId += 1;
  repo.pulls.set(pull.number, pull);
  repo.touch();
  return { ok: true, pull };
}

/** Flatten a commit's tree to path -> blob oid (files only). */
export function flattenTree(index: ObjIndex, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const entries = index.tree(oid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two trees (by commit oid) into per-file changes with line counts. */
export function diffCommits(index: ObjIndex, baseSha: string, headSha: string): FileChange[] {
  const baseCommit = index.commit(baseSha);
  const headCommit = index.commit(headSha);
  if (baseCommit === null || headCommit === null) return [];
  const baseFiles = flattenTree(index, baseCommit.tree);
  const headFiles = flattenTree(index, headCommit.tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (baseOid === headOid) continue;
    if (baseOid === undefined) {
      const blob = index.get(headOid!);
      const text = blob !== undefined && blob.type === 'blob' ? blob.data.toString('utf8') : '';
      const { additions } = lineDiff('', text);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (headOid === undefined) {
      const blob = index.get(baseOid);
      const text = blob !== undefined && blob.type === 'blob' ? blob.data.toString('utf8') : '';
      const { deletions } = lineDiff(text, '');
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const oldBlob = index.get(baseOid);
      const newBlob = index.get(headOid);
      const oldText = oldBlob !== undefined && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob !== undefined && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/**
 * True when merging this pull would conflict: the base branch moved since the pull was opened
 * AND a file the head changed (against the pull's base) was also changed on the base branch
 * afterwards, with different content on the two sides.
 */
export function pullConflict(repo: Repo, pull: Pull): boolean {
  const currentBase = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (currentBase === undefined || currentBase === pull.baseSha) return false;
  const baseCommit = repo.index.commit(pull.baseSha);
  const headCommit = repo.index.commit(pull.headSha);
  const currentCommit = repo.index.commit(currentBase);
  if (baseCommit === null || headCommit === null || currentCommit === null) return false;
  const baseFiles = flattenTree(repo.index, baseCommit.tree);
  const headFiles = flattenTree(repo.index, headCommit.tree);
  const currentFiles = flattenTree(repo.index, currentCommit.tree);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = currentFiles.get(path);
    const headChanged = h !== b;
    const baseChanged = c !== b;
    if (headChanged && baseChanged && h !== c) return true;
  }
  return false;
}

export type MergeResult =
  | { ok: true; sha: string; message: string }
  | { ok: false; status: number; message: string };

/** Squash-merge a pull onto its base branch: one commit whose tree is the head's tree. */
export function mergePull(repo: Repo, pull: Pull, method: string): MergeResult {
  if (pull.state !== 'open') {
    return { ok: false, status: 405, message: 'Validation Failed: pull request is not open' };
  }
  if (method !== '' && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return { ok: false, status: 422, message: `Validation Failed: unknown merge method "${method}"` };
  }
  if (pullConflict(repo, pull)) {
    return { ok: false, status: 405, message: 'Validation Failed: this pull request has conflicts' };
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headCommit = repo.index.commit(pull.headSha);
  if (baseTip === undefined || headCommit === null) {
    return { ok: false, status: 422, message: 'Validation Failed: head or base commit is missing' };
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commitBytes = buildCommitBytes({
    tree: headCommit.tree,
    parents: [baseTip],
    message,
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
  });
  const mergeSha = repo.index.put('commit', commitBytes);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = FIXED_TS;
  pull.merge_commit_sha = mergeSha;
  repo.touch();
  return { ok: true, sha: mergeSha, message: `Pull request #${pull.number} merged` };
}

// ---------------------------------------------------------------- contents

/** Walk a tree to the entry at `parts` (files and dirs). */
export function lookupPath(
  index: ObjIndex,
  rootTreeOid: string,
  parts: readonly string[],
): { entry: TreeEntry; parentTree: string } | null {
  let treeOid = rootTreeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = index.tree(treeOid);
    if (entries === null) return null;
    const entry = entries.find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { entry, parentTree: treeOid };
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** List a directory's direct children (root when parts is empty). */
export function listDir(index: ObjIndex, rootTreeOid: string, parts: readonly string[]): TreeEntry[] | null {
  let treeOid = rootTreeOid;
  for (const part of parts) {
    const entries = index.tree(treeOid);
    if (entries === null) return null;
    const entry = entries.find((e) => e.name === part);
    if (entry === undefined || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return index.tree(treeOid);
}

/**
 * Return a new tree oid equal to `baseTreeOid` (or the empty tree) with `parts` set to `blobOid`.
 * Intermediate directories are created as needed; replaced entries keep their mode unless a
 * file replaces a directory or vice versa.
 */
export function setPathInTree(
  index: ObjIndex,
  baseTreeOid: string | null,
  parts: readonly string[],
  blobOid: string,
): string {
  if (parts.length === 0) throw new Error('empty path');
  const entries: TreeEntry[] = baseTreeOid === null ? [] : [...(index.tree(baseTreeOid) ?? [])];
  const [head, ...rest] = parts as [string, ...string[]];
  const at = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
  } else {
    let childTree: string | null = null;
    if (at >= 0 && entries[at].mode === '40000') childTree = entries[at].oid;
    const newChild = setPathInTree(index, childTree, rest, blobOid);
    const entry: TreeEntry = { mode: '40000', name: head, oid: newChild };
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
  }
  return index.put('tree', buildTreeBytes(entries));
}

/** Return a new tree oid with `parts` removed (empty directories pruned), or null when missing. */
export function deletePathInTree(
  index: ObjIndex,
  baseTreeOid: string,
  parts: readonly string[],
): string | null {
  const entries: TreeEntry[] = [...(index.tree(baseTreeOid) ?? [])];
  const [head, ...rest] = parts as [string, ...string[]];
  const at = entries.findIndex((e) => e.name === head);
  if (at < 0) return null;
  if (rest.length === 0) {
    entries.splice(at, 1);
  } else {
    if (entries[at].mode !== '40000') return null;
    const newChild = deletePathInTree(index, entries[at].oid, rest);
    if (newChild === null) return null;
    const childEntries = index.tree(newChild);
    if (childEntries !== null && childEntries.length === 0) entries.splice(at, 1);
    else entries[at] = { mode: '40000', name: head, oid: newChild };
  }
  return index.put('tree', buildTreeBytes(entries));
}

export interface ContentsWriteResult {
  status: number;
  commitSha?: string;
  blobSha?: string;
  message?: string;
}

/**
 * Write (create or update) a file through the contents API: a real commit on `branch`
 * (creating the branch from the default tip when it does not exist yet). `sha` is the
 * expected current blob sha for updates; a mismatch is a 409.
 */
export function writeContents(
  repo: Repo,
  pathParts: readonly string[],
  content: Buffer,
  message: string,
  branch: string,
  sha?: string,
): ContentsWriteResult {
  const branchRef = `refs/heads/${branch}`;
  let baseTip = repo.refs.get(branchRef);
  if (baseTip === undefined) {
    // A new branch starts at the default branch tip (the MCP setup relies on this).
    const defaultTip = repo.defaultTip();
    if (branch !== 'main' && defaultTip !== undefined) baseTip = defaultTip;
  }
  const baseCommit = baseTip === undefined ? null : repo.index.commit(baseTip);
  const baseTree = baseCommit === null ? null : baseCommit.tree;
  if (sha !== undefined && baseTree !== null) {
    const found = lookupPath(repo.index, baseTree, pathParts);
    if (found === null || found.entry.oid !== sha) {
      return { status: 409, message: 'Validation Failed: sha does not match the current file' };
    }
  }
  const isCreate = baseTree === null || lookupPath(repo.index, baseTree, pathParts) === null;
  const blobSha = repo.index.put('blob', content);
  const newTree = setPathInTree(repo.index, baseTree, pathParts, blobSha);
  const commitBytes = buildCommitBytes({
    tree: newTree,
    parents: baseTip === undefined ? [] : [baseTip],
    message,
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
  });
  const commitSha = repo.index.put('commit', commitBytes);
  repo.refs.set(branchRef, commitSha);
  repo.touch();
  return { status: isCreate ? 201 : 200, commitSha, blobSha };
}

/** Delete a file through the contents API: a real commit removing it. */
export function deleteContents(
  repo: Repo,
  pathParts: readonly string[],
  message: string,
  branch: string,
  sha?: string,
): ContentsWriteResult {
  const branchRef = `refs/heads/${branch}`;
  const baseTip = repo.refs.get(branchRef);
  if (baseTip === undefined) return { status: 404, message: 'Not Found' };
  const baseCommit = repo.index.commit(baseTip);
  if (baseCommit === null) return { status: 404, message: 'Not Found' };
  const found = lookupPath(repo.index, baseCommit.tree, pathParts);
  if (found === null) return { status: 404, message: 'Not Found' };
  if (sha !== undefined && found.entry.oid !== sha) {
    return { status: 409, message: 'Validation Failed: sha does not match the current file' };
  }
  const newTree = deletePathInTree(repo.index, baseCommit.tree, pathParts);
  if (newTree === null) return { status: 404, message: 'Not Found' };
  const commitBytes = buildCommitBytes({
    tree: newTree,
    parents: [baseTip],
    message,
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
  });
  const commitSha = repo.index.put('commit', commitBytes);
  repo.refs.set(branchRef, commitSha);
  repo.touch();
  return { status: 200, commitSha };
}

/** Read a blob's bytes at `parts` in the tree of `commitSha` (null when absent/not a file). */
export function readBlobAt(
  index: ObjIndex,
  commitSha: string,
  parts: readonly string[],
): { oid: string; data: Buffer } | null {
  const commit = index.commit(commitSha);
  if (commit === null) return null;
  const found = lookupPath(index, commit.tree, parts);
  if (found === null || found.entry.mode === '40000') return null;
  const obj = index.get(found.entry.oid);
  if (obj === undefined || obj.type !== 'blob') return null;
  return { oid: found.entry.oid, data: obj.data };
}

/** Read the blob oid at `parts` (null when absent). */
export function readBlobOidAt(index: ObjIndex, commitSha: string, parts: readonly string[]): string | null {
  const found = readBlobAt(index, commitSha, parts);
  return found === null ? null : found.oid;
}

// ---------------------------------------------------------------- misc domain helpers

/** All commit oids reachable from `tip`, newest-first (capped). */
export function listCommits(repo: Repo, tip: string, limit: number): Array<Record<string, unknown>> {
  const oids = listCommitsFrom(repo.index, tip, limit);
  const out: Array<Record<string, unknown>> = [];
  for (const oid of oids) {
    const view = commitView(repo.index, oid);
    if (view !== null) out.push(view);
  }
  return out;
}

/** The objects a fetch must send for `wants` minus `haves`, with optional depth limiting.
 * No depth: closure(wants) minus closure(haves). With depth N: commits within distance < N of
 * the wants (their trees/blobs), minus the have oids themselves; the new shallow boundaries are
 * the included commits at distance N-1. */
export function fetchSelection(
  repo: Repo,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  clientShallow: ReadonlyArray<string>,
  depth?: number,
): {
  objects: Obj[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
} {
  const index = repo.index;
  const knownHaves = [...haves].filter((h) => index.has(h));
  const nak = knownHaves.length === 0;
  const acks = knownHaves;
  const objects: Obj[] = [];
  const seen = new Set<string>();
  const pushObj = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const obj = index.get(oid);
    if (obj !== undefined) objects.push(obj);
  };
  if (depth === undefined) {
    const reachW = collectReachable(index, wants);
    const reachH = haves.size > 0 ? collectReachable(index, [...haves]) : null;
    const excluded = new Set<string>();
    if (reachH !== null) {
      for (const oid of reachH.commits.keys()) excluded.add(oid);
      for (const oid of reachH.trees) excluded.add(oid);
      for (const oid of reachH.blobs) excluded.add(oid);
      for (const oid of reachH.tags) excluded.add(oid);
    }
    for (const oid of reachW.commits.keys()) if (!excluded.has(oid)) pushObj(oid);
    for (const oid of reachW.tags) if (!excluded.has(oid)) pushObj(oid);
    for (const oid of reachW.trees) if (!excluded.has(oid)) pushObj(oid);
    for (const oid of reachW.blobs) if (!excluded.has(oid)) pushObj(oid);
    return { objects, shallow: [], unshallow: [], acks, nak };
  }
  // Depth-limited: commits within distance < depth of the wants, minus the haves themselves.
  const reach = collectReachable(index, wants, depth);
  const included = new Set<string>();
  for (const [oid] of reach.commits) {
    if (!haves.has(oid)) included.add(oid);
  }
  const shallow: string[] = [];
  for (const [oid, dist] of reach.commits) {
    if (dist === depth - 1 && included.has(oid)) shallow.push(oid);
  }
  // Unshallow: old shallow boundaries whose parent is now included (or that are included).
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (included.has(boundary)) {
      unshallow.push(boundary);
      continue;
    }
    const parsed = index.commit(boundary);
    if (parsed !== null && parsed.parents.some((p) => included.has(p))) unshallow.push(boundary);
  }
  // Objects: the included commits, their tags, and the trees/blobs of exactly those commits.
  for (const oid of included) pushObj(oid);
  const treeBlobs = new Set<string>();
  for (const oid of included) {
    const parsed = index.commit(oid);
    if (parsed === null) continue;
    const walk = (treeOid: string): void => {
      if (treeBlobs.has(treeOid)) return;
      treeBlobs.add(treeOid);
      const entries = index.tree(treeOid);
      if (entries === null) return;
      for (const entry of entries) {
        if (entry.mode === '40000') walk(entry.oid);
        else treeBlobs.add(entry.oid);
      }
    };
    walk(parsed.tree);
  }
  for (const oid of treeBlobs) if (!haves.has(oid)) pushObj(oid);
  // Tags pointing at an included commit travel with it.
  for (const [ref, tip] of repo.refs) {
    if (!ref.startsWith('refs/tags/')) continue;
    const obj = index.get(tip);
    if (obj !== undefined && obj.type === 'tag') {
      const target = index.peel(tip);
      if (included.has(target)) pushObj(tip);
    }
  }
  return { objects, shallow, unshallow, acks, nak };
}

/** Every object id reachable from a set of roots (for "has this object" checks). */
export function reachableOids(index: ObjIndex, roots: ReadonlyArray<string>): Set<string> {
  const reach = collectReachable(index, roots);
  const out = new Set<string>([...reach.commits.keys(), ...reach.trees, ...reach.blobs, ...reach.tags]);
  return out;
}

export { collectReachable, isAncestor };
