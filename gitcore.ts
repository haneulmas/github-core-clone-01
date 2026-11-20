// gitcore.ts — pure git primitives: object hashing, pkt-lines, packfiles (read/write,
// including OFS/REF delta resolution), commit/tree codecs, reachability and line diffs.
// No I/O, no store knowledge beyond a Map of objects. Deterministic throughout.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface Obj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 hex of raw bytes. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The loose-object header `<type> <size>\0`. */
export function objectHeader(type: ObjType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** A git object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(objectHeader(type, data.length));
  h.update(data);
  return h.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

export type Packet =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'data'; payload: Buffer };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a mixed sequence; 'flush' / 'delim' are the control packets. */
export function pktLines(parts: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(PKT_FLUSH);
    else if (part === 'delim') out.push(PKT_DELIM);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/**
 * Decode a whole buffer into packets. Throws on a malformed header or a truncated packet;
 * callers that must stay up on garbage (malformed upload-pack bodies) catch and answer 400.
 */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
    } else if (len === 2) {
      // response-end (0002): treat like a flush for our purposes.
      packets.push({ kind: 'flush' });
      pos += 4;
    } else if (len < 4 || len > 65520) {
      throw new Error(`invalid pkt-line length ${len}`);
    } else {
      if (pos + len > buf.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return packets;
}

// ---------------------------------------------------------------- packfiles

/** Find the exact end of the zlib stream starting at `pos` (inflateSync ignores trailing bytes,
 * so the smallest end that inflates is the stream's end). Doubling search, then binary search.
 * Only used when the re-deflate fast path in parsePack misses (a foreign deflater). */
function zlibStreamEndSlow(buf: Buffer, pos: number, limit: number): number {
  const ok = (end: number): boolean => {
    try {
      zlibInflate(buf.subarray(pos, end));
      return true;
    } catch {
      return false;
    }
  };
  let lo = pos + 1;
  let step = 32;
  let hi = Math.min(limit, pos + step);
  while (hi < limit && !ok(hi)) {
    lo = hi;
    step *= 2;
    hi = Math.min(limit, pos + step);
  }
  if (!ok(hi)) throw new Error('unterminated zlib stream in pack');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Read a git varint: first byte low 4 bits, then 7 bits per byte, little-endian groups. */
function readSizeEncoding(buf: Buffer, pos: number): { size: number; next: number } {
  let byte = buf[pos];
  let size = byte & 0x0f;
  let shift = 4;
  pos += 1;
  while (byte & 0x80) {
    byte = buf[pos];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { size, next: pos };
}

/** Read an OFS_DELTA offset varint. */
function readOfsEncoding(buf: Buffer, pos: number): { offset: number; next: number } {
  let byte = buf[pos];
  let offset = byte & 0x7f;
  pos += 1;
  while (byte & 0x80) {
    byte = buf[pos];
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { offset, next: pos };
}

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      out |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return out;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks, produced);
  if (out.length !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface ParsedPack {
  objects: Map<string, Obj>;
  deltaCount: number;
}

/**
 * Parse a packfile (version 2): `PACK` + count + entries + 20-byte SHA-1 trailer.
 * Resolves OFS_DELTA and REF_DELTA entries. Verifies the trailer checksum.
 */
export function parsePack(buf: Buffer): ParsedPack {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, Obj>();
  // Entries in file order, for OFS_DELTA base lookup by position.
  const byPosition = new Map<number, Obj>();
  let deltaCount = 0;
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = buf[pos];
    const typeNum = (byte >> 4) & 7;
    const { size, next } = readSizeEncoding(buf, pos);
    pos = next;
    let baseObj: Obj | null = null;
    if (typeNum === 6) {
      const { offset, next: afterOfs } = readOfsEncoding(buf, pos);
      pos = afterOfs;
      baseObj = byPosition.get(entryStart - offset) ?? null;
      if (baseObj === null) throw new Error('ofs-delta base not found');
      deltaCount += 1;
    } else if (typeNum === 7) {
      const baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
      baseObj = objects.get(baseOid) ?? null;
      if (baseObj === null) throw new Error('ref-delta base not found');
      deltaCount += 1;
    } else if (!(typeNum in CODE_TYPE)) {
      throw new Error(`unknown pack entry type ${typeNum}`);
    }
    // Inflate the stream at `pos` (inflateSync stops at the first stream's end and ignores
    // the bytes after it). Fast path for the end: re-deflating the output with the same
    // default settings reproduces the client's bytes exactly, so the stream's length is
    // the re-deflated length; a foreign deflater falls back to the slow search.
    const raw = zlibInflate(buf.subarray(pos, buf.length - 20));
    const recompressed = zlibDeflate(raw);
    let end: number;
    if (
      pos + recompressed.length <= buf.length - 20 &&
      buf.subarray(pos, pos + recompressed.length).equals(recompressed)
    ) {
      end = pos + recompressed.length;
    } else {
      end = zlibStreamEndSlow(buf, pos, buf.length - 20);
    }
    pos = end;
    let obj: Obj;
    if (baseObj !== null) {
      const data = applyDelta(baseObj.data, raw);
      obj = { type: baseObj.type, data };
    } else {
      if (raw.length !== size) throw new Error('pack entry size mismatch');
      obj = { type: CODE_TYPE[typeNum], data: Buffer.from(raw) };
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byPosition.set(entryStart, obj);
  }
  if (pos + 20 > buf.length) throw new Error('pack truncated before trailer');
  const expected = buf.toString('hex', pos, pos + 20);
  const actual = sha1(buf.subarray(0, pos));
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  return { objects, deltaCount };
}

/** Write a packfile of plain (undeltified) objects, entries sorted by oid for determinism. */
export function buildPack(entries: ReadonlyArray<Obj>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const entry of sorted) {
    const size = entry.data.length;
    const typeNum = TYPE_CODE[entry.type];
    // varint header: first byte (type << 4) | (size & 0x0f), then 7-bit groups.
    const headBytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeNum << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(zlibDeflate(entry.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

// ---------------------------------------------------------------- commits / trees

export interface Identity {
  name: string;
  email: string;
  timestamp: number;
}

export const CONFORMANCE_IDENTITY: Identity = {
  name: 'Conformance',
  email: 'conformance@make.fun',
  timestamp: 1700000000,
};

/** Build commit bytes exactly like the suite's buildCommit: tree, parents, author, committer,
 * blank line, message (message is used verbatim). */
export function buildCommitBytes(opts: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: Identity;
  committer: Identity;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author.name} <${opts.author.email}> ${opts.author.timestamp} +0000`);
  lines.push(`committer ${opts.committer.name} <${opts.committer.email}> ${opts.committer.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorTs: number;
  message: string;
}

/** Parse commit bytes. Returns null when the bytes are not a well-formed commit. */
export function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank < 0) return null;
  const header = text.slice(0, blank);
  const message = text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let authorTs = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) authorTs = Number.parseInt(m[1], 10);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!isOid(tree)) return null;
  return { tree, parents, author, committer, authorTs, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse tree bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** git's tree sort: entries compared by name, directories as if suffixed with '/'. */
export function compareTreeNames(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Build tree bytes from entries, sorted in git order. */
export function buildTreeBytes(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(x.name, x.mode === '40000', y.name, y.mode === '40000'),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tag object: the `object` line is its target commit. */
export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- object index

/** Per-repo object store with parsed-commit/tree caches. */
export class ObjIndex {
  readonly objects = new Map<string, Obj>();
  private readonly commitCache = new Map<string, ParsedCommit | null>();
  private readonly treeCache = new Map<string, TreeEntry[] | null>();

  get(oid: string): Obj | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.commitCache.delete(oid);
      this.treeCache.delete(oid);
    }
    return oid;
  }

  putExisting(oid: string, obj: Obj): void {
    if (!this.objects.has(oid)) this.objects.set(oid, obj);
  }

  commit(oid: string): ParsedCommit | null {
    let cached = this.commitCache.get(oid);
    if (cached === undefined) {
      const obj = this.objects.get(oid);
      cached = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
      this.commitCache.set(oid, cached);
    }
    return cached;
  }

  tree(oid: string): TreeEntry[] | null {
    let cached = this.treeCache.get(oid);
    if (cached === undefined) {
      const obj = this.objects.get(oid);
      cached = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : null;
      this.treeCache.set(oid, cached);
    }
    return cached;
  }

  /** The commit a tag points at (peeling), or the oid itself when it is not a tag. */
  peel(oid: string): string {
    const obj = this.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) return this.peel(target);
    }
    return oid;
  }
}

// ---------------------------------------------------------------- reachability

export interface Reachable {
  /** commit oid -> distance from the nearest root (0 = a root itself). */
  commits: Map<string, number>;
  trees: Set<string>;
  blobs: Set<string>;
  tags: Set<string>;
}

/**
 * Walk from `roots`: every commit reachable through parents, plus each commit's tree (recursive)
 * and the tags met on the way. `maxDepth` (when set) keeps only commits with distance < maxDepth.
 * A commit already at `exclude` distance is still walked for ancestry only when it is not excluded.
 */
export function collectReachable(
  index: ObjIndex,
  roots: ReadonlyArray<string>,
  maxDepth?: number,
): Reachable {
  const commits = new Map<string, number>();
  const trees = new Set<string>();
  const blobs = new Set<string>();
  const tags = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const root of roots) queue.push({ oid: root, dist: 0 });
  const seenTrees = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (seenTrees.has(treeOid)) return;
    seenTrees.add(treeOid);
    trees.add(treeOid);
    const entries = index.tree(treeOid);
    if (entries === null) return;
    for (const entry of entries) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else blobs.add(entry.oid);
    }
  };
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (maxDepth !== undefined && dist >= maxDepth) continue;
    const obj = index.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (tags.has(oid)) continue;
      tags.add(oid);
      const target = parseTagTarget(obj.data);
      if (target !== null) queue.push({ oid: target, dist });
      continue;
    }
    if (obj.type !== 'commit') continue;
    const known = commits.get(oid);
    if (known !== undefined && known <= dist) continue;
    commits.set(oid, dist);
    const parsed = index.commit(oid);
    if (parsed === null) continue;
    walkTree(parsed.tree);
    for (const parent of parsed.parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  return { commits, trees, blobs, tags };
}

/** True when `ancestor` is reachable from `descendant` through parent links (or equal). */
export function isAncestor(index: ObjIndex, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = index.commit(oid);
    if (parsed === null) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return false;
}

/** Newest-first list of commit oids reachable from `tip` (BFS by commit time order is not
 * guaranteed, so callers that need strict order sort by timestamp; the REST list uses the
 * commit graph order from a DFS that follows first parents in timestamp order). */
export function listCommitsFrom(index: ObjIndex, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // DFS with a stack ordered so the newest commit (by author timestamp, then insertion) comes first.
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = index.commit(oid);
    if (parsed === null) continue;
    out.push(oid);
    const parents = [...parsed.parents].sort((a, b) => {
      const pa = index.commit(a);
      const pb = index.commit(b);
      // Ascending: the newest parent is pushed last and popped first.
      return (pa?.authorTs ?? 0) - (pb?.authorTs ?? 0);
    });
    for (const parent of parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- line diff

/** LCS-based line diff counts (files here are small). Returns additions/deletions. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Drop a single trailing empty element from a final newline on both sides.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // Two-row DP for the LCS length.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}
