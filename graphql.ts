// graphql.ts — a small GraphQL engine for the fixed documents the suite sends:
// query/mutation operations, variables, aliases, arguments (literals, variables, enums,
// lists, input objects), inline fragments, and __type introspection. Unknown fields answer
// HTTP 200 with an errors array naming the field and data:null, as the suite requires.

import {
  addComment,
  closeIssue,
  createIssue,
  createPull,
  decodeGlobalId,
  diffCommits,
  globalId,
  mergePull,
  pullConflict,
  FIXED_TS,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  children: SelectionNode[] | null;
}

interface FragmentNode {
  fragment: true;
  typeName: string;
  children: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
        this.pos += 1;
        continue;
      }
      if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }

  /** True when the next non-ignored characters are exactly `text`. */
  startsWith(text: string): boolean {
    this.skipIgnored();
    return this.src.startsWith(text, this.pos);
  }

  peekWord(): string {
    this.skipIgnored();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    return m === null ? '' : m[0];
  }

  expectChar(ch: string): void {
    this.skipIgnored();
    if (this.src[this.pos] !== ch) throw new ParseError(`expected '${ch}' at ${this.pos}`);
    this.pos += 1;
  }

  takeChar(ch: string): boolean {
    this.skipIgnored();
    if (this.src[this.pos] !== ch) return false;
    this.pos += 1;
    return true;
  }

  takeWord(word: string): boolean {
    this.skipIgnored();
    if (!this.src.startsWith(word, this.pos)) return false;
    const after = this.src[this.pos + word.length];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) return false;
    this.pos += word.length;
    return true;
  }

  takeName(): string {
    this.skipIgnored();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (m === null) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  takeString(): string {
    this.skipIgnored();
    if (this.src[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) throw new ParseError('unterminated string');
      const c = this.src[this.pos];
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (c === '\\') {
        const esc = this.src[this.pos + 1];
        this.pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === '/') out += '/';
        else if (esc === '\\') out += '\\';
        else if (esc === '"') out += '"';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else throw new ParseError(`bad escape \\${esc ?? ''}`);
        continue;
      }
      out += c;
      this.pos += 1;
    }
  }

  takeNumber(): { int: boolean; value: number } {
    this.skipIgnored();
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.src.slice(this.pos));
    if (m === null) throw new ParseError(`expected a number at ${this.pos}`);
    this.pos += m[0].length;
    const isFloat = m[0].includes('.') || /[eE]/.test(m[0]);
    return { int: !isFloat, value: Number(m[0]) };
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.src.length;
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const c = lexer.peek();
  if (c === '$') {
    lexer.expectChar('$');
    return { kind: 'var', name: lexer.takeName() };
  }
  if (c === '"') return { kind: 'string', value: lexer.takeString() };
  if (c === '[') {
    lexer.expectChar('[');
    const values: ValueNode[] = [];
    while (!lexer.takeChar(']')) values.push(parseValue(lexer));
    return { kind: 'list', values };
  }
  if (c === '{') {
    lexer.expectChar('{');
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (!lexer.takeChar('}')) {
      const name = lexer.takeName();
      lexer.expectChar(':');
      fields.push({ name, value: parseValue(lexer) });
    }
    return { kind: 'object', fields };
  }
  if (c === '-' || (c >= '0' && c <= '9')) {
    const num = lexer.takeNumber();
    return num.int ? { kind: 'int', value: num.value } : { kind: 'float', value: num.value };
  }
  const word = lexer.takeName();
  if (word === 'true') return { kind: 'bool', value: true };
  if (word === 'false') return { kind: 'bool', value: false };
  if (word === 'null') return { kind: 'null' };
  if (word === '') throw new ParseError(`unexpected character '${c}'`);
  return { kind: 'enum', value: word };
}

function parseSelectionSet(lexer: Lexer): SelectionNode[] {
  lexer.expectChar('{');
  const selections: SelectionNode[] = [];
  while (!lexer.takeChar('}')) {
    if (lexer.startsWith('...')) {
      // Inline fragment `... on Type { ... }` (fragment spreads are not in the suite's docs).
      lexer.expectChar('.');
      lexer.expectChar('.');
      lexer.expectChar('.');
      if (!lexer.takeWord('on')) throw new ParseError('fragment spreads are not supported');
      const typeName = lexer.takeName();
      const children = parseSelectionSet(lexer);
      selections.push({ fragment: true, typeName, children });
      continue;
    }
    const first = lexer.takeName();
    let alias: string | null = null;
    let name = first;
    if (lexer.takeChar(':')) {
      alias = first;
      name = lexer.takeName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (lexer.takeChar('(')) {
      while (!lexer.takeChar(')')) {
        const argName = lexer.takeName();
        lexer.expectChar(':');
        args.push({ name: argName, value: parseValue(lexer) });
      }
    }
    const children = lexer.peek() === '{' ? parseSelectionSet(lexer) : null;
    selections.push({ alias, name, args, children });
  }
  return selections;
}

function parseType(lexer: Lexer): void {
  // A variable type: Name, [T], with optional trailing '!'. Values are not needed.
  if (lexer.takeChar('[')) {
    parseType(lexer);
    lexer.expectChar(']');
  } else {
    lexer.takeName();
  }
  lexer.takeChar('!');
}

function parseOperation(lexer: Lexer): Operation {
  let type: 'query' | 'mutation' = 'query';
  if (lexer.takeWord('query')) type = 'query';
  else if (lexer.takeWord('mutation')) type = 'mutation';
  let name: string | null = null;
  if (lexer.peek() !== '{' && lexer.peek() !== '(') {
    name = lexer.takeName();
  }
  const varDefs: VarDef[] = [];
  if (lexer.takeChar('(')) {
    while (!lexer.takeChar(')')) {
      lexer.expectChar('$');
      const varName = lexer.takeName();
      lexer.expectChar(':');
      parseType(lexer);
      let defaultValue: ValueNode | null = null;
      if (lexer.takeChar('=')) defaultValue = parseValue(lexer);
      varDefs.push({ name: varName, defaultValue });
    }
  }
  const selections = parseSelectionSet(lexer);
  return { type, name, varDefs, selections };
}

export function parseDocument(src: string): Operation[] {
  const lexer = new Lexer(src);
  const operations: Operation[] = [];
  while (!lexer.atEnd()) operations.push(parseOperation(lexer));
  if (operations.length === 0) throw new ParseError('empty document');
  return operations;
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema / resolvers

interface GqlSource {
  __type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  commentId?: number;
  commentBody?: string;
  typeRecord?: TypeRecord;
  fieldList?: string[];
  enumList?: string[];
}

interface TypeRecord {
  name: string;
  kind: string;
  fields: string[];
  enumValues: string[];
}

const TYPE_RECORDS: Record<string, TypeRecord> = {
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'url'],
    enumValues: [],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt'],
    enumValues: [],
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt'],
    enumValues: [],
  },
  User: {
    name: 'User',
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email'],
    enumValues: [],
  },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER'],
  },
  IssueState: {
    name: 'IssueState',
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    name: 'PullRequestState',
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
};

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function issueSource(repo: Repo, issue: Issue): GqlSource {
  return { __type: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): GqlSource {
  return { __type: 'PullRequest', repo, pull };
}

function repoSource(repo: Repo): GqlSource {
  return { __type: 'Repository', repo };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function seqOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    return m === null ? null : Number.parseInt(m[1], 10);
  } catch {
    return null;
  }
}

interface Connection {
  __type: string;
  nodes: GqlSource[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Connection {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'asc' : orderBy?.direction === 'DESC' ? 'desc' : 'asc';
  let list = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s)));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const afterSeq = seqOfCursor(args.after);
  if (afterSeq !== null) {
    list = list.filter((i) => (direction === 'asc' ? i.seq > afterSeq : i.seq < afterSeq));
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].seq) : null;
  const startCursor = page.length > 0 ? cursorFor(page[0].seq) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueSource(repo, issue)),
    pageInfo: { hasNextPage, hasPreviousPage: false, startCursor, endCursor },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Connection {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  if (states !== null) {
    const wanted = new Set(states);
    list = list.filter((p) => wanted.has(pullState(p)));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  const afterSeq = seqOfCursor(args.after);
  if (afterSeq !== null) list = list.filter((p) => p.seq < afterSeq);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullSource(repo, pull)),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1].seq) : null,
    },
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Connection {
  const changes = diffCommits(repo.index, pull.baseSha, pull.headSha);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : changes.length;
  const page = changes.slice(0, first);
  return {
    __type: 'PullRequestFileConnection',
    nodes: page.map((change) => ({ __type: 'PullRequestFile', path: change.filename }) as unknown as GqlSource),
    pageInfo: {
      hasNextPage: changes.length > page.length,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
}

/** Field resolvers per type: name -> (source, args, ctx) => value (scalar, GqlSource, or list). */
type Resolver = (source: GqlSource, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface ExecCtx {
  store: Store;
}

function decodeRepoId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  return store.getRepo(decoded.owner, decoded.name);
}

function decodeIssueId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I' || decoded.num === undefined) return null;
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === null) return null;
  const issue = repo.issues.get(decoded.num);
  return issue === undefined ? null : { repo, issue };
}

function decodePullId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PR' || decoded.num === undefined) return null;
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === null) return null;
  const pull = repo.pulls.get(decoded.num);
  return pull === undefined ? null : { repo, pull };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User' }) as GqlSource,
    repository: (_src, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ctx.store.getRepo(owner, name);
      return repo === null ? null : repoSource(repo);
    },
    node: (_src, args, ctx) => {
      const id = args.id as string;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (repo === null) return null;
      if (decoded.kind === 'R') return repoSource(repo);
      if (decoded.kind === 'I' && decoded.num !== undefined) {
        const issue = repo.issues.get(decoded.num);
        return issue === undefined ? null : issueSource(repo, issue);
      }
      if (decoded.kind === 'PR' && decoded.num !== undefined) {
        const pull = repo.pulls.get(decoded.num);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      if (decoded.kind === 'C' && decoded.num !== undefined && decoded.sub !== undefined) {
        const issue = repo.issues.get(decoded.num);
        const comment = issue?.comments.find((c) => c.id === decoded.sub);
        if (comment === undefined || issue === undefined) return null;
        return { __type: 'IssueComment', repo, issue, commentId: comment.id, commentBody: comment.body } as GqlSource;
      }
      return null;
    },
    __type: (_src, args) => {
      const name = args.name as string;
      const record = TYPE_RECORDS[name];
      if (record === undefined) return null;
      return { __type: '__Type', typeRecord: record } as GqlSource;
    },
  },
  User: {
    login: () => VIEWER_LOGIN,
    id: () => globalId('R', VIEWER_LOGIN, ''),
    name: () => VIEWER_NAME,
    email: () => VIEWER_EMAIL,
  },
  Repository: {
    id: (src) => globalId('R', src.repo!.owner, src.repo!.name),
    databaseId: (src) => src.repo!.id,
    name: (src) => src.repo!.name,
    nameWithOwner: (src) => `${src.repo!.owner}/${src.repo!.name}`,
    owner: () => ({ __type: 'User' }) as GqlSource,
    defaultBranchRef: () => ({ __type: 'BranchRef', name: 'main' }) as unknown as GqlSource,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (src) => src.repo!.description,
    isPrivate: (src) => src.repo!.private,
    createdAt: () => FIXED_TS,
    issue: (src, args) => {
      const issue = src.repo!.issues.get(args.number as number);
      return issue === undefined ? null : issueSource(src.repo!, issue);
    },
    issues: (src, args) => issuesConnection(src.repo!, args),
    pullRequests: (src, args) => pullsConnection(src.repo!, args),
    pullRequest: (src, args) => {
      const pull = src.repo!.pulls.get(args.number as number);
      return pull === undefined ? null : pullSource(src.repo!, pull);
    },
  },
  BranchRef: {
    name: (src) => (src as unknown as { name: string }).name,
  },
  Issue: {
    id: (src) => globalId('I', src.repo!.owner, src.repo!.name, src.issue!.number),
    number: (src) => src.issue!.number,
    title: (src) => src.issue!.title,
    state: (src) => issueState(src.issue!),
    body: (src) => src.issue!.body,
    createdAt: () => FIXED_TS,
    url: (src) => `https://github.com/${src.repo!.owner}/${src.repo!.name}/issues/${src.issue!.number}`,
  },
  PullRequest: {
    id: (src) => globalId('PR', src.repo!.owner, src.repo!.name, src.pull!.number),
    number: (src) => src.pull!.number,
    title: (src) => src.pull!.title,
    body: (src) => src.pull!.body,
    state: (src) => pullState(src.pull!),
    merged: (src) => src.pull!.merged,
    headRefName: (src) => src.pull!.headRef,
    baseRefName: (src) => src.pull!.baseRef,
    mergeable: (src) => (pullConflict(src.repo!, src.pull!) ? 'CONFLICTING' : 'MERGEABLE'),
    createdAt: () => FIXED_TS,
    files: (src, args) => filesConnection(src.repo!, src.pull!, args),
  },
  PullRequestFile: {
    path: (src) => (src as unknown as { path: string }).path,
  },
  IssueConnection: {
    nodes: (src) => (src as unknown as Connection).nodes,
    pageInfo: (src) => (src as unknown as Connection).pageInfo,
    totalCount: (src) => (src as unknown as Connection).nodes.length,
  },
  PullRequestConnection: {
    nodes: (src) => (src as unknown as Connection).nodes,
    pageInfo: (src) => (src as unknown as Connection).pageInfo,
    totalCount: (src) => (src as unknown as Connection).nodes.length,
  },
  PullRequestFileConnection: {
    nodes: (src) => (src as unknown as Connection).nodes,
    pageInfo: (src) => (src as unknown as Connection).pageInfo,
    totalCount: (src) => (src as unknown as Connection).nodes.length,
  },
  PageInfo: {
    hasNextPage: (src) => (src as unknown as Connection['pageInfo']).hasNextPage,
    hasPreviousPage: (src) => (src as unknown as Connection['pageInfo']).hasPreviousPage,
    startCursor: (src) => (src as unknown as Connection['pageInfo']).startCursor,
    endCursor: (src) => (src as unknown as Connection['pageInfo']).endCursor,
  },
  __Type: {
    name: (src) => src.typeRecord!.name,
    kind: (src) => src.typeRecord!.kind,
    fields: (src) => src.typeRecord!.fields.map((name) => ({ __type: '__Field', name }) as GqlSource),
    enumValues: (src) => src.typeRecord!.enumValues.map((name) => ({ __type: '__EnumValue', name }) as GqlSource),
  },
  __Field: {
    name: (src) => (src as unknown as { name: string }).name,
  },
  __EnumValue: {
    name: (src) => (src as unknown as { name: string }).name,
  },
  IssueComment: {
    id: (src) => globalId('C', src.repo!.owner, src.repo!.name, src.issue!.number, src.commentId!),
    body: (src) => src.commentBody ?? '',
  },
  IssueCommentEdge: {
    node: (src) => (src as unknown as { node: GqlSource }).node,
  },
  Mutation: {
    createIssue: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoId(ctx.store, input.repositoryId);
      if (repo === null) return { __type: 'CreateIssuePayload', issue: null } as unknown as GqlSource;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const result = createIssue(ctx.store, repo, title, body, []);
      if (!result.ok) return { __type: 'CreateIssuePayload', issue: null } as unknown as GqlSource;
      return {
        __type: 'CreateIssuePayload',
        issue: issueSource(repo, result.issue),
      } as unknown as GqlSource;
    },
    closeIssue: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIssueId(ctx.store, input.issueId);
      if (found === null) return { __type: 'CloseIssuePayload', issue: null } as unknown as GqlSource;
      closeIssue(found.repo, found.issue);
      return {
        __type: 'CloseIssuePayload',
        issue: issueSource(found.repo, found.issue),
      } as unknown as GqlSource;
    },
    createPullRequest: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoId(ctx.store, input.repositoryId);
      if (repo === null) return { __type: 'CreatePullRequestPayload', pullRequest: null } as GqlSource;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const result = createPull(repo, title, body, head, base);
      if (!result.ok) return { __type: 'CreatePullRequestPayload', pullRequest: null } as GqlSource;
      return {
        __type: 'CreatePullRequestPayload',
        pullRequest: pullSource(repo, result.pull),
      } as unknown as GqlSource;
    },
    mergePullRequest: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodePullId(ctx.store, input.pullRequestId);
      if (found === null) return { __type: 'MergePullRequestPayload', pullRequest: null } as GqlSource;
      mergePull(found.repo, found.pull, 'squash');
      return {
        __type: 'MergePullRequestPayload',
        pullRequest: pullSource(found.repo, found.pull),
      } as unknown as GqlSource;
    },
    addComment: (_src, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIssueId(ctx.store, input.subjectId);
      if (found === null) return { __type: 'AddCommentPayload', commentEdge: null } as GqlSource;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addComment(found.repo, found.issue, body);
      const edge = {
        __type: 'IssueCommentEdge',
        node: {
          __type: 'IssueComment',
          repo: found.repo,
          issue: found.issue,
          commentId: comment.id,
          commentBody: comment.body,
        },
      } as unknown as GqlSource;
      return { __type: 'AddCommentPayload', commentEdge: edge } as unknown as GqlSource;
    },
  },
  CreateIssuePayload: {
    issue: (src) => (src as unknown as { issue: GqlSource | null }).issue,
  },
  CloseIssuePayload: {
    issue: (src) => (src as unknown as { issue: GqlSource | null }).issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (src) => (src as unknown as { pullRequest: GqlSource | null }).pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (src) => (src as unknown as { pullRequest: GqlSource | null }).pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (src) => (src as unknown as { commentEdge: GqlSource | null }).commentEdge,
  },
};

/** The object type a field's sub-selection resolves against. */
const FIELD_RETURN_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'BranchRef',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestFileConnection' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
};

function resolveSelections(
  typeName: string,
  source: GqlSource,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: ExecCtx,
  errors: Array<{ message: string }>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const resolvers = RESOLVERS[typeName] ?? {};
  for (const selection of selections) {
    if ('fragment' in selection) {
      // Inline fragment: applies when its type matches the current concrete type.
      if (selection.typeName === typeName || selection.typeName === 'Node') {
        const nested = resolveSelections(typeName, source, selection.children, variables, ctx, errors);
        if (nested === null) return null;
        Object.assign(out, nested);
      }
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = resolvers[field.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}"` });
      return null;
    }
    const args = argsOf(field, variables);
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (field.children === null) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    let childType = FIELD_RETURN_TYPE[typeName]?.[field.name];
    if (childType === undefined) {
      // A nested selection on a field whose return type is not mapped: use the value's own type.
      childType = (value as GqlSource).__type ?? typeName;
    }
    if (childType === 'Node') {
      childType = (value as GqlSource).__type ?? typeName;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (item === null) {
          items.push(null);
          continue;
        }
        const itemType = (item as GqlSource).__type ?? childType;
        const resolved = resolveSelections(itemType, item as GqlSource, field.children, variables, ctx, errors);
        if (resolved === null) return null;
        items.push(resolved);
      }
      out[key] = items;
      continue;
    }
    if (typeof value === 'object') {
      const valueType = (value as GqlSource).__type ?? childType;
      const resolved = resolveSelections(valueType, value as GqlSource, field.children, variables, ctx, errors);
      if (resolved === null) return null;
      out[key] = resolved;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(
  operation: Operation,
  variables: Record<string, unknown>,
  ctx: ExecCtx,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const vars: Record<string, unknown> = {};
  for (const def of operation.varDefs) {
    if (def.defaultValue !== null) vars[def.name] = resolveValue(def.defaultValue, variables);
  }
  for (const [name, value] of Object.entries(variables)) vars[name] = value;
  const errors: Array<{ message: string }> = [];
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const rootSource = { __type: rootType } as GqlSource;
  const data = resolveSelections(rootType, rootSource, operation.selections, vars, ctx, errors);
  if (data === null || errors.length > 0) {
    return { data: null, errors: errors.length > 0 ? errors : [{ message: 'execution failed' }] };
  }
  return { data };
}

/**
 * Execute one GraphQL request body (a single operation object or a batch array).
 * Returns the response object (or array) to serialize.
 */
export function handleGraphQL(body: unknown, store: Store): unknown {
  const ctx: ExecCtx = { store };
  const runOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'request body must be a JSON object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'request body must include a query string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = parseDocument(record.query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
    }
    let operation = operations[0]!;
    if (typeof record.operationName === 'string') {
      const named = operations.find((op) => op.name === record.operationName);
      if (named !== undefined) operation = named;
    }
    return executeOperation(operation, variables, ctx);
  };
  if (Array.isArray(body)) return body.map((entry) => runOne(entry));
  return runOne(body);
}
