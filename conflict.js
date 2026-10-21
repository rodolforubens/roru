// Conflict markers: parsing a conflicted file and rendering the conflict resolver.
import { esc } from './util.js?v=e6ba73e';
import { highlighterFor } from './highlight.js?v=e6ba73e';

const CTX = 3; // unchanged lines kept visible around each conflict

// Lines keep their line endings, so saving the file changes nothing but the conflicts.
const splitLines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const strip = line => line.replace(/\r?\n$/, '');
const isMarker = (line, ch) => line.startsWith(ch.repeat(7)) && (line.length === 7 || ' \r\n'.includes(line[7]));
const label = line => strip(line).slice(7).trim();

export const hasMarkers = text => splitLines(text).some(l => isMarker(l, '<'));

// Splits a conflicted file into text and conflict segments. A conflict has the current side
// ("ours"), the incoming side ("theirs") and, with merge.conflictStyle=diff3, the common base.
// Returns null when the markers are incomplete or nested.
export function parseConflicts(content) {
  const segs = [];
  let text = [], c = null, part = null;
  for (const l of splitLines(content)) {
    if (!c) {
      if (!isMarker(l, '<')) { text.push(l); continue; }
      if (text.length) segs.push({ type: 'text', lines: text });
      text = [];
      c = { type: 'conflict', ours: [], base: null, theirs: [], oursLabel: label(l), baseLabel: '', theirsLabel: '',
        eol: l.endsWith('\r\n') ? '\r\n' : '\n', choice: null, custom: null, editing: false };
      part = 'ours';
    } else if (isMarker(l, '|') && part === 'ours') {
      c.base = [];
      c.baseLabel = label(l);
      part = 'base';
    } else if (isMarker(l, '=') && part !== 'theirs') {
      part = 'theirs';
    } else if (isMarker(l, '>') && part === 'theirs') {
      c.theirsLabel = label(l);
      segs.push(c);
      c = null;
    } else if (isMarker(l, '<')) {
      return null;
    } else {
      c[part].push(l);
    }
  }
  if (c) return null;
  if (text.length) segs.push({ type: 'text', lines: text });
  return segs;
}

// The lines a conflict resolves to, or null while it is unresolved.
export function chosenLines(c) {
  if (c.choice === 'ours') return c.ours;
  if (c.choice === 'theirs') return c.theirs;
  if (c.choice === 'both') return [...c.ours, ...c.theirs];
  if (c.choice === 'custom') {
    if (!c.custom) return [];
    return splitLines((c.custom.endsWith('\n') ? c.custom : c.custom + '\n').replace(/\r?\n/g, c.eol));
  }
  return null;
}

export const resolvedContent = segs => segs.map(s => (s.type === 'text' ? s.lines : chosenLines(s)).join('')).join('');

// Hand editing starts from the current result, or from both sides when nothing was picked yet.
export function startEdit(c) {
  const lines = chosenLines(c) ?? [...c.ours, ...c.theirs];
  c.custom = lines.join('').replace(/\r\n/g, '\n').replace(/\n$/, '');
  c.choice = 'custom';
  c.editing = true;
}

const CHOICE = { ours: 'kept current', theirs: 'kept incoming', both: 'kept both', custom: 'edited by hand' };

export function renderResolver(segs, { path, mergeTool = null }) {
  const hl = highlighterFor(path);
  const paint = (l, st) => (hl ? hl(strip(l), st) : esc(strip(l)));
  const conflicts = segs.filter(s => s.type === 'conflict');
  const done = conflicts.filter(c => c.choice).length;
  const st = {}; // highlighting state of the resolved file
  let n = 0, ci = 0, rows = '';

  const line = (l, cls, hst, numbered = true) =>
    `<tr class="${cls}"><td class="ln">${numbered ? ++n : ''}</td><td class="code">${paint(l, hst)}</td></tr>`;
  const note = (cls, html) => `<tr class="${cls}"><td class="ln"></td><td class="code">${html}</td></tr>`;
  const btn = (si, act, text, tip) => `<button class="rs-btn" data-rs="${act}" data-seg="${si}" title="${esc(tip)}">${text}</button>`;

  segs.forEach((seg, si) => {
    if (seg.type === 'text') {
      // Long stretches of unchanged lines are folded, keeping a few lines of context.
      const ls = seg.lines;
      const head = si === 0 ? 0 : CTX, tail = si === segs.length - 1 ? 0 : CTX;
      const fold = !seg.open && ls.length > head + tail + 2;
      ls.forEach((l, k) => {
        if (fold && k === head) rows += `<tr class="rs-fold" data-rs="unfold" data-seg="${si}" title="Show these lines"><td class="ln"></td><td class="code">⋯  ${ls.length - head - tail} unchanged lines</td></tr>`;
        if (!fold || k < head || k >= ls.length - tail) rows += line(l, '', st);
        else { n++; if (hl) hl(strip(l), st); }
      });
      return;
    }

    const c = seg, idx = ci++, out = chosenLines(c);
    const title = `<span class="rs-title">Conflict ${idx + 1} of ${conflicts.length}</span>`;
    const bar = (cls, what, buttons) =>
      `<tr class="rs-bar ${cls}" data-conflict="${idx}"><td class="ln"></td><td class="code"><div class="rs-bar-in">${title}${what ? `<span class="rs-what">${what}</span>` : ''}<span class="rs-btns">${buttons}</span></div></td></tr>`;

    if (c.editing) {
      rows += bar('editing', 'Editing', btn(si, 'done', 'Done', 'Finish editing') + btn(si, 'undo', 'Discard', 'Back to the unresolved conflict'));
      rows += note('rs-edit', `<textarea data-edit="${si}" rows="${Math.max(2, c.custom.split('\n').length)}" spellcheck="false">${esc(c.custom)}</textarea>`);
      n += out.length;
    } else if (out) {
      rows += bar('done', CHOICE[c.choice], btn(si, 'edit', 'Edit', 'Edit the result by hand') + btn(si, 'undo', 'Undo', 'Back to the unresolved conflict'));
      if (!out.length) rows += note('rs-empty', 'Resolves to nothing — these lines are removed');
      out.forEach(l => { rows += line(l, 'rs-res', st); });
    } else {
      rows += bar('', '',
        btn(si, 'ours', 'Use current', 'Keep the current side') +
        btn(si, 'theirs', 'Use incoming', 'Keep the incoming side') +
        btn(si, 'both', 'Use both', 'Keep the current side, then the incoming one') +
        btn(si, 'edit', 'Edit', 'Write the result by hand'));
      const side = (cls, name, lbl, lines) => {
        const hst = { ...st };
        rows += note(`rs-label ${cls}`, `<b>${name}</b>${lbl ? ` <span>${esc(lbl)}</span>` : ''}`);
        if (!lines.length) rows += note(`rs-empty ${cls}`, 'No lines');
        lines.forEach(l => { rows += line(l, `rs-${cls}`, hst, false); });
        return hst;
      };
      const ours = side('ours', 'Current', c.oursLabel, c.ours);
      if (c.base) side('base', 'Base', c.baseLabel, c.base);
      side('theirs', 'Incoming', c.theirsLabel, c.theirs);
      Object.assign(st, ours);
    }
  });

  const total = conflicts.length;
  const head = `<div class="diff-head rs-head">
    <span class="diff-title">${esc(path)}</span>
    <span class="rs-progress ${done === total ? 'ok' : ''}">${done} of ${total} resolved</span>
    <span class="rs-actions">
      ${mergeTool ? `<button class="btn-sm" data-rs="tool" title="Open the file in ${esc(mergeTool)}">Merge tool</button>` : ''}
      <button class="btn-sm" data-rs="all-ours" title="Resolve every conflict in this file with the current side (hand edits are kept)">All current</button>
      <button class="btn-sm" data-rs="all-theirs" title="Resolve every conflict in this file with the incoming side (hand edits are kept)">All incoming</button>
      <button class="btn-sm primary" data-rs="save" ${done < total ? 'disabled title="Resolve every conflict first"' : ''}>Save and mark resolved</button>
    </span>
  </div>`;
  return head + `<div class="diff-scroll rs-scroll"><table class="diff rs-table"><tbody>${rows}</tbody></table></div>`;
}

// For conflicts that can't be resolved line by line (deleted files, binary files...).
// `actions` are { rs, label, primary }; `diff` adds a diff pane below the card.
export function renderConflictCard({ path, kind, title, message, actions, diff = false }) {
  return `<div class="diff-head"><span class="diff-title">${esc(path)}</span><span class="rs-kind">${esc(kind)}</span></div>
    <div class="rs-card">
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <div class="rs-card-actions">${actions.map(a => `<button class="btn ${a.primary ? 'primary' : ''}" data-rs="${a.rs}">${esc(a.label)}</button>`).join('')}</div>
    </div>
    ${diff ? '<div class="diff-pane rs-diff"></div>' : ''}`;
}
