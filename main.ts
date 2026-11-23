// main.ts is mend, the CLI SPEC.md specifies, implementing all sections 1-10 (MIT).
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

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly renames = new Map<string, string>(); // old -> new

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

// --- Section 5: Matching lines ---
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  if (tier === 2) return line.replace(/^[ \t]+|[ \t]+$/, '');
  return line;
}

function getLeading(s: string): string {
  const m = s.match(/^[ \t]+/);
  return m ? m[0] : '';
}

function findMatchingIndices(fileLines: string[], O: string[], strict: boolean): { tier: number; indices: number[] } {
  const maxTier = strict ? 0 : 2;
  if (O.length === 0) {
    return { tier: 0, indices: Array.from({ length: fileLines.length + 1 }, (_, i) => i) };
  }
  for (let tier = 0; tier <= maxTier; tier++) {
    const oNorm = O.map((l) => norm(l, tier));
    const indices: number[] = [];
    for (let i = 0; i <= fileLines.length - O.length; i++) {
      let match = true;
      for (let j = 0; j < O.length; j++) {
        if (norm(fileLines[i + j]!, tier) !== oNorm[j]!) {
          match = false;
          break;
        }
      }
      if (match) indices.push(i);
    }
    if (indices.length > 0) {
      return { tier, indices };
    }
  }
  return { tier: -1, indices: [] };
}

function fileLineData(content: string): { lines: string[]; crlf: boolean; final: boolean } {
  if (content === '') return { lines: [], crlf: false, final: false };
  const nl = content.indexOf('\n');
  const crlf = nl > 0 && content[nl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const final = content.endsWith(br);
  const raw = content.split(br);
  if (final) raw.pop();
  const lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, crlf, final };
}

function serializeLineData(lines: string[], crlf: boolean, final: boolean): string {
  if (lines.length === 0 && !final) return '';
  const br = crlf ? '\r\n' : '\n';
  return lines.join(br) + (final ? br : '');
}

// --- Section 6: Unified Diffs ---
function parseUnifiedPath(s: string): string | null {
  const trimmed = s.trim();
  const parts = trimmed.split(/\s+/);
  let p = parts[0] ?? '';
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(text: string, patchLinesArr: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;

  type Section = {
    oldPath: string | null;
    newPath: string | null;
    isNew: boolean;
    isDeleted: boolean;
    hunks: { headerLineNum: number; A: number; body: { type: string; text: string; noNewline?: boolean }[] }[];
  };

  const sections: Section[] = [];
  let currentSec: Section | null = null;
  let inHeader = false;

  while (i < patchLinesArr.length) {
    const line = patchLinesArr[i]!;
    const lineNum = i + 1;

    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${lineNum}`);
      currentSec = {
        oldPath: m[1]!,
        newPath: m[2]!,
        isNew: false,
        isDeleted: false,
        hunks: [],
      };
      sections.push(currentSec);
      inHeader = true;
      i++;
      continue;
    }

    if (line.startsWith('--- ')) {
      const nextLine = patchLinesArr[i + 1];
      if (nextLine === undefined || !nextLine.startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      const oldRaw = line.slice(4);
      const newRaw = nextLine.slice(4);
      const oldP = parseUnifiedPath(oldRaw);
      const newP = parseUnifiedPath(newRaw);
      
      if (!currentSec || currentSec.hunks.length > 0) {
        currentSec = {
          oldPath: oldP,
          newPath: newP,
          isNew: oldP === null,
          isDeleted: newP === null,
          hunks: [],
        };
        sections.push(currentSec);
      } else {
        currentSec.oldPath = oldP;
        currentSec.newPath = newP;
        if (oldP === null) currentSec.isNew = true;
        if (newP === null) currentSec.isDeleted = true;
      }
      inHeader = true;
      i += 2;
      continue;
    }

    if (line.startsWith('@@ ')) {
      if (!currentSec) throw new Exit2(`error: parse ${lineNum}`);
      inHeader = false;
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) throw new Exit2(`error: parse ${lineNum}`);
      const A = parseInt(m[1]!, 10);
      const oldLen = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const newLen = m[4] !== undefined ? parseInt(m[4], 10) : 1;
      const hunkBody: { type: string; text: string; noNewline?: boolean }[] = [];
      let oldCollected = 0;
      let newCollected = 0;
      i++;
      while (i < patchLinesArr.length) {
        if (oldCollected >= oldLen && newCollected >= newLen) {
          break;
        }
        const bl = patchLinesArr[i]!;
        if (bl.startsWith('diff --git ') || bl.startsWith('@@ ') || (bl.startsWith('--- ') && (patchLinesArr[i + 1] ?? '').startsWith('+++ '))) {
          break;
        }
        if (bl.startsWith('\\ No newline at end of file')) {
          if (hunkBody.length > 0) {
            hunkBody[hunkBody.length - 1]!.noNewline = true;
          }
          i++;
          continue;
        }
        let type: string;
        let text: string;
        if (bl === '') {
          type = ' ';
          text = '';
        } else {
          const t = bl[0];
          if (t === ' ' || t === '-' || t === '+') {
            type = t;
            text = bl.slice(1);
          } else {
            break;
          }
        }
        hunkBody.push({ type, text });
        if (type === ' ' || type === '-') {
          oldCollected++;
        }
        if (type === ' ' || type === '+') {
          newCollected++;
        }
        i++;
      }
      if (oldCollected >= oldLen && newCollected >= newLen && i < patchLinesArr.length) {
        const bl = patchLinesArr[i]!;
        if (bl.startsWith('\\ No newline at end of file')) {
          if (hunkBody.length > 0) {
            hunkBody[hunkBody.length - 1]!.noNewline = true;
          }
          i++;
        }
      }
      currentSec.hunks.push({ headerLineNum: lineNum, A, body: hunkBody });
      continue;
    }

    if (inHeader) {
      if (line.startsWith('rename from ')) {
        if (currentSec) currentSec.oldPath = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (currentSec) currentSec.newPath = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        if (currentSec) currentSec.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        if (currentSec) currentSec.isDeleted = true;
        i++;
        continue;
      }
      if (line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ') || line.startsWith('similarity index ') || line.startsWith('dissimilarity index ') || line.startsWith('Index: ')) {
        i++;
        continue;
      }
    }

    i++;
  }

  if (sections.length === 0) {
    throw new Exit2('error: parse 1');
  }

  for (const sec of sections) {
    const oldPath = sec.oldPath;
    const newPath = sec.newPath;
    const isNew = sec.isNew || oldPath === null;
    const isDeleted = sec.isDeleted || newPath === null;
    const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
    const targetPath = isMove ? oldPath : (isNew ? newPath : (oldPath ?? newPath));
    if (!targetPath) throw new Exit2('error: parse 1');

    edits.push((tree: Tree) => {
      if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
      if (isMove && newPath && !safe(newPath)) throw new Fail('unsafe', newPath);

      if (isNew) {
        if (newPath === null) throw new Fail('missing', targetPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const newLines: string[] = [];
        let finalNewline = false;
        for (const h of sec.hunks) {
          for (const b of h.body) {
            if (b.type === '+' || b.type === ' ') {
              newLines.push(b.text);
              if (b.noNewline) finalNewline = false;
              else finalNewline = true;
            }
          }
        }
        tree.now.set(newPath, serializeLineData(newLines, false, finalNewline));
        return;
      }

      const content = tree.get(targetPath);
      if (content === null) throw new Fail('missing', targetPath);

      if (isDeleted) {
        tree.now.set(targetPath, null);
        return;
      }

      if (isMove) {
        if (newPath === null) throw new Fail('missing', targetPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      }

      let { lines, crlf, final } = fileLineData(content);
      let d = 0;
      let finalOverride: boolean | undefined = undefined;

      for (const h of sec.hunks) {
        const O: string[] = [];
        const N: string[] = [];
        for (const b of h.body) {
          if (b.type === ' ' || b.type === '-') O.push(b.text);
          if (b.type === ' ' || b.type === '+') N.push(b.text);
        }

        if (O.length > 0) {
          const { tier, indices } = findMatchingIndices(lines, O, strict);
          if (indices.length === 0) throw new Fail('no-match', targetPath);
          const targetPos = h.A - 1 + d;
          let bestIdx = indices[0]!;
          let bestDist = Math.abs(bestIdx - targetPos);
          for (let k = 1; k < indices.length; k++) {
            const idx = indices[k]!;
            const dist = Math.abs(idx - targetPos);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = idx;
            }
          }
          const matchIdx = bestIdx;

          const subLines: string[] = [];
          let nCursor = 0;
          for (const b of h.body) {
            if (b.type === ' ') {
              subLines.push(lines[matchIdx + nCursor]!);
              nCursor++;
            } else if (b.type === '-') {
              nCursor++;
            } else if (b.type === '+') {
              let textToAdd = b.text;
              if (tier === 2) {
                const F = getLeading(lines[matchIdx]!);
                const P = getLeading(O[0]!);
                if (P !== '' && !blank(textToAdd) && textToAdd.startsWith(P)) {
                  textToAdd = F + textToAdd.slice(P.length);
                }
              }
              subLines.push(textToAdd);
            }
          }

          if (bHasNoNewline(h.body)) {
            if (matchIdx + O.length >= lines.length) {
              finalOverride = false;
            }
          }

          lines.splice(matchIdx, O.length, ...subLines);
          d += N.length - O.length;
        } else {
          const insertIdx = Math.min(lines.length, Math.max(0, h.A + d));
          const subLines: string[] = N;
          lines.splice(insertIdx, 0, ...subLines);
          if (bHasNoNewline(h.body) && insertIdx >= lines.length) {
            finalOverride = false;
          }
          d += N.length - O.length;
        }
      }

      const finalToWrite = finalOverride !== undefined ? finalOverride : final;
      const resContent = serializeLineData(lines, crlf, finalToWrite);

      if (isMove && newPath) {
        tree.now.set(targetPath, null);
        tree.now.set(newPath, resContent);
        tree.renames.set(targetPath, newPath);
      } else {
        tree.now.set(targetPath, resContent);
      }
    });
  }

  return edits;
}

function bHasNoNewline(body: { type: string; text: string; noNewline?: boolean }[]): boolean {
  if (body.length === 0) return false;
  return !!body[body.length - 1]?.noNewline;
}

// --- Section 7: SEARCH/REPLACE Blocks ---
function searchReplaceEdits(text: string, patchLinesArr: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastPath: string | null = null;

  while (i < patchLinesArr.length) {
    const line = patchLinesArr[i]!;
    if (line.trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      let path: string | null = null;
      for (let pIdx = i - 1; pIdx >= 0; pIdx--) {
        const candidate = patchLinesArr[pIdx]!.trim();
        if (!blank(candidate) && !candidate.startsWith('```')) {
          path = candidate;
          break;
        }
        if (candidate.startsWith('>>>>>>> REPLACE') || candidate.startsWith('<<<<<<< SEARCH')) {
          break;
        }
      }
      if (!path) path = lastPath;
      if (!path) throw new Exit2(`error: parse ${searchLineNum}`);
      lastPath = path;

      i++;
      const O: string[] = [];
      let foundEquals = false;
      while (i < patchLinesArr.length) {
        const bl = patchLinesArr[i]!;
        if (bl.trimEnd() === '=======') {
          foundEquals = true;
          i++;
          break;
        }
        if (bl.trimEnd() === '>>>>>>> REPLACE') {
          throw new Exit2(`error: parse ${searchLineNum}`);
        }
        O.push(bl);
        i++;
      }
      if (!foundEquals) throw new Exit2(`error: parse ${searchLineNum}`);

      const N: string[] = [];
      let foundReplace = false;
      while (i < patchLinesArr.length) {
        const bl = patchLinesArr[i]!;
        if (bl.trimEnd() === '>>>>>>> REPLACE') {
          foundReplace = true;
          i++;
          break;
        }
        N.push(bl);
        i++;
      }
      if (!foundReplace) throw new Exit2(`error: parse ${searchLineNum}`);

      edits.push((tree: Tree) => {
        if (!safe(path!)) throw new Fail('unsafe', path!);
        if (O.length === 0) {
          if (tree.get(path!) !== null) throw new Fail('exists', path!);
          tree.now.set(path!, serializeLineData(N, false, true));
          return;
        }

        const content = tree.get(path!);
        if (content === null) throw new Fail('missing', path!);

        const { lines, crlf, final } = fileLineData(content);
        const { tier, indices } = findMatchingIndices(lines, O, strict);
        if (indices.length === 0) throw new Fail('no-match', path!);
        if (indices.length > 1) throw new Fail('ambiguous', path!);

        const matchIdx = indices[0]!;
        const subLines: string[] = [];
        for (let k = 0; k < N.length; k++) {
          let textToAdd = N[k]!;
          if (tier === 2) {
            const F = getLeading(lines[matchIdx]!);
            const P = getLeading(O[0]!);
            if (P !== '' && !blank(textToAdd) && textToAdd.startsWith(P)) {
              textToAdd = F + textToAdd.slice(P.length);
            }
          }
          subLines.push(textToAdd);
        }

        lines.splice(matchIdx, O.length, ...subLines);
        tree.now.set(path!, serializeLineData(lines, crlf, final));
      });
    } else {
      i++;
    }
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// --- Section 8: V4A Patches ---
function v4aEdits(text: string, patchLinesArr: string[], strict: boolean): Edit[] {
  const firstNonBlank = patchLinesArr.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || patchLinesArr[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2('error: parse 1');
  }
  const lastNonBlank = patchLinesArr.findLastIndex((l) => !blank(l));
  if (lastNonBlank < 0 || patchLinesArr[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${patchLinesArr.length + 1}`);
  }

  const edits: Edit[] = [];
  let i = firstNonBlank + 1;

  while (i < lastNonBlank) {
    const line = patchLinesArr[i]!;
    const lineNum = i + 1;
    if (blank(line)) {
      i++;
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const fileLinesArr: string[] = [];
      while (i < lastNonBlank) {
        const bl = patchLinesArr[i]!;
        if (bl.startsWith('*** ')) break;
        if (bl.startsWith('+')) {
          fileLinesArr.push(bl.slice(1));
        } else if (bl === '') {
          fileLinesArr.push('');
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, serializeLineData(fileLinesArr, false, true));
      });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      i++;
      let newPath: string | null = null;
      if (i < lastNonBlank && patchLinesArr[i]!.startsWith('*** Move to: ')) {
        newPath = patchLinesArr[i]!.slice(13).trim();
        i++;
      }

      type Chunk = {
        anchor?: string;
        body: { type: string; text: string }[];
        isEof?: boolean;
      };

      const chunks: Chunk[] = [];
      let currentChunk: Chunk | null = null;

      while (i < lastNonBlank) {
        const bl = patchLinesArr[i]!;
        if (bl.startsWith('*** ')) {
          if (bl.startsWith('*** End of File')) {
            if (currentChunk) currentChunk.isEof = true;
            i++;
            break;
          }
          break;
        }

        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          currentChunk = { anchor: anchor === '' ? undefined : anchor, body: [] };
          chunks.push(currentChunk);
          i++;
          continue;
        }

        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (!currentChunk) {
            currentChunk = { body: [] };
            chunks.push(currentChunk);
          }
          const type = bl === '' ? ' ' : bl[0]!;
          const text = bl === '' ? '' : bl.slice(1);
          currentChunk.body.push({ type, text });
          i++;
          continue;
        }

        throw new Exit2(`error: parse ${i + 1}`);
      }

      if (chunks.length === 0 && newPath === null) {
        throw new Exit2(`error: parse ${lineNum}`);
      }

      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (newPath && !safe(newPath)) throw new Fail('unsafe', newPath);

        const content = tree.get(path);
        if (content === null) throw new Fail('missing', path);
        if (newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);

        let { lines, crlf, final } = fileLineData(content);
        let cursor = 0;

        for (const chunk of chunks) {
          if (chunk.anchor !== undefined) {
            let found = -1;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier; t++) {
              for (let idx = cursor; idx < lines.length; idx++) {
                if (norm(lines[idx]!, t) === norm(chunk.anchor, t)) {
                  found = idx;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', path);
            cursor = found + 1;
          }

          const O: string[] = [];
          const O_types: string[] = [];
          const N: string[] = [];
          for (const b of chunk.body) {
            if (b.type === ' ' || b.type === '-') {
              O.push(b.text);
              O_types.push(b.type);
            }
            if (b.type === ' ' || b.type === '+') N.push(b.text);
          }

          if (chunk.isEof) {
            if (O.length > 0) {
              const startIdx = lines.length - O.length;
              if (startIdx < 0) throw new Fail('no-match', path);
              const maxTier = strict ? 0 : 2;
              let matchTier = -1;
              for (let t = 0; t <= maxTier; t++) {
                let match = true;
                for (let j = 0; j < O.length; j++) {
                  if (norm(lines[startIdx + j]!, t) !== norm(O[j]!, t)) {
                    match = false;
                    break;
                  }
                }
                if (match) {
                  matchTier = t;
                  break;
                }
              }
              if (matchTier < 0) throw new Fail('no-match', path);

              const subLines: string[] = [];
              for (const b of chunk.body) {
                if (b.type === ' ') subLines.push(lines[startIdx + subLines.length]!);
                else if (b.type === '+') {
                  let textToAdd = b.text;
                  if (matchTier === 2) {
                    const F = getLeading(lines[startIdx]!);
                    const P = getLeading(O[0]!);
                    if (!blank(textToAdd) && textToAdd.startsWith(P)) {
                      textToAdd = F + textToAdd.slice(P.length);
                    }
                  }
                  subLines.push(textToAdd);
                }
              }
              lines.splice(startIdx, O.length, ...subLines);
              cursor = lines.length;
            } else {
              cursor = lines.length;
              lines.push(...N);
            }
          } else if (O.length > 0) {
            let matchIdx = -1;
            let matchTier = -1;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier; t++) {
              for (let idx = cursor; idx <= lines.length; idx++) {
                let match = true;
                for (let j = 0; j < O.length; j++) {
                  if (idx + j < lines.length) {
                    if (norm(lines[idx + j]!, t) !== norm(O[j]!, t)) {
                      match = false;
                      break;
                    }
                  } else {
                    if (O_types[j] !== ' ' || !blank(O[j]!)) {
                      match = false;
                      break;
                    }
                  }
                }
                if (match) {
                  matchIdx = idx;
                  matchTier = t;
                  break;
                }
              }
              if (matchIdx >= 0) break;
            }
            if (matchIdx < 0) throw new Fail('no-match', path);

            const subLines: string[] = [];
            let nCursor = 0;
            for (const b of chunk.body) {
              if (b.type === ' ') {
                if (matchIdx + nCursor < lines.length) {
                  subLines.push(lines[matchIdx + nCursor]!);
                }
                nCursor++;
              } else if (b.type === '-') {
                nCursor++;
              } else if (b.type === '+') {
                let textToAdd = b.text;
                if (matchTier === 2) {
                  const F = matchIdx < lines.length ? getLeading(lines[matchIdx]!) : '';
                  const P = getLeading(O[0]!);
                  if (!blank(textToAdd) && textToAdd.startsWith(P)) {
                    textToAdd = F + textToAdd.slice(P.length);
                  }
                }
                subLines.push(textToAdd);
              }
            }

            const deleteCount = Math.min(O.length, lines.length - matchIdx);
            lines.splice(matchIdx, deleteCount, ...subLines);
            cursor = matchIdx + subLines.length;
          } else {
            lines.splice(cursor, 0, ...N);
            cursor += N.length;
          }
        }

        const resContent = serializeLineData(lines, crlf, final);
        if (newPath) {
          tree.now.set(path, null);
          tree.now.set(newPath, resContent);
          tree.renames.set(path, newPath);
        } else {
          tree.now.set(path, resContent);
        }
      });
      continue;
    }

    throw new Exit2(`error: parse ${lineNum}`);
  }

  return edits;
}

// --- JSON Edits ---
function jsonEdit(v: unknown, p: string): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const opPath = o.path;
  if (typeof opPath !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(opPath)) throw new Fail('unsafe', opPath);
    const t = tree.get(opPath);
    if (t === null) throw new Fail('missing', opPath);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(opPath)) throw new Fail('unsafe', opPath);
      if (tree.get(opPath) !== null) throw new Fail('exists', opPath);
      tree.now.set(opPath, text);
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
      if (count === 0) throw new Fail('no-match', opPath);
      if (count > 1) throw new Fail('ambiguous', opPath);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(opPath, crlf ? out.replaceAll('\n', '\r\n') : out);
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
      if (line < 0 || line > lines.length) throw new Fail('no-match', opPath);
      lines.splice(line, 0, ...add);
      tree.now.set(opPath, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
      const e = jsonEdit(x, '');
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      const obj = JSON.parse(l);
      e = jsonEdit(obj, '');
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
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
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'unified') {
      edits = unifiedEdits(text, lines, strict);
    } else if (kind === 'search-replace') {
      edits = searchReplaceEdits(text, lines, strict);
    } else if (kind === 'v4a') {
      edits = v4aEdits(text, lines, strict);
    } else {
      return { code: 2, out: ['error: format'] };
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeRenames = new Map(tree.renames);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.renames.clear();
      for (const [k, v] of beforeRenames) tree.renames.set(k, v);
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rawRows: { type: string; path: string; oldPath?: string }[] = [];
  const processedPaths = new Set<string>();

  for (const [oldP, newP] of tree.renames.entries()) {
    processedPaths.add(oldP);
    processedPaths.add(newP);
    rawRows.push({ type: 'R', path: newP, oldPath: oldP });
  }

  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (processedPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;

    processedPaths.add(p);
    rawRows.push({ type: was === null ? 'A' : now === null ? 'D' : 'M', path: p });
  }

  rawRows.sort((a, b) => {
    if (a.type === 'R' && b.type === 'R') {
      return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    }
    return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
  });

  const rows: string[] = [];
  for (const r of rawRows) {
    if (r.type === 'R') {
      rows.push(`R ${r.oldPath} -> ${r.path}`);
    } else {
      rows.push(`${r.type} ${r.path}`);
    }
  }

  if (!check) {
    for (const r of rawRows) {
      const now = tree.now.get(r.type === 'R' ? r.path : r.path)!;
      if (now === null) {
        rmSync(r.path, { force: true });
      } else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, now);
      }
    }
    for (const [oldP] of tree.renames.entries()) {
      rmSync(oldP, { force: true });
    }
  }

  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
