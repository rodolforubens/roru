// Diff rendering (unified or side-by-side split view), with buttons to stage or unstage each
// hunk and selectable lines when asked. Submodule changes and Git LFS pointer files are shown
// as summaries instead.
import { esc, fmtSize } from './util.js?v=6743703';
import { highlighterFor } from './highlight.js?v=6743703';
import { parseDiff, canStageParts, MAX_LINES } from './patch.js?v=6743703';

// Adds syntax-highlighted html to each line. The old side (context + removed lines) and
// the new side (context + added lines) are tokenized separately so that a comment or
// string opened on one side doesn't leak into the other.
function highlight(hunks, path) {
  const hl = path && highlighterFor(path);
  if (!hl) return;
  for (const h of hunks) {
    const oldSt = {}, newSt = {};
    for (const l of h.lines) {
      if (l.type === 'del') l.html = hl(l.text, oldSt);
      else if (l.type === 'add') l.html = hl(l.text, newSt);
      else if (l.type === 'ctx') { l.html = hl(l.text, newSt); l.oldHtml = hl(l.text, oldSt); }
    }
  }
}

const sign = { add: '+', del: '-', ctx: ' ' };
const code = (l, side) => `<span class="sign">${sign[l.type]}</span>${(side === 'old' && l.oldHtml) || l.html || esc(l.text)}`;

// With `stage` ('stage' or 'unstage'), the rows of each complete hunk get its index (`data-h`),
// the hunk header a button, and the added and removed lines their id (`data-l`) so they can
// be selected.
const staging = (h, stage) => !!stage && h.complete;
const hunkHead = (h, i, stage) => !staging(h, stage) ? esc(h.header)
  : `<div class="hunk-head"><span>${esc(h.header)}</span><button class="hunk-act" data-part="hunk" data-h="${i}"
      title="${stage === 'stage' ? 'Stage' : 'Unstage'} this hunk — or click line numbers to pick lines">${stage === 'stage' ? 'Stage' : 'Unstage'} hunk</button></div>`;
const lineAttr = (l, h, stage) => (staging(h, stage) && (l.type === 'add' || l.type === 'del') ? ` data-l="${l.id}"` : '');

function unifiedRows(hunks, stage) {
  let html = '';
  hunks.forEach((h, i) => {
    const hi = staging(h, stage) ? ` data-h="${i}"` : '';
    html += `<tr class="d-hunk"${hi}><td class="ln"></td><td class="ln"></td><td class="code">${hunkHead(h, i, stage)}</td></tr>`;
    for (const l of h.lines) {
      if (l.type === 'note') html += `<tr class="d-note"${hi}><td class="ln"></td><td class="ln"></td><td class="code">${esc(l.text)}</td></tr>`;
      else html += `<tr class="d-${l.type}"${hi}${lineAttr(l, h, stage)}><td class="ln">${l.oldNo ?? ''}</td><td class="ln">${l.newNo ?? ''}</td><td class="code">${code(l)}</td></tr>`;
    }
  });
  return html;
}

// Side by side: context on both sides, and each block of removals paired
// line by line with the additions that follow it.
function splitRows(hunks, stage) {
  let html = '';
  hunks.forEach((h, hn) => {
    const side = (l, cls) => l
      ? `<td class="ln c-${cls}"${lineAttr(l, h, stage)}>${l[cls === 'add' ? 'newNo' : 'oldNo'] ?? ''}</td><td class="code c-${cls}"${lineAttr(l, h, stage)}>${code(l, cls === 'add' ? 'new' : 'old')}</td>`
      : `<td class="ln c-empty"></td><td class="code c-empty"></td>`;
    const hi = staging(h, stage) ? ` data-h="${hn}"` : '';
    html += `<tr class="d-hunk"${hi}><td class="ln"></td><td class="code" colspan="3">${hunkHead(h, hn, stage)}</td></tr>`;
    const ls = h.lines;
    for (let i = 0; i < ls.length;) {
      const l = ls[i];
      if (l.type === 'note') {
        html += `<tr class="d-note"${hi}><td class="ln"></td><td class="code" colspan="3">${esc(l.text)}</td></tr>`;
        i++;
      } else if (l.type === 'ctx') {
        html += `<tr${hi}><td class="ln">${l.oldNo}</td><td class="code">${code(l, 'old')}</td><td class="ln">${l.newNo}</td><td class="code">${code(l, 'new')}</td></tr>`;
        i++;
      } else {
        const dels = [], adds = [];
        while (i < ls.length && ls[i].type === 'del') dels.push(ls[i++]);
        while (i < ls.length && ls[i].type === 'add') adds.push(ls[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          html += `<tr${hi}>${side(dels[k], 'del')}${side(adds[k], 'add')}</tr>`;
        }
      }
    }
  });
  return html;
}

// ---------- submodules ----------

// Reads `git diff --submodule=log` output for one submodule: "Submodule <path> <a>..<b>:"
// (or "<a>...<b> (rewind):", "(new submodule)", "(submodule deleted)", "(commits not present)"),
// then "  > subject" for each commit added and "  < subject" for each one removed.
// Returns null when the text is not about a submodule.
export function parseSubmoduleLog(text) {
  const res = { path: null, from: null, to: null, note: null, commits: [], modified: false, untracked: false };
  for (const line of (text || '').split('\n')) {
    let m;
    if ((m = line.match(/^Submodule (.+) contains (modified|untracked) content$/))) {
      res.path = m[1];
      res[m[2]] = true;
    } else if ((m = line.match(/^Submodule (.+) ([0-9a-f]+)\.{2,3}([0-9a-f]+)(?: \(([^)]+)\))?:?$/))) {
      Object.assign(res, { path: m[1], from: m[2], to: m[3], note: m[4] || null });
    } else if ((m = line.match(/^ {2}([<>]) (.*)$/)) && res.path) {
      res.commits.push({ added: m[1] === '>', subject: m[2] });
    }
  }
  return res.path ? res : null;
}

const isNull = sha => !sha || /^0+$/.test(sha);

// `info` is what parseSubmoduleLog returns, possibly completed with the status flags.
// `actions` is html for buttons shown under the summary.
export function renderSubmodule(info, { title, actions = '' } = {}) {
  const sha = s => `<span class="mono">${esc(s.slice(0, 7))}</span>`;
  let heading = 'Submodule', range = '';
  if (info.note === 'new submodule' || (isNull(info.from) && info.to)) {
    heading = 'Submodule added';
    range = `At commit ${sha(info.to)}`;
  } else if (info.note === 'submodule deleted' || (isNull(info.to) && info.from)) {
    heading = 'Submodule removed';
    range = `Was at commit ${sha(info.from)}`;
  } else if (info.from) {
    heading = info.note === 'rewind' ? 'Submodule moved back' : 'Submodule commit changed';
    range = `${sha(info.from)} → ${sha(info.to)}`;
  } else if (info.modified || info.untracked) {
    heading = 'Changes inside the submodule';
  }
  const added = info.commits.filter(c => c.added).length, removed = info.commits.length - added;
  const commits = info.commits.length ? `<div class="sub-commits">${info.commits.map(c =>
    `<div class="sub-commit ${c.added ? 'add' : 'del'}"><span class="sign">${c.added ? '+' : '−'}</span>${esc(c.subject)}</div>`).join('')}</div>` : '';
  const notes = [
    info.note === 'commits not present' && 'The commits are not in the local clone of the submodule — fetch it to see them.',
    info.modified && 'Its tracked files have uncommitted changes.',
    info.untracked && 'It has untracked files.',
    (info.modified || info.untracked) && 'Open the submodule to commit or discard them: this repository only records which commit it uses.',
  ].filter(Boolean).map(n => `<p>${esc(n)}</p>`).join('');
  const stats = info.commits.length
    ? `${added ? `<span class="stat-add">+${added}</span> ` : ''}${removed ? `<span class="stat-del">−${removed}</span> ` : ''}<span class="muted">commit${info.commits.length === 1 ? '' : 's'}</span>`
    : '<span class="muted">submodule</span>';
  return `<div class="diff-head">${title ? `<span class="diff-title">${esc(title)}</span>` : ''}<span class="diff-stats">${stats}</span></div>
    <div class="diff-scroll"><div class="info-card sub-card">
      <h3>${heading}</h3>
      ${range ? `<div class="sub-range">${range}</div>` : ''}
      ${commits}${notes}
      ${actions ? `<div class="info-actions">${actions}</div>` : ''}
    </div></div>`;
}

// ---------- Git LFS ----------

// LFS stores a small pointer ("version …", "oid sha256:…", "size …") in the repository, so the
// diff of an LFS file is a diff of pointers. Returns { old, new } pointers ({ oid, size } or
// null for a file added or deleted), or null when the diff is not about LFS pointers.
function lfsChange(d) {
  if (d.hunks.length !== 1) return null;
  const sides = { old: [], new: [] };
  for (const l of d.hunks[0].lines) {
    if (l.type === 'note') continue;
    if (l.type !== 'add') sides.old.push(l.text);
    if (l.type !== 'del') sides.new.push(l.text);
  }
  const pointer = lines => {
    if (!lines.length) return null;
    if (lines[0] !== 'version https://git-lfs.github.com/spec/v1') return undefined;
    const p = {};
    for (const l of lines) { const m = l.match(/^(oid|size) (.+)$/); if (m) p[m[1]] = m[2]; }
    return p.oid ? p : undefined;
  };
  const res = { old: pointer(sides.old), new: pointer(sides.new) };
  return res.old === undefined || res.new === undefined || (!res.old && !res.new) ? null : res;
}

function renderLfs(change, titleHtml) {
  const oid = p => `<span class="mono">${esc(p.oid.replace(/^sha256:/, '').slice(0, 12))}</span>`;
  const size = p => esc(fmtSize(p.size));
  const { old: a, new: b } = change;
  const [heading, rows] = !a ? ['LFS file added', `<dt>Size</dt><dd>${size(b)}</dd><dt>Object</dt><dd>${oid(b)}</dd>`]
    : !b ? ['LFS file deleted', `<dt>Size</dt><dd>${size(a)}</dd><dt>Object</dt><dd>${oid(a)}</dd>`]
    : ['LFS file changed', `<dt>Size</dt><dd>${size(a)} → ${size(b)}</dd><dt>Object</dt><dd>${oid(a)} → ${oid(b)}</dd>`];
  return `<div class="diff-head">${titleHtml}<span class="diff-stats"><span class="muted">Git LFS</span></span></div>
    <div class="diff-scroll"><div class="info-card lfs-card">
      <h3>${heading}</h3>
      <dl class="kv">${rows}</dl>
      <p>Its content is stored with Git LFS; the repository only keeps a pointer to it.</p>
    </div></div>`;
}

// `stage` ('stage' or 'unstage') adds the controls to stage or unstage hunks and lines (see
// unifiedRows), and a bar in the head for the selected lines.
export function renderDiff(text, { title, split = false, path, actions = '', stage = null } = {}) {
  const titleHtml = title ? `<span class="diff-title">${esc(title)}</span>` : '';
  if (!text || !text.trim()) {
    return `<div class="diff-empty">${title ? `<div class="diff-title">${esc(title)}</div>` : ''}<p>No differences to show.</p></div>`;
  }
  if (/^Submodule /.test(text) && !/^diff --git/m.test(text)) {
    const info = parseSubmoduleLog(text);
    if (info) return renderSubmodule(info, { title, actions });
  }
  const d = parseDiff(text);
  const lfs = lfsChange(d);
  if (lfs) return renderLfs(lfs, titleHtml);
  highlight(d.hunks, path);
  const stats = d.binary ? '<span class="muted">binary file</span>'
    : `<span class="stat-add">+${d.added}</span> <span class="stat-del">−${d.removed}</span>`;
  const toggle = `<div class="diff-mode" title="Diff layout">
    <button data-diff-mode="unified" class="${split ? '' : 'on'}">Unified</button><button data-diff-mode="split" class="${split ? 'on' : ''}">Split</button></div>`;
  if (!canStageParts(d)) stage = null;
  const verb = stage === 'stage' ? 'Stage' : 'Unstage';
  const lineSel = stage && d.hunks.length ? `<span class="line-sel" hidden><span class="line-sel-n"></span>
    <button class="btn-sm primary" data-part="lines">${verb} lines</button><button class="btn-sm" data-part="clear" title="Clear the selection (Esc)">Clear</button></span>` : '';
  const head = `<div class="diff-head">${titleHtml}${lineSel}<span class="diff-stats">${stats}</span>${d.hunks.length ? toggle : ''}</div>`;
  const metaHtml = d.meta.length ? `<div class="diff-meta">${d.meta.map(esc).join('<br>')}</div>` : '';
  if (!d.hunks.length) {
    return head + metaHtml + `<div class="diff-empty"><p>${d.binary ? 'Binary file — no text preview.' : 'No text changes to show.'}</p></div>`;
  }
  const cols = split ? 4 : 3;
  const trunc = d.truncated ? `<tr class="d-trunc"><td colspan="${cols}">Diff too large — showing the first ${MAX_LINES} lines.</td></tr>` : '';
  const cls = stage ? ' stageable' : '';
  const table = split
    ? `<table class="diff split${cls}"><colgroup><col class="ln-col"><col><col class="ln-col"><col></colgroup><tbody>${splitRows(d.hunks, stage)}${trunc}</tbody></table>`
    : `<table class="diff${cls}"><tbody>${unifiedRows(d.hunks, stage)}${trunc}</tbody></table>`;
  return head + metaHtml + `<div class="diff-scroll">${table}</div>`;
}
