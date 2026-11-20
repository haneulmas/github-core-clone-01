// app.ts — the HTTP server: auth, routing, body reading, and response framing.
// Surfaces: git smart HTTP (/{owner}/{repo}.git), REST v3 (/api/v3), GraphQL (/api/graphql),
// MCP (/mcp), and the public probes (/healthz, /api/v3, /api/v3/meta).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the trial sets (MAKEFUN_SHOP_TOKEN); empty locally, where any
 * non-empty Bearer is accepted. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** One store per process: REST, GraphQL, MCP and git all share it. */
const store = new Store();

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Whether this request's Authorization header passes (public probes are checked by the caller). */
function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON_TYPE, Buffer.from(JSON.stringify(value), 'utf8'), extra);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        // A handler must never take the server down: answer 500 JSON and stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do for this socket.
          }
        }
      }
    })();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  // Fast path parsing: split the raw target manually (a URL object per request is
  // measurable on the 2,000-read workload); the query string is parsed only when present.
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = qIndex < 0 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(qIndex + 1));

  // Public probes: the env's boot check and the API root/meta (no token needed).
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // Everything else needs the bearer token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // GET/HEAD carry no body; every other method may (REST, GraphQL, MCP, git POSTs,
  // and DELETE /contents). Skipping the read on GETs keeps the read workload fast.
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const segments = path.split('/').filter((s) => s !== '').map(decodeSegment);

  // Git smart HTTP: /{owner}/{repo}.git[/...]
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]);
    const repoName = decodeSegment(gitMatch[2]);
    const suffix = gitMatch[3] ?? '';
    const result = handleGit(
      {
        owner,
        repoName,
        suffix,
        method,
        service: query.get('service'),
        gitProtocolV2: (req.headers['git-protocol'] ?? '') === 'version=2',
        body,
      },
      store,
    );
    if (result !== null) {
      send(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restSegments = segments.slice(2);
    let parsedBody: unknown = null;
    let bodyMalformed = false;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        bodyMalformed = true;
      }
    }
    const host = req.headers.host ?? '127.0.0.1';
    const result = handleRest(
      {
        method,
        segments: restSegments,
        query,
        body: parsedBody,
        bodyMalformed,
        origin: `http://${host}`,
      },
      store,
    );
    send(res, result.status, JSON_TYPE, result.buf, result.headers ?? {});
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let parsedBody: unknown = null;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
    }
    const result = handleGraphQL(parsedBody, store);
    sendJson(res, 200, result);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const result = handleMcp(body.toString('utf8'), store);
    if (result.body.length === 0) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    send(res, result.status, JSON_TYPE, result.body);
    return;
  }

  // Everything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
