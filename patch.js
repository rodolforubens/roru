// Unified diff parsing, and the patches that stage or unstage part of a file (hunks or lines).

export const MAX_LINES = 6000;

const DEV_NULL = '/dev/null';

// Parses `git diff` output into hunks of typed lines with old/new line numbers. Lines of
// changes and context get an `id` (in the order they are shown), and a line followed by
// "\ No newline at end of file" gets `noEol`. A hunk is `complete` when every line its header
// counts was read (the last one may be cut by MAX_LINES).
export function parseDiff(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const res = { hunks: [], meta: [], binary: false, added: 0, removed: 0, truncated: false, files: 0, oldName: null, newName: null, mode: null };
  let hunk = null, oldNo = 0, newNo = 0, count = 0, id = 0, prev = null;

  for (const line of lines) {
    if (!hunk || line.startsWith('diff --git')) {
      if (!line.startsWith('@@')) {
        if (line.startsWith('diff --git')) res.files++;
        if (line.startsWith('Binary files')) res.binary = true;
        if (/^(new file mode|deleted file mode|rename from|rename to|similarity index|old mode|new mode)/.test(line)) res.meta.push(line);
        const mode = line.match(/^(?:new|deleted) file mode (\d+)/);
        if (mode) res.mode = mode[1];
        // git ends a name that has a space with a tab
        if (line.startsWith('--- ')) res.oldName = line.slice(4).replace(/\t$/, '');
        if (line.startsWith('+++ ')) res.newName = line.slice(4).replace(/\t$/, '');
        hunk = null;
        continue;
      }
    }
    if (count++ > MAX_LINES) { res.truncated = true; break; }
    const c = line[0];
    if (c === '@') {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) { oldNo = +m[1]; newNo = +m[3]; }
      hunk = {
        header: line, lines: [], complete: false,
        oldStart: m ? +m[1] : 0, oldCount: m ? +(m[2] ?? 1) : 0,
        newStart: m ? +m[3] : 0, newCount: m ? +(m[4] ?? 1) : 0,
      };
      res.hunks.push(hunk);
      prev = null;
    } else if (c === '+') {
      res.added++;
      hunk.lines.push(prev = { type: 'add', text: line.slice(1), newNo: newNo++, id: id++ });
    } else if (c === '-') {
      res.removed++;
      hunk.lines.push(prev = { type: 'del', text: line.slice(1), oldNo: oldNo++, id: id++ });
    } else if (c === '\\') {
      if (prev) prev.noEol = true;
      hunk.lines.push({ type: 'note', text: line });
    } else {
      hunk.lines.push(prev = { type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++, id: id++ });
    }
  }
  for (const h of res.hunks) {
    const old = h.lines.filter(l => l.type === 'ctx' || l.type === 'del').length;
    const neu = h.lines.filter(l => l.type === 'ctx' || l.type === 'add').length;
    h.complete = old === h.oldCount && neu === h.newCount;
  }
  return res;
}

// Whether the hunks of a diff can be staged or unstaged one by one: a single text file.
export const canStageParts = d => d.files === 1 && !d.binary && d.oldName != null && d.newName != null;

// A patch for `git apply --cached` with the changes `pick(line, hunkIndex)` chooses out of
// `text`, the diff of one file. Forward, it stages them from the diff of the working copy
// (index → working copy); with `reverse` it unstages them from the staged diff (HEAD → index),
// to apply with `-R`. Returns null when nothing is picked.
//
// The side the patch is applied to keeps every line: forward, a removal that is not picked
// stays as context and an addition that is not picked is left out; reversed, the other way
// around. A partly picked new file (unstaging) or deleted file (staging) becomes a change of
// the file, and a renamed file is treated as a change of its new path, so the rename stays.
export function partialPatch(text, pick, reverse = false) {
  const d = parseDiff(text);
  if (!canStageParts(d)) return null;
  const isChange = l => l.type === 'add' || l.type === 'del';
  let whole = true;
  const picked = d.hunks.map((h, i) => {
    const changes = h.lines.filter(isChange);
    const n = changes.filter(l => pick(l, i)).length;
    if (n < changes.length) whole = false;
    return n > 0;
  });
  if (!picked.some(Boolean)) return null;
  if (d.hunks.some((h, i) => picked[i] && !h.complete)) throw new Error('The diff is incomplete — it is too large to stage part of it');

  const created = d.oldName === DEV_NULL, deleted = d.newName === DEV_NULL;
  const keepCreated = created && (!reverse || whole), keepDeleted = deleted && (reverse || whole);
  // "a/path" or "b/path", quoted by git when the path has special characters
  const as = (name, prefix) => name.replace(/^("?)[ab]\//, `$1${prefix}/`);
  const name = deleted ? d.oldName : created || reverse ? d.newName : d.oldName;
  const a = as(name, 'a'), b = as(name, 'b');
  const label = n => n + (n.includes(' ') ? '\t' : '');
  const out = [`diff --git ${a} ${b}`];
  if (keepCreated) out.push(`new file mode ${d.mode || '100644'}`);
  if (keepDeleted) out.push(`deleted file mode ${d.mode || '100644'}`);
  out.push(`--- ${keepCreated ? DEV_NULL : label(a)}`, `+++ ${keepDeleted ? DEV_NULL : label(b)}`);

  // Starts of the side that changes: the hunks before move it by the lines they add or remove.
  // A range of 0 lines starts at the line before it ("-5,0" is after line 5).
  const first = (start, n) => (n ? start : start + 1);
  const startAt = (line, n) => (n ? line : line - 1);
  let shift = 0;
  d.hunks.forEach((h, i) => {
    if (!picked[i]) return;
    const body = [];
    for (const l of h.lines) {
      if (l.type === 'note') continue;
      let kind = l.type;
      if (isChange(l) && !pick(l, i)) kind = (l.type === 'del') === reverse ? null : 'ctx';
      if (kind) body.push({ kind, text: l.text, noEol: !!l.noEol });
    }
    fixEol(body, reverse ? 'old' : 'new');
    const oldN = body.filter(l => l.kind !== 'add').length, newN = body.filter(l => l.kind !== 'del').length;
    let oldStart = h.oldStart, newStart = h.newStart;
    if (reverse) {
      oldStart = startAt(first(h.newStart, h.newCount) + shift, oldN);
      shift += oldN - newN;
    } else {
      newStart = startAt(first(h.oldStart, h.oldCount) + shift, newN);
      shift += newN - oldN;
    }
    out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@`);
    for (const l of body) {
      out.push({ ctx: ' ', add: '+', del: '-' }[l.kind] + l.text);
      if (l.noEol) out.push('\\ No newline at end of file');
    }
  });
  return out.join('\n') + '\n';
}

// "\ No newline at end of file" only fits the last line of a side. A line of the side being
// written (`side`: the new one when staging, the old one when unstaging) that gets other
// lines after it gets its newline back; a context line keeps it on the other side.
function fixEol(body, side) {
  const own = side === 'new' ? 'add' : 'del', other = side === 'new' ? 'del' : 'add';
  let later = false;
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i];
    if (l.kind === other) continue;
    if (l.noEol && later) {
      if (l.kind === own) l.noEol = false;
      else {
        const keep = { kind: other, text: l.text, noEol: true }, fixed = { kind: own, text: l.text, noEol: false };
        body.splice(i, 1, ...(own === 'del' ? [fixed, keep] : [keep, fixed]));
      }
    }
    later = true;
  }
}
