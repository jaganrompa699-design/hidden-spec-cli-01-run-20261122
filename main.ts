// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
// Implements SPEC.md sections 1-10: the command line, output and exit codes,
// safe paths, format detection, three-tier line matching, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines: its line break, its lines, and whether it ends with one. */
type Br = '\n' | '\r\n';
function fileParts(text: string): { lines: string[]; br: Br; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: Br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinParts(lines: string[], br: Br, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Three-tier line matching (SPEC.md section 5). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrencesAt(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const no = o.map((l) => norm(l, tier));
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(file, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of the replacement: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}
/** Replace file[at .. at+o.length) with N: context lines come from the file itself, and at tier 2 the other lines are re-indented from O's base to the file's. */
function applyLines(file: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = o.length > 0 ? leadingWs(file[at]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  for (const nl of n) {
    if (nl.ctx >= 0) out.push(file[at + nl.ctx]!);
    else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) out.push(f + nl.text.slice(p.length));
    else out.push(nl.text);
  }
  return [...file.slice(0, at), ...out, ...file.slice(at + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a backslash line. */
interface BodyLine {
  k: ' ' | '-' | '+' | '\\';
  text: string;
}
/** Split a hunk/chunk body into its old lines O and its new lines N (with context marks). */
function hunkON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.k === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.k === '-') o.push(b.text);
    else if (b.k === '+') n.push({ text: b.text, ctx: -1 });
  }
  return { o, n };
}
/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.k === ' ' || body[i]!.k === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.k === '\\';
}

/** Unified diffs (SPEC.md section 6). */
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  diffOld: string;
  diffNew: string;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab < 0 ? rest : rest.slice(0, tab)).trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function parseDiffGit(line: string, idx: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${idx + 1}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${idx + 1}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${idx + 1}`);
  return [x, y];
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renOld ?? s.diffOld;
  const newP = s.pairNew ?? s.renNew ?? s.diffNew;
  return (tree) => {
    if (s.creation || oldP === '/dev/null') {
      const p = newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      let hasPlus = false;
      for (const h of s.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.k === '+') {
            plus.push(b.text);
            hasPlus = true;
            noBreak = h.body[j + 1]?.k === '\\';
          }
        }
      }
      tree.now.set(p, !hasPlus ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (s.deletion || newP === '/dev/null') {
      const p = oldP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== newP;
    const p = oldP;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const content = tree.get(p);
    if (content === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let { lines, br, final } = fileParts(content);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n } = hunkON(h.body);
      if (o.length > 0) {
        const found = findTier(lines, o, strict);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const q of found.pos) {
          const dist = Math.abs(q - target);
          if (dist < bestDist) {
            best = q;
            bestDist = dist;
          }
        }
        const reachesEnd = best + o.length === lines.length;
        const noBreak = backslashAfterLast(h.body);
        lines = applyLines(lines, best, o, n, found.tier);
        if (reachesEnd) final = !noBreak;
      } else {
        const at = Math.min(h.a + d, lines.length);
        const reachesEnd = at === lines.length;
        const noBreak = backslashAfterLast(h.body);
        lines = applyLines(lines, at, o, n, 0);
        if (reachesEnd) final = !noBreak;
      }
      d += n.length - o.length;
    }
    const out = joinParts(lines, br, final);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP, out);
      tree.moves.push([p, newP]);
    } else tree.now.set(p, out);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let curHunk: Hunk | null = null;
  const endBody = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.k === ' ' && last.text === '') curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
      curHunk = null;
    }
  };
  const startSection = (oldP: string, newP: string, viaPair: boolean): void => {
    endBody();
    cur = { diffOld: '', diffNew: '', pairOld: null, pairNew: null, renOld: null, renNew: null, creation: false, deletion: false, hunks: [] };
    if (viaPair) {
      cur.pairOld = oldP;
      cur.pairNew = newP;
    } else {
      cur.diffOld = oldP;
      cur.diffNew = newP;
    }
    sections.push(cur);
    state = 'header';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'body') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        state = 'after';
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk!.body.push(line === '' ? { k: ' ', text: '' } : { k: line[0] as ' ' | '-' | '+' | '\\', text: line.slice(1) });
        i++;
        continue;
      }
      endBody();
      state = 'after';
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, i);
      startSection(x, y, false);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (state === 'header' && cur !== null) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        i += 2;
        continue;
      }
      startSection(oldP, newP, true);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      endBody();
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      state = 'body';
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
    }
    i++;
  }
  endBody();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let eq = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else i++;
  }
  return blocks.map((b) => (tree: Tree): void => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : `${b.nw.join('\n')}\n`);
      return;
    }
    const content = tree.get(p);
    if (content === null) throw new Fail('missing', p);
    const { lines: fl, br, final } = fileParts(content);
    const found = findTier(fl, b.old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length !== 1) throw new Fail('ambiguous', p);
    const at = found.pos[0]!;
    const n: NLine[] = b.nw.map((t) => ({ text: t, ctx: -1 }));
    tree.now.set(p, joinParts(applyLines(fl, at, b.old, n, found.tier), br, final));
  });
}

/** V4A patches (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}
type VSection = { kind: 'add'; path: string; fileLines: string[] } | { kind: 'delete'; path: string } | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function parseV4aUpdate(path: string, raw: string[], startLine0: number): VSection {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
    moveTo = raw[0]!.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const flush = (): void => {
    if (cur !== null) {
      while (cur.body.length > 0) {
        const last = cur.body[cur.body.length - 1]!;
        if (last.k === ' ' && last.text === '') cur.body.pop();
        else break;
      }
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    const lineNo = startLine0 + idx + 1;
    if (l.startsWith('@@')) {
      flush();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
    } else if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) cur = { anchor: null, body: [], eof: false };
      cur.body.push(l === '' ? { k: ' ', text: '' } : { k: l[0] as ' ' | '-' | '+', text: l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine0}`);
  return { kind: 'update', path, moveTo, chunks };
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.fileLines.length === 0 ? '' : `${s.fileLines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    const content = tree.get(p);
    if (content === null) throw new Fail('missing', p);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    let { lines, br, final } = fileParts(content);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (norm(lines[k]!, t) === norm(chunk.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', p);
        cursor = foundIdx + 1;
      }
      const { o, n } = hunkON(chunk.body);
      if (o.length > 0) {
        let found: { tier: number; at: number } | null = null;
        for (const t of tiers) {
          const pos = occurrencesAt(lines, o, t, cursor);
          if (pos.length > 0) {
            found = { tier: t, at: pos[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        if (chunk.eof && found.at + o.length !== lines.length) throw new Fail('no-match', p);
        lines = applyLines(lines, found.at, o, n, found.tier);
        cursor = found.at + n.length;
      } else {
        const at = chunk.eof ? lines.length : cursor;
        const add = n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...add, ...lines.slice(at)];
        cursor = at + add.length;
      }
    }
    const out = joinParts(lines, br, final);
    if (s.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([p, s.moveTo]);
    } else tree.now.set(p, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:')) {
      const kind = line.startsWith('*** Add File:') ? 'add' : line.startsWith('*** Delete File:') ? 'delete' : 'update';
      const path = line.slice(line.indexOf(':') + 1).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (!blank(l) && (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:'))) break;
        raw.push(l);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (let k = 0; k < raw.length; k++) {
          const l = raw[k]!;
          if (l === '') fileLines.push('');
          else if (l.startsWith('+')) fileLines.push(l.slice(1));
          else throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        sections.push({ kind: 'add', path, fileLines });
      } else if (kind === 'delete') {
        for (let k = 0; k < raw.length; k++) {
          if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        sections.push({ kind: 'delete', path });
      } else {
        sections.push(parseV4aUpdate(path, raw, i + 1));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const before = (p: string): string | null => tree.original(p);
  const after = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed = new Set<string>();
  for (const p of tree.now.keys()) {
    if (before(p) !== after(p)) changed.add(p);
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  const seenPairs = new Set<string>();
  for (const [o, n] of tree.moves) {
    const pk = `${o}\0${n}`;
    if (seenPairs.has(pk)) continue;
    seenPairs.add(pk);
    if (o === n) continue;
    if (covered.has(o) || covered.has(n)) continue;
    if (before(o) === null || after(n) === null) continue;
    if (!changed.has(o) || !changed.has(n)) continue;
    rows.push({ key: n, line: `R ${o} -> ${n}` });
    covered.add(o);
    covered.add(n);
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const w = before(p);
    const nw = after(p);
    rows.push({ key: p, line: `${w === null ? 'A' : nw === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
