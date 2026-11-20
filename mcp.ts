// mcp.ts — the Model Context Protocol endpoint at POST /mcp: JSON-RPC 2.0 over plain
// HTTP bodies (no SSE needed — the client accepts a single JSON answer). Speaks the modern
// 2026-07-28 era (`server/discover`) and the legacy handshake (`initialize`) alike.

import {
  createIssue,
  createPull,
  issueView,
  listIssues,
  mergePull,
  pullView,
  repoView,
  type Store,
} from './store.ts';

export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list, built once: two tools/list calls must answer byte for byte identically. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
];

interface ToolOutcome {
  ok: boolean;
  value: unknown;
  error?: string;
}

function toolError(message: string): ToolOutcome {
  return { ok: false, value: { error: message }, error: message };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const num = (key: string): number | null =>
    typeof args[key] === 'number' && Number.isSafeInteger(args[key]) ? (args[key] as number) : null;
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoName === '') return toolError('create_repo requires a name');
      const description = str('description');
      const isPrivate = args.private === true;
      const repo = store.createRepo(repoName, isPrivate, description);
      if (repo === null) return toolError(`repository "${repoName}" already exists`);
      return { ok: true, value: repoView(repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (repo === null) return toolError('repository not found');
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      if (owner === '' || repoName === '' || title === '') {
        return toolError('create_issue requires owner, repo and title');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === null) return toolError('repository not found');
      const result = createIssue(store, repo, title, str('body'), []);
      if (!result.ok) return toolError(result.message);
      return { ok: true, value: issueView(repo, result.issue) };
    }
    case 'list_issues': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = listIssues(repo, { state, perPage: 100, page: 1 });
      const value = { issues: issues.map((issue) => issueView(repo, issue)) };
      return { ok: true, value };
    }
    case 'create_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      const head = str('head');
      const base = str('base');
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return toolError('create_pull_request requires owner, repo, title, head and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === null) return toolError('repository not found');
      const result = createPull(repo, title, str('body'), head, base);
      if (!result.ok) return toolError(result.message);
      return { ok: true, value: pullView(repo, result.pull) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (repo === null) return toolError('repository not found');
      const number = num('pull_number');
      if (number === null) return toolError('merge_pull_request requires pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('pull request not found');
      const result = mergePull(repo, pull, 'squash');
      if (!result.ok) return toolError(result.message);
      return { ok: true, value: { merged: true, sha: result.sha, number, ...pullView(repo, pull) } };
    }
    case 'get_issue': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (repo === null) return toolError('repository not found');
      const number = num('issue_number');
      if (number === null) return toolError('get_issue requires issue_number');
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolError('issue not found');
      return { ok: true, value: issueView(repo, issue) };
    }
    default:
      return toolError(`unknown tool "${name}"`);
  }
}

function rpcResult(id: unknown, result: unknown): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), 'utf8');
}

function rpcError(id: unknown, code: number, message: string): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8');
}

/**
 * Handle one POST /mcp body. Returns the HTTP status and body bytes (JSON-RPC).
 * Notifications (no id) answer HTTP 202 with an empty body.
 */
export function handleMcp(bodyText: string, store: Store): { status: number; body: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: rpcError(null, -32700, 'Parse error: body is not valid JSON'),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 200, body: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object') };
  }
  const record = parsed as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id ?? null;
  const hasId = record.id !== undefined;
  if (method.startsWith('notifications/')) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (method === '') {
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request: missing method') };
  }
  const params = (record.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          },
        }),
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        }),
      };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return { status: 200, body: rpcError(id, -32602, `unknown tool "${toolName}"`) };
      }
      const outcome = callTool(store, toolName, args);
      const text = JSON.stringify(outcome.value);
      const result: Record<string, unknown> = {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
      };
      if (!outcome.ok) result.isError = true;
      return { status: 200, body: rpcResult(id, result) };
    }
    default: {
      void hasId;
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
    }
  }
}
