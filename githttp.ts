// githttp.ts — git smart HTTP: info/refs advertisements (v0/v2), ls-refs, fetch (v0/v2)
// and receive-pack (push). Speaks exactly the framing the suite's git-client parses.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  decodePktLines,
  isAncestor,
  isOid,
  parsePack,
  pktLine,
  pktLines,
  type Packet,
} from './gitcore.ts';
import {
  fetchSelection,
  type Repo,
  type Store,
} from './store.ts';

export interface GitRequest {
  owner: string;
  repoName: string;
  /** '/info/refs' or '/git-upload-pack' or '/git-receive-pack'. */
  suffix: string;
  method: string;
  service: string | null;
  gitProtocolV2: boolean;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, message: string): GitResponse {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

const V2_ADVERTISEMENT = pktLines([
  '# service=git-upload-pack\n',
  'version 2\n',
  'fetch=shallow\n',
  'ls-refs=unborn\n',
  'object-format=sha1\n',
  'flush',
]);

const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo as advertisement lines, HEAD first, branches then tags, sorted. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const tip = repo.defaultTip();
  const branches: string[] = [];
  const tags: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) branches.push(ref);
    else if (ref.startsWith('refs/tags/')) tags.push(ref);
  }
  branches.sort();
  tags.sort();
  if (tip !== undefined) lines.push({ oid: tip, name: 'HEAD' });
  for (const ref of branches) lines.push({ oid: repo.refs.get(ref)!, name: ref });
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    const obj = repo.index.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = repo.index.peel(oid);
      lines.push({ oid, name: ref, peeled: target });
    } else {
      lines.push({ oid, name: ref });
    }
  }
  return lines;
}

/** A v0 advertisement body for one service. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines = refLines(repo);
  const parts: Array<string | Buffer | 'flush'> = [
    `# service=${service}\n`,
  ];
  if (lines.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const first = lines[0];
    parts.push(`${first.oid} ${first.name}\0${caps}\n`);
    for (const line of lines.slice(1)) {
      parts.push(`${line.oid} ${line.name}\n`);
      if (line.peeled !== undefined) parts.push(`${line.peeled} ${line.name}^{}\n`);
    }
  }
  parts.push('flush');
  return pktLines(parts);
}

function advertisementV2Cached(): Buffer {
  return V2_ADVERTISEMENT;
}

/** Sideband framing: band-1 packets, each carrying at most 65515 data bytes. */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) return Buffer.alloc(0);
  for (let pos = 0; pos < data.length; pos += CHUNK) {
    const slice = data.subarray(pos, Math.min(data.length, pos + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: Repo, packets: Packet[]): GitResponse {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    // agent=, object-format=, unborn, command=ls-refs: accepted, no action needed.
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const lines = refLines(repo);
  if (lines.length === 0) {
    // Empty repo: the unborn HEAD line.
    if (keep('HEAD')) out.push(`unborn HEAD symref-target:refs/heads/main\n`);
  } else {
    for (const line of lines) {
      if (!keep(line.name)) continue;
      let text = `${line.oid} ${line.name}`;
      if (line.name === 'HEAD' && symrefs) text += ' symref-target:refs/heads/main';
      if (line.peeled !== undefined && peel) text += ` peeled:${line.peeled}`;
      out.push(`${text}\n`);
    }
  }
  const parts: Array<string | 'flush'> = [...out, 'flush'];
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: pktLines(parts),
  };
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  filter?: string;
}

function parseFetchV2(packets: Packet[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) req.deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) req.filter = line.slice(7).trim();
    // command=fetch, agent=, object-format=, thin-pack, no-progress, ofs-delta, done: ignored.
  }
  return req;
}

function parseFetchV0(packets: Packet[]): FetchRequest {
  // Two sections split by a flush: wants (+shallow/deepen), then haves + done.
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section = 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        req.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
      else if (line.startsWith('deepen-since ')) req.deepenSince = Number.parseInt(line.slice(13), 10);
      else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      // done: ignored.
    }
  }
  return req;
}

function wantedRefs(repo: Repo, wants: readonly string[]): Array<{ oid: string; ref: string }> {
  const wantSet = new Set(wants);
  const out: Array<{ oid: string; ref: string }> = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(ref)!;
    if (wantSet.has(oid)) out.push({ oid, ref });
  }
  return out;
}

function buildFetchV2(repo: Repo, req: FetchRequest): Buffer {
  const cacheKey = JSON.stringify([
    [...req.wants].sort(),
    [...req.haves].sort(),
    [...req.shallow].sort(),
    req.depth ?? null,
    req.deepenSince ?? null,
    [...req.deepenNot].sort(),
    req.filter ?? null,
  ]);
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined && cached.version === repo.version) return cached.body;

  const sel = fetchSelection(repo, req.wants, new Set(req.haves), req.shallow, req.depth);
  const parts: Buffer[] = [];
  const push = (buf: Buffer): void => {
    parts.push(buf);
  };
  // acknowledgments section.
  push(pktLine('acknowledgments\n'));
  if (sel.nak) push(pktLine('NAK\n'));
  else {
    for (const ack of sel.acks) push(pktLine(`ACK ${ack}\n`));
    push(pktLine('ready\n'));
  }
  push(PKT_DELIM);
  // shallow-info section, only when non-empty.
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    push(pktLine('shallow-info\n'));
    for (const oid of sel.shallow) push(pktLine(`shallow ${oid}\n`));
    for (const oid of sel.unshallow) push(pktLine(`unshallow ${oid}\n`));
    push(PKT_DELIM);
  }
  // wanted-refs section, only when non-empty.
  const refs = wantedRefs(repo, req.wants);
  if (refs.length > 0) {
    push(pktLine('wanted-refs\n'));
    for (const ref of refs) push(pktLine(`${ref.oid} ${ref.ref}\n`));
    push(PKT_DELIM);
  }
  // packfile section.
  push(pktLine('packfile\n'));
  if (sel.objects.length > 0) {
    const pack = buildPack(sel.objects);
    push(sideband(pack));
  }
  push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.fetchCache.set(cacheKey, { version: repo.version, body });
  return body;
}

function buildFetchV0(repo: Repo, req: FetchRequest): Buffer {
  const sel = fetchSelection(repo, req.wants, new Set(req.haves), req.shallow, req.depth);
  const parts: Buffer[] = [];
  if (sel.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of sel.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of sel.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of sel.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (sel.objects.length > 0) {
    const pack = buildPack(sel.objects);
    parts.push(sideband(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer): GitResponse {
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return jsonResponse(400, 'malformed pkt-line stream');
  }
  const firstLine = packets.find((p) => p.kind === 'data')?.payload.toString('utf8') ?? '';
  if (firstLine.startsWith('command=ls-refs')) {
    return handleLsRefs(repo, packets);
  }
  if (firstLine.startsWith('command=fetch')) {
    const req = parseFetchV2(packets);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: buildFetchV2(repo, req) };
  }
  // No command line: a v0 fetch (want lines, then flush, then haves).
  const hasWant = packets.some((p) => p.kind === 'data' && p.payload.toString('utf8').startsWith('want '));
  if (hasWant) {
    const req = parseFetchV0(packets);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: buildFetchV0(repo, req) };
  }
  return jsonResponse(400, 'unrecognized git-upload-pack request');
}

// ---------------------------------------------------------------- receive-pack (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  // The body is command pkt-lines up to the first flush, then raw pack bytes (which are
  // NOT pkt-lines, so scan incrementally instead of decoding the whole body at once).
  const commands: PushCommand[] = [];
  let pos = 0;
  let sawFlush = false;
  let packStart = body.length;
  while (pos + 4 <= body.length) {
    const head = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return jsonResponse(400, 'malformed pkt-line stream');
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      sawFlush = true;
      packStart = pos + 4;
      break;
    }
    if (len < 4 || len > 65520 || pos + len > body.length) return jsonResponse(400, 'malformed pkt-line stream');
    let line = body.toString('utf8', pos + 4, pos + len);
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      return jsonResponse(400, 'malformed push command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    pos += len;
  }
  if (!sawFlush) return jsonResponse(400, 'push command list has no flush');
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes);
      for (const [oid, obj] of parsed.objects) repo.index.putExisting(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  // Validate every command against the pre-push refs, then apply the passing ones.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const toApply: PushCommand[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = true;
    let reason = '';
    if (!unpackOk) {
      ok = false;
      reason = 'unpack failed';
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (!repo.index.has(cmd.newOid)) {
        ok = false;
        reason = 'object not found';
      }
    } else {
      // Update.
      if (current === undefined || current !== cmd.oldOid) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (!repo.index.has(cmd.newOid)) {
        ok = false;
        reason = 'object not found';
      } else if (!isAncestor(repo.index, cmd.oldOid, cmd.newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    results.push({ ref: cmd.ref, ok, reason });
    if (ok) toApply.push(cmd);
  }
  for (const cmd of toApply) {
    if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.newOid);
  }
  if (toApply.length > 0 || packBytes.length > 0) repo.touch();
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = pktLines(reportLines);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: outer };
}

// ---------------------------------------------------------------- entry point

/** Route one git smart-HTTP request. Returns null when the path is not a git path. */
export function handleGit(req: GitRequest, store: Store): GitResponse | null {
  if (!req.suffix.startsWith('/info/refs') && req.suffix !== '/git-upload-pack' && req.suffix !== '/git-receive-pack') {
    return null;
  }
  const repo = store.getRepo(req.owner, req.repoName);
  if (repo === null) return jsonResponse(404, 'Not Found');
  if (req.method === 'GET' && req.suffix === '/info/refs') {
    if (req.service === 'git-upload-pack') {
      if (req.gitProtocolV2) {
        // Cache the v0 advertisement per repo version; v2 is a constant.
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2Cached() };
      }
      let cached = repo.cachedAdvV0;
      if (cached === null || cached.version !== repo.version) {
        cached = { version: repo.version, body: advertisementV0(repo, 'git-upload-pack') };
        repo.cachedAdvV0 = cached;
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: cached.body };
    }
    if (req.service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0(repo, 'git-receive-pack') };
    }
    return jsonResponse(404, 'Not Found');
  }
  if (req.method === 'POST' && req.suffix === '/git-upload-pack') {
    return handleUploadPack(repo, req.body);
  }
  if (req.method === 'POST' && req.suffix === '/git-receive-pack') {
    return handleReceivePack(repo, req.body);
  }
  return jsonResponse(404, 'Not Found');
}
