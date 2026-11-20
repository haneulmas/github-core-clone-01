// rest.ts — the REST v3 surface: repos, branches, refs, commits, contents, labels,
// issues, comments and pull requests. All handlers share the store with git/GraphQL/MCP.

import {
  addComment,
  branchView,
  closeIssue,
  commentView,
  createIssue,
  createPull,
  deleteContents,
  diffCommits,
  globalId,
  issueView,
  labelView,
  listBranches,
  listCommits,
  listDir,
  listIssues,
  lookupPath,
  mergePull,
  pullView,
  refView,
  refreshIssueJson,
  repoView,
  resolveRefish,
  writeContents,
  FIXED_TS,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after `/api/v3`, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body (null when absent); `bodyMalformed` when the bytes were not JSON. */
  body: unknown;
  bodyMalformed: boolean;
  /** Request origin (scheme://host) for pagination Link headers. */
  origin: string;
}

export interface RestResult {
  status: number;
  /** Complete body bytes (empty for 204). */
  buf: Buffer;
  headers?: Record<string, string>;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, buf: Buffer.from(JSON.stringify(value), 'utf8'), headers };
}

function err(status: number, message: string): RestResult {
  return json(status, { message });
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** A paginated list result with a Link rel="next" header when more pages remain. */
function paged<T>(
  items: readonly T[],
  total: number,
  req: RestRequest,
  perPage: number,
  page: number,
): RestResult {
  const headers: Record<string, string> = {};
  if (page * perPage < total) {
    const next = new URL(req.origin);
    // Rebuild the current path + query with page+1, preserving the other parameters.
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const path = `/api/v3/${req.segments.map((s) => encodeURIComponent(s)).join('/')}`;
    headers.link = `<${next.origin}${path}?${params.toString()}>; rel="next"`;
  }
  return { status: 200, buf: Buffer.from(JSON.stringify(items), 'utf8'), headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') out.push(entry.name);
  }
  return out;
}

/** Route one REST request. `segments` are the path parts after `/api/v3`. */
export function handleRest(req: RestRequest, store: Store): RestResult {
  const { method, segments } = req;
  if (req.bodyMalformed) return err(400, 'Invalid JSON body');

  // GET /api/v3/ — the API root (public; auth is decided by the caller).
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
      'x-oauth-scopes': 'repo, read:org',
    });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: globalId('R', VIEWER_LOGIN, ''),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
    });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageParams(req.query);
      const all = store.listViewerRepos();
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage).map((r) => repoView(r));
      return paged(items, all.length, req, perPage, page);
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return err(422, 'Validation Failed: name is required');
      const name = stringField(req.body, 'name');
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return err(422, 'Validation Failed: name is invalid');
      }
      const isPrivate = req.body.private === true;
      const description = stringField(req.body, 'description');
      const repo = store.createRepo(name, isPrivate, description);
      if (repo === null) return err(422, `Validation Failed: repository "${name}" already exists`);
      return json(201, repoView(repo));
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1];
    const name = segments[2];
    const repo = store.getRepo(owner, name);
    if (repo === null) return err(404, 'Not Found');
    return handleRepo(req, store, repo);
  }

  return err(404, 'Not Found');
}

function handleRepo(req: RestRequest, store: Store, repo: Repo): RestResult {
  const { method, segments } = req;
  const rest = segments.slice(3);

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo));
    if (method === 'PATCH') {
      if (!isRecord(req.body)) return err(422, 'Validation Failed');
      if (typeof req.body.description === 'string') repo.description = req.body.description;
      if (typeof req.body.private === 'boolean') repo.private = req.body.private;
      repo.touch();
      return json(200, repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, buf: Buffer.alloc(0) };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0];

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const items = listBranches(repo).map((b) => branchView(b, repo.refs.get(`refs/heads/${b}`)!));
      return json(200, items);
    }
    if (method !== 'GET') return err(404, 'Not Found');
    const branch = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return err(404, 'Not Found');
    return json(200, branchView(branch, sha));
  }

  // Git refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method !== 'POST') return err(404, 'Not Found');
      if (!isRecord(req.body)) return err(422, 'Validation Failed: ref and sha are required');
      const ref = stringField(req.body, 'ref');
      const sha = stringField(req.body, 'sha');
      if (!ref.startsWith('refs/') || sha === '') return err(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return err(422, `Validation Failed: reference ${ref} already exists`);
      const obj = repo.index.get(sha);
      if (obj === undefined || obj.type !== 'commit') return err(422, 'Validation Failed: sha is not a commit');
      repo.refs.set(ref, sha);
      repo.touch();
      return json(201, refView(ref, sha));
    }
    if (rest.length >= 4 && rest[2] === 'heads') {
      if (method !== 'GET') return err(404, 'Not Found');
      const branch = rest.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return json(200, refView(`refs/heads/${branch}`, sha));
    }
    return err(404, 'Not Found');
  }

  // Commits.
  if (head === 'commits') {
    if (method !== 'GET') return err(404, 'Not Found');
    const refish = req.query.get('sha') ?? 'main';
    const tip = resolveRefish(repo, refish);
    if (tip === null) return err(404, 'Not Found');
    const { perPage, page } = pageParams(req.query);
    const all = listCommits(repo, tip, 10_000);
    const start = (page - 1) * perPage;
    return paged(all.slice(start, start + perPage), all.length, req, perPage, page);
  }

  // Contents.
  if (head === 'contents') {
    return handleContents(req, repo);
  }

  // Labels.
  if (head === 'labels') {
    if (rest.length !== 1) return err(404, 'Not Found');
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => labelView(l)));
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return err(422, 'Validation Failed: name is required');
      const name = stringField(req.body, 'name');
      const color = stringField(req.body, 'color') || 'ffffff';
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return err(422, `Validation Failed: label "${name}" already exists`);
      const label = { name, color };
      repo.labels.set(name, label);
      repo.touch();
      return json(201, labelView(label));
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const { perPage, page } = pageParams(req.query);
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        // Total for the Link header: count the filtered set (not just this page).
        const all = listIssues(repo, { state, sort, direction, perPage: 1_000_000, page: 1 });
        const start = (page - 1) * perPage;
        const items = all.slice(start, start + perPage).map((i) => issueView(repo, i));
        return paged(items, all.length, req, perPage, page);
      }
      if (method === 'POST') {
        if (!isRecord(req.body)) return err(422, 'Validation Failed: title is required');
        const title = stringField(req.body, 'title');
        if (title === '') return err(422, 'Validation Failed: title is required');
        const body = stringField(req.body, 'body');
        const result = createIssue(store, repo, title, body, labelNames(req.body.labels));
        if (!result.ok) return err(result.status, result.message);
        return json(201, issueView(repo, result.issue));
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1], 10);
    if (!Number.isSafeInteger(number) || number <= 0) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') {
        // Hot path: serve the pre-serialized view.
        return { status: 200, buf: issue.jsonBuf };
      }
      if (method === 'PATCH') {
        if (!isRecord(req.body)) return err(422, 'Validation Failed');
        if (req.body.state === 'closed') closeIssue(repo, issue);
        else if (req.body.state === 'open') issue.state = 'open';
        if (typeof req.body.title === 'string') issue.title = req.body.title;
        if (typeof req.body.body === 'string') issue.body = req.body.body;
        refreshIssueJson(repo, issue);
        repo.touch();
        return { status: 200, buf: issue.jsonBuf };
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') {
        return json(200, issue.comments.map((c) => commentView(repo, issue, c)));
      }
      if (method === 'POST') {
        if (!isRecord(req.body)) return err(422, 'Validation Failed: body is required');
        const body = stringField(req.body, 'body');
        if (body === '') return err(422, 'Validation Failed: body is required');
        const comment = addComment(repo, issue, body);
        return json(201, commentView(repo, issue, comment));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const { perPage, page } = pageParams(req.query);
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const start = (page - 1) * perPage;
        const items = list.slice(start, start + perPage).map((p) => pullView(repo, p));
        return paged(items, list.length, req, perPage, page);
      }
      if (method === 'POST') {
        if (!isRecord(req.body)) return err(422, 'Validation Failed: title, head and base are required');
        const title = stringField(req.body, 'title');
        const headRef = stringField(req.body, 'head');
        const baseRef = stringField(req.body, 'base');
        if (title === '' || headRef === '' || baseRef === '') {
          return err(422, 'Validation Failed: title, head and base are required');
        }
        const body = stringField(req.body, 'body');
        const result = createPull(repo, title, body, headRef, baseRef);
        if (!result.ok) return err(result.status, result.message);
        return json(201, pullView(repo, result.pull));
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1], 10);
    if (!Number.isSafeInteger(number) || number <= 0) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (pull === undefined) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return json(200, pullView(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return json(200, diffCommits(repo.index, pull.baseSha, pull.headSha));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) return err(404, 'Not Found');
      if (method !== 'PUT') return err(404, 'Not Found');
      const mergeMethod = isRecord(req.body) ? stringField(req.body, 'merge_method') : '';
      const result = mergePull(repo, pull, mergeMethod);
      if (!result.ok) return err(result.status, result.message);
      return json(200, { merged: true, sha: result.sha, message: result.message });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function handleContents(req: RestRequest, repo: Repo): RestResult {
  const { method } = req;
  const parts = req.segments.slice(4);
  if (parts.length === 0) return err(404, 'Not Found');
  const refish = req.query.get('ref') ?? 'main';
  const branch = isRecord(req.body) && typeof req.body.branch === 'string' ? req.body.branch : refish;

  if (method === 'GET') {
    const tip = resolveRefish(repo, refish);
    if (tip === null) return err(404, 'Not Found');
    const commit = repo.index.commit(tip);
    if (commit === null) return err(404, 'Not Found');
    const found = lookupPath(repo.index, commit.tree, parts);
    if (found === null) {
      // Maybe a directory.
      const children = listDir(repo.index, commit.tree, parts);
      if (children === null) return err(404, 'Not Found');
      return json(200, children.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: [...parts, entry.name].join('/').replace(/^\//, ''),
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.index.get(entry.oid)?.data.length ?? 0),
        download_url: null,
      })));
    }
    if (found.entry.mode === '40000') {
      const children = listDir(repo.index, commit.tree, parts);
      if (children === null) return err(404, 'Not Found');
      return json(200, children.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: [...parts, entry.name].join('/'),
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.index.get(entry.oid)?.data.length ?? 0),
        download_url: null,
      })));
    }
    const blob = repo.index.get(found.entry.oid);
    if (blob === undefined || blob.type !== 'blob') return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: parts[parts.length - 1],
      path: parts.join('/'),
      sha: found.entry.oid,
      content: blob.data.toString('base64'),
      download_url: null,
    });
  }

  if (method === 'PUT') {
    if (!isRecord(req.body)) return err(422, 'Validation Failed: message and content are required');
    const message = stringField(req.body, 'message');
    const contentB64 = stringField(req.body, 'content');
    if (message === '' || contentB64 === '') {
      return err(422, 'Validation Failed: message and content are required');
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const sha = typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const result = writeContents(repo, parts, content, message, branch, sha);
    if (result.status === 404 || result.status === 409) return err(result.status, result.message ?? 'Not Found');
    return json(result.status, {
      content: { sha: result.blobSha, encoding: 'base64', size: content.length },
      commit: { sha: result.commitSha },
    });
  }

  if (method === 'DELETE') {
    if (!isRecord(req.body)) return err(422, 'Validation Failed: message and sha are required');
    const message = stringField(req.body, 'message');
    const sha = typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const result = deleteContents(repo, parts, message, branch, sha);
    if (result.status !== 200) return err(result.status, result.message ?? 'Not Found');
    return json(200, { commit: { sha: result.commitSha } });
  }

  return err(404, 'Not Found');
}
