import * as G from './git.js';
import { computeGraph, graphSvg, LANE_W, laneColor } from './graph.js';
import { renderDiff, renderSubmodule, parseSubmoduleLog } from './diff.js';
import { partialPatch } from './patch.js';
import { parseConflicts, hasMarkers, resolvedContent, startEdit, renderResolver, renderConflictCard } from './conflict.js';
import { esc, splitPath, fmtDate, fmtRelative, debounce, store, icon, fileIcon, pathTree, renderTree, treeCompare, normPath, folderName, plural } from './util.js';
import { initZoom, onZoom, getZoom, resetZoom } from './zoom.js';
import { initExplorer, renderExplorer, restoreExplorer, captureExplorer, forgetExplorer, explorerFolder, focusExplorerSearch, revealPath } from './explorer.js';
import * as P from './projects.js';
import { syncStatus, onSyncStatus } from './mirror.js';
import { initDashboard, renderDashboard, updateDashboard, reloadDashboard, addMenuItems } from './dashboard.js';
import * as S from './notes-store.js';
import { desktop, invoke, isMobile, onMobileChange } from './platform.js';
import * as M from './mobile.js';
import { configured, initAccount, onAccount, currentUser, signIn, signOut, signInFailure, userName, userAvatar } from './account.js';
import { initNotesUi, mountNoteTab, leaveNoteTab, renderNoteTree, renderNotesPanel, openNote, newNote, newDatabase, closePeek, noteTitle, noteIcon, noteMenuItems } from './notes.js';

const $ = (sel, root = document) => root.querySelector(sel);
const tauri = window.__TAURI__;

const state = {
  repo: null,               // the folder of the active tab
  note: null,               // the note of the active tab (when it is a note)
  plain: false,             // the folder is not a Git repository: only the explorer is available
  mode: 'git',              // 'git' | 'explorer' (see explorer.js)
  view: 'changes',          // 'changes' | 'history'
  status: null,
  refs: null,
  stashes: [],
  log: [],
  graph: [],
  selected: null,           // index of the selected commit
  commitFiles: [],
  commitFile: null,
  fileFilter: '',           // filter for the unstaged/staged lists
  branchFilter: '',         // filter for the sidebar branches
  commitMsg: '',
  amend: false,
  op: null,                 // merge/rebase/cherry-pick/revert in progress (see G.getOperation)
  mergeMsg: null,           // merge message put in the commit box for the merge in progress
  mergeTool: null,          // merge.tool from the git config, when there are conflicts
  submodules: [],           // see G.getSubmodules
  lfs: null,                // see G.getLfs
  collapsed: store('collapsed') || {},
  branchTree: store('branchTree') ?? true,
  fileTree: !!store('fileTree'),
};

// =====================================================================
// Basic UI: toasts, context menu, modals
// =====================================================================

function toast(msg, type = 'info', detail = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div>${esc(msg)}</div>${detail ? `<pre>${esc(detail)}</pre>` : ''}<button class="x">${icon('close')}</button>`;
  el.querySelector('.x').onclick = () => el.remove();
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 12000 : type === 'warn' ? 8000 : 3500);
}

// An item's `run` gets where the item was on the screen (to open more choices there).
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<div class="mi-sep"></div>'
    : `<div class="mi ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  m.onclick = e => {
    const mi = e.target.closest('.mi');
    if (!mi) return;
    const r = mi.getBoundingClientRect();
    hideMenu();
    items[+mi.dataset.i].run(r);
  };
}
const hideMenu = () => ($('#menu').hidden = true);
window.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) hideMenu(); });
window.addEventListener('blur', hideMenu);

// `fields` ([{ label, value, placeholder, optional }]) asks for several values at once;
// they come back as `values`. `checks` ([{ label, value, toggle, dangerOk, hint }]) adds options
// that come back as `checks`; `check` is the shorthand for a single one, returned as `checked`.
function modal({ title, message = '', input = null, fields = null, check = null, checks = check ? [check] : [], ok = 'OK', danger = false, allowEmpty = false, placeholder = '' }) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-back"><form class="modal">
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${input !== null ? `<input type="text" spellcheck="false" value="${esc(input)}" placeholder="${esc(placeholder)}">` : ''}
      ${(fields || []).map((f, i) => `<label class="field"><span>${esc(f.label)}</span>
        <input type="text" spellcheck="false" data-field="${i}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"></label>`).join('')}
      ${checks.map(c => `<label class="check ${c.toggle ? 'toggle' : ''} ${c.dangerOk ? 'danger' : ''}"><input type="checkbox" ${c.value ? 'checked' : ''}>${c.toggle ? '<span class="switch"></span>' : ''} ${esc(c.label)}</label>
        ${c.hint ? `<div class="check-hint">${esc(c.hint)}</div>` : ''}`).join('')}
      <div class="buttons"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>
    </form></div>`;
    const form = $('form', root), inp = $('input[type=text]', root), boxes = [...root.querySelectorAll('input[type=checkbox]')];
    // Dangerous option: the main button turns red and changes its label while it is on.
    checks.forEach((c, i) => {
      if (!c.dangerOk) return;
      const okBtn = $('[data-ok]', root), chk = boxes[i];
      chk.onchange = () => {
        okBtn.classList.toggle('danger', chk.checked);
        okBtn.classList.toggle('primary', !chk.checked);
        okBtn.textContent = chk.checked ? c.dangerOk : ok;
      };
    });
    const picked = () => ({ checked: boxes[0]?.checked, checks: boxes.map(b => b.checked) });
    const close = v => { root.innerHTML = ''; resolve(v); };
    form.onsubmit = e => {
      e.preventDefault();
      if (fields) {
        const inputs = [...root.querySelectorAll('[data-field]')];
        const missing = inputs.find((el, i) => !fields[i].optional && !el.value.trim());
        if (missing) return missing.focus();
        return close({ values: inputs.map(el => el.value.trim()), ...picked() });
      }
      if (inp && !allowEmpty && !inp.value.trim()) return inp.focus();
      close({ value: inp?.value.trim(), ...picked() });
    };
    $('[data-cancel]', root).onclick = () => close(null);
    $('.modal-back', root).onmousedown = e => { if (e.target.classList.contains('modal-back')) close(null); };
    form.onkeydown = e => { if (e.key === 'Escape') close(null); };
    setTimeout(() => (inp ? (inp.focus(), inp.select()) : $('.btn:last-child', root).focus()));
  });
}

async function confirmBox(title, message, ok = 'Confirm', danger = true) {
  return !!(await modal({ title, message, ok, danger }));
}

const matches = (text, filter) => !filter || text.toLowerCase().includes(filter.toLowerCase());

// Diff panes remember their last diff so the Unified/Split toggle can re-render it.
let diffSplit = !!store('diffSplit');

// `path` picks the syntax highlighting language. `part` ({ kind, path }: a file of the Changes
// view) adds the controls to stage or unstage its hunks and selected lines. The selected lines
// (`lines`, ids from parseDiff) stay while the diff shown is the same.
function showDiff(pane, text, title, path = title, part = null) {
  const prev = pane._diff;
  const same = prev && prev.text === text && prev.path === path && prev.part?.kind === part?.kind;
  pane._diff = { text, title, path, part, lines: same ? prev.lines : new Set(), anchor: same ? prev.anchor : null };
  pane.innerHTML = renderDiff(text, { title, path, split: diffSplit, stage: part && (part.kind === 'staged' ? 'unstage' : 'stage') });
  if (part) paintLines(pane);
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-diff-mode]');
  if (!btn) return;
  diffSplit = btn.dataset.diffMode === 'split';
  store('diffSplit', diffSplit);
  const pane = btn.closest('.diff-pane'), d = pane?._diff;
  if (d) showDiff(pane, d.text, d.title, d.path, d.part);
});

// ---------- staging hunks and lines ----------

function paintLines(pane) {
  const d = pane._diff, n = d.lines.size;
  pane.querySelectorAll('[data-l]').forEach(el => el.classList.toggle('lsel', d.lines.has(+el.dataset.l)));
  const bar = pane.querySelector('.line-sel');
  if (!bar) return;
  bar.hidden = !n;
  $('.line-sel-n', bar).textContent = `${plural(n, 'line')} selected`;
}

function setLines(pane, ids, anchor = pane._diff.anchor) {
  Object.assign(pane._diff, { lines: new Set(ids), anchor });
  paintLines(pane);
}

// The lines from id `a` to id `b`; in the split layout, only those on a's side.
function lineRange(pane, a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const side = el => (el.matches('.d-add, .c-add') ? 'add' : 'del');
  const split = !!$('table.diff.split', pane), from = $(`[data-l="${a}"]`, pane);
  return [...pane.querySelectorAll('[data-l]')]
    .filter(el => +el.dataset.l >= lo && +el.dataset.l <= hi && (!split || !from || side(el) === side(from)))
    .map(el => +el.dataset.l);
}

// Lines the text selection goes through, if it is in this diff.
function textSelLines(pane) {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return [];
  const r = s.getRangeAt(0);
  return [...new Set([...pane.querySelectorAll('[data-l]')].filter(el => r.intersectsNode(el)).map(el => +el.dataset.l))];
}

// Line numbers select lines: a click selects one (or clears it when it was the only one),
// dragging selects a range, Shift+click extends and Ctrl+click toggles.
let lineDrag = null;
function lineMouseDown(e) {
  const ln = e.button === 0 && e.target.closest('table.diff.stageable td.ln');
  const el = ln && ln.closest('[data-l]');
  if (!el) return false;
  e.preventDefault();
  const pane = el.closest('.diff-pane'), d = pane._diff, id = +el.dataset.l;
  if (e.shiftKey && d.anchor != null) setLines(pane, lineRange(pane, d.anchor, id));
  else if (e.ctrlKey || e.metaKey) {
    const ids = new Set(d.lines);
    ids.has(id) ? ids.delete(id) : ids.add(id);
    setLines(pane, ids, id);
  } else {
    setLines(pane, d.lines.size === 1 && d.lines.has(id) ? [] : [id], id);
    lineDrag = pane;
  }
  return true;
}
document.addEventListener('mouseover', e => {
  const el = lineDrag && e.target.closest('[data-l]');
  if (el && lineDrag.contains(el)) setLines(lineDrag, lineRange(lineDrag, lineDrag._diff.anchor, +el.dataset.l));
});
window.addEventListener('mouseup', () => (lineDrag = null));

function clearLines() {
  const pane = $('.changes .diff-pane');
  if (pane?._diff?.lines.size) setLines(pane, [], null);
}

// Stages (from the unstaged diff) or unstages (from the staged one) the changes that
// `pick(line, hunkIndex)` chooses in the file shown in the pane.
let applyingPart = false;
async function applyPart(pane, pick) {
  const d = pane._diff;
  if (!d?.part || applyingPart) return;
  const reverse = d.part.kind === 'staged';
  let patch;
  try {
    patch = partialPatch(d.text, pick, reverse);
  } catch (e) {
    return toast(`${reverse ? 'Unstage' : 'Stage'} failed`, 'error', String(e.message || e));
  }
  if (!patch) return;
  applyingPart = true;
  try {
    await run(reverse ? 'Unstage' : 'Stage', () => G.applyToIndex(state.repo, patch, reverse),
      { busy: reverse ? 'Unstaging' : 'Staging', on: [at.file(d.part.kind, d.part.path)] });
  } finally {
    applyingPart = false;
  }
}

function partClick(btn) {
  const pane = btn.closest('.diff-pane'), d = pane._diff, h = +btn.dataset.h;
  if (btn.dataset.part === 'clear') return setLines(pane, [], null);
  const lines = new Set(d.lines);
  applyPart(pane, btn.dataset.part === 'hunk' ? (l, i) => i === h : l => lines.has(l.id));
}

// Right-click on a line: the selected lines (or the ones the text selection goes through, or
// the line clicked), and its hunk.
function lineMenu(e, row) {
  const pane = row.closest('.diff-pane'), d = pane._diff;
  const el = e.target.closest('[data-l]'), id = el ? +el.dataset.l : null;
  const text = getSelection().toString(), textLines = textSelLines(pane);
  let lines = [...d.lines];
  if (!lines.length && textLines.length) lines = textLines;
  else if (id != null && !d.lines.has(id)) setLines(pane, lines = [id], id);
  const verb = d.part.kind === 'staged' ? 'Unstage' : 'Stage', h = +row.dataset.h;
  showMenu(e.clientX, e.clientY, [
    { label: lines.length > 1 ? `${verb} ${lines.length} lines` : `${verb} line`, disabled: !lines.length, run: () => applyPart(pane, l => lines.includes(l.id)) },
    { label: `${verb} hunk`, run: () => applyPart(pane, (l, i) => i === h) },
    '-',
    { label: 'Copy', disabled: !text, run: () => copy(text) },
  ]);
}

// =====================================================================
// Running commands with a "busy" indicator
// =====================================================================

// Runs a git action. `busy` is the status shown while it runs ("Pushing") and `on` lists
// selectors (see `at`) of the elements that get a spinner, e.g. the branch being pushed.
// The status stays until the refresh that follows the action has rendered the result.
// With `mayConflict` (merge, rebase, pull...), an action that stops because of conflicts is
// not reported as a failure: it points the user to the conflicts instead.
async function run(label, fn, { reload = true, success, busy, on = [], mayConflict = false } = {}) {
  const id = addPending({ text: busy || label, on });
  const hadConflicts = !!state.status?.conflicts.length;
  let error = null;
  try {
    const r = await fn();
    if (success) toast(success, 'ok');
    return r;
  } catch (e) {
    error = e;
    if (!mayConflict || !reload) toast(`${label} failed`, 'error', String(e.message || e));
  } finally {
    if (reload) await refresh();
    removePending(id);
    if (error && mayConflict && reload) {
      if (!hadConflicts && state.status?.conflicts.length) {
        toast(`${label} stopped because of conflicts — resolve them to continue`, 'warn');
        if (state.view !== 'changes') setView('changes');
      } else {
        toast(`${label} failed`, 'error', String(error.message || error));
      }
    }
  }
}

// Selectors for the elements an action can point at.
const at = {
  branch: name => `#sidebar-body [data-branch="${CSS.escape(name)}"]`,
  remoteBranch: full => `#sidebar-body [data-remote-branch="${CSS.escape(full)}"]`,
  remote: name => `#sidebar-body [data-remote="${CSS.escape(name)}"]`,
  allRemotes: () => '#sidebar-body [data-remote]',
  tag: name => `#sidebar-body [data-tag="${CSS.escape(name)}"]`,
  submodule: path => `#sidebar-body [data-submodule="${CSS.escape(path)}"]`,
  allSubmodules: () => '#sidebar-body [data-submodule]',
  group: id => `#sidebar-body [data-group="${id}"]`,
  stash: ref => `#sidebar-body [data-stash="${CSS.escape(ref)}"]`,
  commit: sha => `.commit-row[data-sha="${sha}"]`,
  file: (kind, path) => `.changes [data-kind="${kind}"] .file-row[data-path="${CSS.escape(path)}"]`,
  allFiles: kind => `.changes [data-kind="${kind}"] .file-row`,
  action: name => `#toolbar [data-action="${name}"]`,
  op: () => '#op-banner .op-text',
  tab: path => `#tabs [data-tab="${CSS.escape(path)}"]`,
  current: () => (state.status?.branch && !state.status.detached ? at.branch(state.status.branch) : null),
  // a branch name that may be local ("main") or remote ("origin/main")
  ref: ref => (state.refs?.local.some(b => b.name === ref) ? at.branch(ref) : at.remoteBranch(ref)),
};

const pending = new Map();
let pendingId = 0;

// `quiet` entries (refresh, tab loading) show only their spinner, not the toolbar status,
// and `delay` keeps fast operations from flashing a spinner.
function addPending({ text, on = [], quiet = false, delay = 0 }) {
  const id = ++pendingId;
  const entry = { text, on: on.filter(Boolean), quiet, shown: !delay };
  pending.set(id, entry);
  if (delay) setTimeout(() => { if (pending.has(id)) { entry.shown = true; paintBusy(); } }, delay);
  paintBusy();
  return id;
}

function removePending(id) {
  pending.delete(id);
  paintBusy();
}

const busyTag = text => `<span class="busy-tag"><span class="spinner"></span><span class="busy-text">${esc(text)}…</span></span>`;

// Re-applied after every render, since renders replace the decorated elements.
function paintBusy() {
  document.querySelectorAll('.is-busy').forEach(el => {
    el.classList.remove('is-busy');
    el.querySelectorAll('.busy-tag').forEach(t => t.remove());
  });
  for (const p of pending.values()) {
    if (!p.shown) continue;
    for (const sel of p.on) {
      document.querySelectorAll(sel).forEach(el => {
        if (el.classList.contains('is-busy')) return;
        el.classList.add('is-busy');
        const row = el.matches('.commit-row');
        (row ? el.querySelector('.c-subject') : el).insertAdjacentHTML(row ? 'afterbegin' : 'beforeend', busyTag(p.text));
      });
    }
  }
  const loud = [...pending.values()].filter(p => !p.quiet);
  const last = loud[loud.length - 1];
  $('#busy').hidden = !last;
  $('#busy-text').textContent = last ? last.text + '…' : '';
  document.querySelectorAll('#repo-actions .tb').forEach(b => (b.disabled = !!last));
  $('#op-banner').classList.toggle('locked', !!last);
}

const g = args => G.git(state.repo, args);

// =====================================================================
// Repository
// =====================================================================

// Returns the chosen folder, or a list of them with `multiple` (null when cancelled).
async function pickFolders({ multiple = false, title = 'Open a repository or folder' } = {}) {
  try {
    return await tauri.dialog.open({ directory: true, multiple, title });
  } catch {
    return invoke('plugin:dialog|open', { options: { directory: true, multiple, title } });
  }
}

async function openRepoDialog() {
  const path = await pickFolders();
  if (path) openRepo(path);
}

// =====================================================================
// Repository tabs
// =====================================================================

// Each project is a space with its own tabs, after a pinned tab with its dashboard; the "home" space
// has the folders opened outside any project, after a pinned tab with the start page.
// `list` holds the tabs of the current space in order: folder paths, and "note:<id>" for notes;
// `seen` has the tabs of the current space in the order they were last shown, most recent last
// ('' for the pinned tab), so closing a tab goes back to the one seen before it.
// The other spaces wait in `spaces` ({ list, active, seen }, `active` being null when the pinned
// tab is shown). `ui` keeps each folder's view state (mode, view, commit message draft, filters,
// selected commit, explorer folder) so switching tabs restores it. `plain` has the open folders
// that are not Git repositories.
const tabs = { list: [], seen: [], ui: store('tabUi') || {}, plain: new Set(), space: 'home', spaces: {}, ready: false };

const noteKey = id => 'note:' + id;
const noteOf = key => (key?.startsWith('note:') ? key.slice(5) : null);
const activeKey = () => state.repo ?? (state.note ? noteKey(state.note) : null);

function saveTabs() {
  const shown = activeKey() ?? '';
  tabs.seen = [...tabs.seen.filter(k => k !== shown && (k === '' || tabs.list.includes(k))), shown].slice(-50);
  tabs.spaces[tabs.space] = { list: tabs.list, active: activeKey(), seen: tabs.seen };
  store('spaces', tabs.spaces);
  store('space', tabs.space);
  store('tabUi', tabs.ui);
}

// A folder can be open in several spaces: its view state is kept until its last tab is closed.
const openSomewhere = p => tabs.list.includes(p) || Object.entries(tabs.spaces).some(([id, s]) => id !== tabs.space && s.list.includes(p));

function forgetTabs(paths) {
  for (const p of paths) {
    if (openSomewhere(p)) continue;
    delete tabs.ui[p];
    forgetExplorer(p);
  }
}

function captureUi() {
  if (!state.repo) return;
  tabs.ui[state.repo] = {
    mode: state.mode,
    explorer: captureExplorer(state.repo),
    view: state.view,
    commitMsg: state.commitMsg,
    amend: state.amend,
    mergeMsg: state.mergeMsg,
    fileFilter: state.fileFilter,
    branchFilter: state.branchFilter,
    selectedSha: state.selected != null ? state.log[state.selected]?.sha ?? null : null,
  };
}

function addRecent(root) {
  const recent = (store('recent') || []).filter(p => p !== root);
  store('recent', [root, ...recent].slice(0, 20));
}

const saveSoon = debounce(() => { captureUi(); saveTabs(); }, 400);

const isFolder = path => G.statPath(path, '').then(s => s.dir, () => false);

// Opens a repository in a tab (reusing its tab if it is already open). Folders that are not
// Git repositories open too, in the explorer.
async function openRepo(path, { silent = false } = {}) {
  let root;
  try {
    root = await G.repoRoot(path);
    tabs.plain.delete(root);
  } catch (e) {
    root = normPath(path);
    if (!(await isFolder(root))) {
      if (silent) throw e;
      return toast('Folder not found', 'error', path);
    }
    tabs.plain.add(root);
  }
  if (!tabs.list.includes(root)) tabs.list.splice(tabs.list.indexOf(activeKey()) + 1, 0, root);
  await activateRepo(root);
}

async function initRepo() {
  const path = state.repo;
  if (!path || !state.plain) return;
  if (!(await confirmBox('Initialize Git repository', `Create a Git repository in this folder?\n\n${path}`, 'git init', false))) return;
  try {
    await G.git(path, ['init']);
  } catch (e) {
    return toast('git init failed', 'error', e.message);
  }
  if (state.repo !== path) return;
  tabs.plain.delete(path);
  state.plain = false;
  state.view = 'changes';
  applyMode();
  await refresh();
  setMode('git');
  toast('Git repository created', 'ok');
}

// Opens a repository from the recent list, dropping it from the list if it is gone.
async function openRecent(path) {
  try {
    await openRepo(path, { silent: true });
  } catch {
    store('recent', (store('recent') || []).filter(p => p !== path));
    toast('Repository not found — removed from the recent list', 'error', path);
    if (!state.repo) renderHome();
  }
}

function activateTab(key) {
  const id = noteOf(key);
  if (!id) return activateRepo(key);
  if (!S.getNote(id)) return showHome(); // (its tab is hidden: see resolveTabs)
  if (state.note === id && !state.repo) return renderTabs();
  showPage(id);
}

// Leaving a note tab: its editor goes away (what was typed is saved).
function leaveNote() {
  if (!state.note) return;
  leaveNoteTab();
  state.note = null;
}

async function activateRepo(root) {
  if (root === state.repo) return renderTabs();
  captureUi();
  closePeek();
  leaveNote();
  const ui = tabs.ui[root] || {};
  state.repo = root;
  state.plain = tabs.plain.has(root);
  state.mode = state.plain || ui.mode === 'explorer' ? 'explorer' : 'git';
  restoreExplorer(root, ui.explorer);
  applyMode();
  state.status = null;
  state.refs = null;
  state.stashes = [];
  state.view = ui.view || 'changes';
  state.selected = null;
  state.commitFile = null;
  state.sel = emptySel();
  state.fileFilter = ui.fileFilter || '';
  state.branchFilter = ui.branchFilter || '';
  $('#branch-filter').value = state.branchFilter;
  state.commitMsg = ui.commitMsg || '';
  state.amend = !!ui.amend;
  state.mergeMsg = ui.mergeMsg ?? null;
  state.op = null;
  state.mergeTool = null;
  state.submodules = [];
  state.lfs = null;
  state.log = [];
  addRecent(root);
  saveTabs();
  document.body.classList.remove('no-repo');
  $('#main').innerHTML = '';
  renderTabs();
  const loading = addPending({ text: 'Loading', on: [at.tab(root)], quiet: true, delay: 200 });
  await refresh();
  removePending(loading);
  if (state.repo !== root) return; // another tab was activated meanwhile
  if (ui.selectedSha) {
    const idx = state.log.findIndex(c => c.sha === ui.selectedSha);
    if (idx >= 0) state.selected = idx;
  }
  const hasChanges = state.status && changeCount(state.status) > 0;
  state.view = ui.view || (hasChanges ? 'changes' : 'history');
  if (state.mode === 'git') setView(state.view);
}

// Git mode (changes, branches, history) or the file explorer, chosen per tab.
function setMode(mode) {
  if (!state.repo || mode === state.mode) return;
  if (mode === 'git' && state.plain) return initRepo();
  state.mode = mode;
  applyMode();
  if (mode === 'git') setView(state.view);
  else {
    $('#main').innerHTML = '';
    renderMain();
  }
  captureUi();
  saveTabs();
}

function applyMode() {
  document.body.classList.toggle('note-page', !!state.note);
  document.body.classList.toggle('mode-explorer', state.mode === 'explorer');
  document.body.classList.toggle('plain', state.plain);
  document.querySelectorAll('#mode-toggle [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
  const gitBtn = $('#mode-toggle [data-mode="git"]');
  gitBtn.classList.toggle('off', state.plain);
  gitBtn.title = state.plain ? 'This folder is not a Git repository — click to create one' : 'Git — changes, branches and history (Ctrl+E)';
  renderTabs();
}

const tabMode = p => (p === state.repo ? state.mode : tabs.plain.has(p) ? 'explorer' : tabs.ui[p]?.mode || 'git');

function closeTab(key = activeKey()) {
  const i = tabs.list.indexOf(key);
  if (i < 0) return;
  tabs.list.splice(i, 1);
  forgetTabs([key]);
  if (key !== activeKey()) { saveTabs(); return renderTabs(); }
  state.repo = null; // the closed tab's state must not be captured
  leaveNote();
  showPrevious(i);
}

// After the tab being shown was closed: the tab seen before it, or else the one that took its
// place (`i`) or the one before.
function showPrevious(i) {
  const prev = tabs.seen.findLast(k => k === '' || tabs.list.includes(k));
  const next = prev ?? tabs.list[i] ?? tabs.list[i - 1];
  if (next) activateTab(next);
  else showHome();
}

function closeOtherTabs(keep, onlyRight = false) {
  const i = tabs.list.indexOf(keep);
  const closing = tabs.list.filter((p, k) => p !== keep && (!onlyRight || k > i));
  tabs.list = tabs.list.filter(p => !closing.includes(p));
  forgetTabs(closing);
  if (closing.includes(activeKey())) { state.repo = null; leaveNote(); activateTab(keep); }
  else { saveTabs(); renderTabs(); }
}

// The pinned tab (dashboard or start page) comes first.
function cycleTab(delta) {
  const seq = [null, ...tabs.list];
  const next = seq[(seq.indexOf(activeKey()) + delta + seq.length) % seq.length];
  if (next) activateTab(next);
  else showHome();
}

// Shows the pinned tab of the space: the project's dashboard, or the start page.
const showHome = () => showPage(null);

// Shows a note tab, or with no note the pinned tab of the space. Any peek closes.
function showPage(note) {
  captureUi();
  closePeek();
  if (state.note !== note) leaveNote();
  state.repo = null;
  state.note = note;
  state.plain = false;
  state.mode = 'git';
  saveTabs();
  applyMode();
  document.body.classList.add('no-repo');
  renderToolbar();
  renderOpBanner();
  if (note) mountNoteTab(note);
  else renderHome();
  M.visited({ space: tabs.space, note });
}

// Opens a note in a tab; with `replace`, the note tab being shown goes there instead.
// A note that already has a tab is shown there.
function openNoteTab(id, { replace = false } = {}) {
  const key = noteKey(id);
  if (!tabs.list.includes(key)) {
    const at = tabs.list.indexOf(activeKey());
    if (replace && state.note && at >= 0) tabs.list[at] = key;
    else tabs.list.splice(at + 1, 0, key);
  }
  if (state.note !== id) showPage(id);
  else renderTabs();
}

// Notes that were deleted lose their tabs, in every space.
function closeNoteTabs(ids) {
  const keys = ids.map(noteKey);
  for (const s of Object.values(tabs.spaces)) s.list = s.list.filter(k => !keys.includes(k));
  const wasActive = keys.includes(activeKey());
  const i = tabs.list.indexOf(activeKey());
  tabs.list = tabs.list.filter(k => !keys.includes(k));
  if (!wasActive) { saveTabs(); return renderTabs(); }
  leaveNote();
  showPrevious(Math.min(i, tabs.list.length - 1));
}

function renderHome() {
  if (P.getProject(tabs.space)) renderDashboard(tabs.space);
  else renderWelcome();
}

// Tab labels are the folder name; tabs with the same name also show the parent folder.
function tabLabel(path) {
  const name = folderName(path);
  const twins = tabs.list.filter(p => folderName(p) === name);
  return twins.length > 1 ? `${name} — ${path.split('/').slice(-2, -1)[0] || path}` : name;
}

// The icon tells the tab's mode: a branch in Git mode, a folder in the explorer, a page for notes.
function renderTabs() {
  const project = P.getProject(tabs.space), active = activeKey();
  const home = `<div class="tab home ${active ? '' : 'active'}" title="${project ? `Dashboard of ${esc(project.name)}` : 'Start page'}">
      ${icon(project ? 'grid' : 'home')}<span class="tab-label">${project ? 'Dashboard' : 'Home'}</span></div>`;
  const tab = (key, ic, label, title) => `
    <div class="tab ${key === active ? 'active' : ''}" data-tab="${esc(key)}" title="${esc(title)}" draggable="true">
      ${icon(ic)}<span class="tab-label">${esc(label)}</span>
      <button class="tab-x" title="Close tab (Ctrl+W)">${icon('close')}</button>
    </div>`;
  $('#tabs').innerHTML = home + tabs.list.filter(p => !noteOf(p) || S.getNote(noteOf(p))).map(p => (noteOf(p)
    ? tab(p, noteIcon(noteOf(p)), noteTitle(noteOf(p)), noteTitle(noteOf(p)))
    : tab(p, tabMode(p) === 'explorer' ? 'folder' : 'branch', tabLabel(p), p + (tabs.plain.has(p) ? '\nNot a Git repository' : '')))).join('')
    + `<button class="tab-new" title="Open a folder or a new note (Ctrl+T)">${icon('plus')}</button>`;
  $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  paintBusy();
  M.paintBar();
}

// Menu of the "+" button: the project's folders that are not open, a folder, or one of the recent
// repositories not already open.
function newTabMenu(x, y, extra = []) {
  const project = P.getProject(tabs.space);
  const linked = (project?.folders || []).map(f => f.path).filter(p => !tabs.list.includes(p));
  const recent = (store('recent') || []).filter(p => !tabs.list.includes(p) && !linked.includes(p));
  const item = (p, run) => ({ label: `${folderName(p)}  —  ${p}`, run });
  const notes = [
    { label: 'New page', run: () => newNote({ space: tabs.space, open: 'tab' }) },
    { label: 'New database', run: () => newDatabase({ space: tabs.space, open: 'tab' }) },
  ];
  if (!desktop) return showMenu(x, y, [...notes, ...extra]);
  showMenu(x, y, [
    ...notes,
    '-',
    ...linked.map(p => item(p, () => openRepo(p))),
    ...(linked.length ? ['-'] : []),
    { label: 'Open repository or folder…', run: openRepoDialog },
    ...(recent.length ? ['-', ...recent.map(p => item(p, () => openRecent(p)))] : []),
    ...(recent.length ? ['-', { label: 'Clear recent list', run: () => store('recent', tabs.list.slice()) }] : []),
    ...extra,
  ]);
}

function showNewTabMenu() {
  const r = $('#tabs .tab-new').getBoundingClientRect();
  newTabMenu(r.left, r.bottom + 4);
}

function bindTabs() {
  const bar = $('#tabs');
  bar.addEventListener('mousedown', e => {
    const tab = e.target.closest('.tab');
    if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
    if (!tab || e.button !== 0 || e.target.closest('.tab-x')) return;
    if (tab.classList.contains('home')) { if (activeKey()) showHome(); }
    else activateTab(tab.dataset.tab);
  });
  bar.addEventListener('auxclick', e => {
    const tab = e.target.closest('.tab[data-tab]');
    if (tab && e.button === 1) closeTab(tab.dataset.tab);
  });
  bar.addEventListener('click', e => {
    const x = e.target.closest('.tab-x');
    if (x) return closeTab(x.closest('.tab').dataset.tab);
    if (e.target.closest('.tab-new')) showNewTabMenu();
  });
  bar.addEventListener('dblclick', e => { if (e.target === bar) openRepoDialog(); });
  bar.addEventListener('contextmenu', e => {
    const tab = e.target.closest('.tab[data-tab]');
    if (!tab) return;
    e.preventDefault();
    const p = tab.dataset.tab, i = tabs.list.indexOf(p), note = noteOf(p);
    const addTo = note ? [] : addToProjectItems(p);
    showMenu(e.clientX, e.clientY, [
      { label: 'Close tab', run: () => closeTab(p) },
      { label: 'Close other tabs', disabled: tabs.list.length < 2, run: () => closeOtherTabs(p) },
      { label: 'Close tabs to the right', disabled: i === tabs.list.length - 1, run: () => closeOtherTabs(p, true) },
      '-',
      ...(note ? noteMenuItems(note, 'tabbar') : [
        { label: 'Open terminal here', run: () => invoke('open_terminal', { repo: p }).catch(err => toast('Open terminal failed', 'error', String(err))) },
        { label: 'Copy path', run: () => copy(p) },
      ]),
      ...(addTo.length ? ['-', ...addTo] : []),
    ]);
  });

  // Drag tabs to reorder them
  let dragged = null;
  const clearMarks = () => bar.querySelectorAll('.drop-before, .drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
  bar.addEventListener('dragstart', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    dragged = tab.dataset.tab;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged);
  });
  bar.addEventListener('dragover', e => {
    const tab = e.target.closest('.tab[data-tab]');
    if (!dragged || !tab || tab.dataset.tab === dragged) return;
    e.preventDefault();
    clearMarks();
    const r = tab.getBoundingClientRect();
    tab.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  bar.addEventListener('drop', e => {
    const tab = e.target.closest('.tab[data-tab]');
    if (!dragged || !tab) return;
    e.preventDefault();
    // the tabs are drawn again, so "dragend" won't reach the bar: the drag ends here
    const moving = dragged;
    dragged = null;
    const after = tab.classList.contains('drop-after');
    tabs.list = tabs.list.filter(p => p !== moving);
    tabs.list.splice(tabs.list.indexOf(tab.dataset.tab) + (after ? 1 : 0), 0, moving);
    saveTabs();
    renderTabs();
  });
  bar.addEventListener('dragend', () => { dragged = null; clearMarks(); bar.querySelector('.dragging')?.classList.remove('dragging'); });
}

// =====================================================================
// Projects (spaces)
// =====================================================================

// Reopens the space and the tabs of the last session.
async function restoreSpaces() {
  let spaces = store('spaces');
  if (!spaces) { // older versions had a single list of tabs, or a single repository
    const last = store('lastRepo');
    spaces = { home: { list: store('tabs') || (last ? [last] : []), active: store('activeTab') ?? null } };
  }
  // (the tabs of projects not shown now are kept: signed in, the projects of this computer aren't shown)
  tabs.spaces = spaces;
  const space = store('space');
  // (a phone starts at Home)
  await switchSpace(!isMobile() && P.getProject(space) ? space : 'home');
}

// The tabs of a space are checked when the space is first shown in this run: folders and notes
// that no longer exist are dropped. Returns a map of tab -> repository root or folder (or null).
const checkedSpaces = new Set();
let checking = null; // the space whose tabs are being checked
let switches = 0;

async function resolveTabs(list) {
  const out = new Map();
  await Promise.all(list.map(async p => {
    // (a note that isn't here keeps its tab, hidden: it may be the account's, or this computer's)
    if (noteOf(p)) return out.set(p, p);
    const root = await G.repoRoot(p).catch(() => null);
    if (root) { tabs.plain.delete(root); return out.set(p, root); }
    if (!(await isFolder(p))) return out.set(p, null);
    tabs.plain.add(p);
    out.set(p, p);
  }));
  return out;
}

// Shows a space (a project, or 'home') with its tabs, as they were left. Choosing the current
// space again shows its pinned tab.
async function switchSpace(id) {
  if (tabs.ready && id === tabs.space) return showHome();
  captureUi();
  if (tabs.ready && (tabs.space === 'home' || P.getProject(tabs.space))) {
    // A space left while its tabs were being checked keeps the tab it had active.
    const active = checking === tabs.space ? tabs.spaces[tabs.space]?.active ?? null : activeKey();
    tabs.spaces[tabs.space] = { list: tabs.list, active, seen: tabs.seen };
  }
  tabs.ready = true;
  const saved = tabs.spaces[id] || { list: [], active: null };
  tabs.space = id;
  tabs.seen = (saved.seen || []).slice();
  tabs.list = saved.list.slice();
  state.repo = null;
  closePeek();
  leaveNote();
  $('#main').innerHTML = '';
  renderRail();
  renderTabs();
  const token = ++switches;
  if (!checkedSpaces.has(id)) {
    checking = id;
    const roots = await resolveTabs(tabs.list);
    if (token !== switches) return; // another space was chosen meanwhile
    checking = null;
    checkedSpaces.add(id);
    tabs.list = [...new Set(tabs.list.map(p => (roots.has(p) ? roots.get(p) : p)).filter(Boolean))];
    if (activeKey()) return renderTabs(); // a tab was opened meanwhile
  }
  // (on a phone a space opens at its pinned page: its tabs are where it has been, not what to show)
  if (tabs.list.includes(saved.active) && !isMobile()) await activateTab(saved.active);
  else showHome();
}

const currentProject = () => P.getProject(tabs.space);

// The rail: home, then the projects (drag to reorder), then the button that creates one, and the
// account at the bottom.
function renderRail() {
  const projects = P.listProjects();
  const canCreate = desktop || currentUser();
  $('#rail').innerHTML = `<button class="rail-item home ${tabs.space === 'home' ? 'active' : ''}" data-space="home" title="Home  (Alt+1)">${icon('home')}</button>
    ${projects.length ? '<div class="rail-sep"></div>' : ''}
    ${projects.map((p, i) => `<button class="rail-item proj ${p.id === tabs.space ? 'active' : ''}" data-space="${esc(p.id)}" style="--pc: ${p.color}"
      title="${esc(p.name)}${i < 8 ? `  (Alt+${i + 2})` : ''}" draggable="true">${esc(P.initials(p.name))}</button>`).join('')}
    ${canCreate ? `<button class="rail-add" title="New project">${icon('plus')}</button>` : ''}
    ${configured ? accountButton() : ''}`;
}

// =====================================================================
// Account
// =====================================================================

const SYNC = {
  syncing: 'Saving to your account…',
  synced: 'Your projects are saved in your account',
  offline: 'Offline — changes are saved when the connection is back',
};

function accountButton() {
  const u = currentUser(), sync = syncStatus();
  if (!u) return `<button class="rail-account" title="Sign in to keep your projects in your account">${icon('cloud')}</button>`;
  const pic = userAvatar(u);
  return `<button class="rail-account in" title="${esc(`${userName(u)}${u.email && u.email !== userName(u) ? `\n${u.email}` : ''}\n${SYNC[sync] || ''}`)}">
    ${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="ra-initial">${esc([...userName(u)][0]?.toUpperCase() || '?')}</span>
    <span class="sync-dot ${sync || ''}"></span></button>`;
}

// Projects of this computer (kept for when signed out) that the account doesn't have.
const localOnly = () => P.localProjects().filter(p => !P.hasProject(p.id));

async function accountMenu(x, y) {
  const u = currentUser();
  const note = label => ({ label, disabled: true, run: () => {} });
  const local = desktop && u ? localOnly() : [];
  const localNotes = desktop && u ? await S.localOnlyNotes().catch(() => []) : [];
  const files = [
    { label: u ? 'Export the projects of the account…' : 'Export projects…', run: () => exportProjects(P.allProjects()) },
    ...(desktop && u && P.localProjects().length ? [{ label: 'Export the projects of this computer…', run: () => exportProjects(P.localProjects()) }] : []),
    { label: u ? 'Import projects to the account from a file…' : 'Import projects from a file…', run: importProjectsFile },
  ];
  showMenu(x, y, u ? [
    note(`Signed in as ${u.email || userName(u)}`),
    note(SYNC[syncStatus()] || ''),
    '-',
    ...(local.length ? [{ label: `Copy ${plural(local.length, 'project')} of this computer to the account…`, run: copyLocalProjects }] : []),
    ...(localNotes.length ? [{ label: `Copy ${plural(localNotes.length, 'note')} of this computer to the account…`, run: () => copyLocalNotes(localNotes) }] : []),
    ...files,
    '-',
    { label: 'Sign out', run: () => signOut().catch(e => toast('Could not sign out', 'error', String(e.message || e))) },
  ] : [
    { label: 'Sign in with Google…', run: startSignIn },
    note(desktop ? 'Your projects in your account, also on the web' : 'Your projects, on the web and in the desktop app'),
    '-',
    ...files,
  ]);
}

// The projects of this computer are copied to the account (they also stay here, for when signed out).
async function copyLocalProjects() {
  const local = localOnly();
  if (!local.length) return;
  const names = local.map(p => `• ${p.name}`).join('\n');
  if (!(await confirmBox('Copy to the account', `Copy these projects of this computer to your account?\n\n${names}\n\nThey stay on this computer too.`, 'Copy', false))) return;
  added(P.importProjects(local), local.length);
}

// The notes of this computer are copied to the account, with their text and images (they also stay
// here, for when signed out).
async function copyLocalNotes(local) {
  const missing = new Set(local.map(n => n.space).filter(s => s !== 'home' && !P.getProject(s)));
  const warn = missing.size ? `\n\nSome of them belong to ${plural(missing.size, 'project')} not in the account yet: copy the projects first, or those notes won't show.` : '';
  if (!(await confirmBox('Copy to the account', `Copy ${plural(local.length, 'note')} of this computer (pages and databases, with their text and images) to your account?${warn}\n\nThey stay on this computer too.`, 'Copy', false))) return;
  const progress = document.createElement('div');
  progress.className = 'import-progress';
  progress.innerHTML = '<span class="spinner"></span><span>Copying the notes…</span>';
  document.body.append(progress);
  try {
    const n = await S.copyLocalNotes((done, total) => (progress.lastElementChild.textContent = `Copying the notes… ${done} of ${total}`));
    toast(`Copied ${plural(n, 'note')} to your account`, 'ok');
  } catch (e) {
    toast('Could not copy the notes', 'error', String(e.message || e));
  } finally {
    progress.remove();
  }
}

function added(n, total) {
  const skipped = total - n;
  if (n) toast(`Added ${plural(n, 'project')}`, 'ok', skipped ? `${plural(skipped, 'project was', 'projects were')} already there` : '');
  else toast(total ? 'These projects are already there' : 'There are no projects in this file');
  projectsChanged();
}

// A file with the projects (their folders, links and dashboards), to import in the account or elsewhere.
async function exportProjects(list) {
  const data = JSON.stringify(P.projectsFile(list), null, 2);
  const name = `roru-projects-${new Date().toISOString().slice(0, 10)}.json`;
  if (!desktop) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: name });
    a.click();
    return setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  try {
    const path = await tauri.dialog.save({ title: 'Export projects', defaultPath: name, filters: [{ name: 'Roru Dashboard projects', extensions: ['json'] }] });
    if (!path) return;
    await invoke('write_text', { path, content: data });
    toast(`Exported ${plural(list.length, 'project')}`, 'ok', path);
  } catch (e) {
    toast('Could not export the projects', 'error', String(e.message || e));
  }
}

async function importProjectsFile() {
  let text;
  try {
    if (desktop) {
      const path = await tauri.dialog.open({ title: 'Import projects', multiple: false, directory: false, filters: [{ name: 'Roru Dashboard projects', extensions: ['json'] }] });
      if (!path) return;
      text = new TextDecoder().decode(await invoke('read_bytes', { path }));
    } else {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
      const file = await new Promise(done => { input.onchange = () => done(input.files[0]); input.click(); });
      if (!file) return;
      text = await file.text();
    }
  } catch (e) {
    return toast('Could not read the file', 'error', String(e.message || e));
  }
  const list = P.readProjectsFile(text);
  if (!list) return toast('This is not a file of exported projects', 'error');
  added(P.importProjects(list), list.length);
}

async function startSignIn() {
  if (desktop) toast('Continue the sign-in in your browser');
  try {
    await signIn();
  } catch (e) {
    if (!/cancelled/i.test(e.message)) toast('Could not sign in', 'error', String(e.message || e));
  }
}

// The account button tells whether the changes are saved (only it is drawn again, not the rail).
function paintAccount() {
  const el = $('#rail .rail-account');
  if (el) el.outerHTML = accountButton();
}

// The web page is only for signed-in users: signed out, it only shows how to sign in.
const applyGate = () => document.documentElement.classList.toggle('signed-out', !desktop && !currentUser());

// Signed in or out: the projects shown are the account's, or the ones kept on this device (which
// signing in never changes: they can be copied to the account from the account menu).
async function accountChanged(user) {
  applyGate();
  P.useAccount(user);
  if (user) {
    toast(`Signed in as ${user.email || userName(user)}`, 'ok',
      desktop ? 'The projects and notes of this computer stay here: to copy them to your account, open the account menu (bottom left).' : '');
  }
  closePeek();
  await S.useAccount(user);
  // a note open in a tab is shown again from where the notes are now (or the pinned tab, if it isn't there)
  if (state.note) showPage(S.getNote(state.note) ? state.note : null);
  else renderTabs();
}

// The projects changed elsewhere (or the account did): the ones deleted take their notes to Home,
// like when deleting them here, and the current space goes home if its project is gone.
async function projectsChangedElsewhere({ removed }) {
  for (const id of removed) {
    // (its notes were moved to Home by the device that deleted it)
    if (id !== tabs.space && tabs.spaces[id]) { forgetTabs(tabs.spaces[id].list); delete tabs.spaces[id]; }
  }
  if (tabs.space !== 'home' && !currentProject()) {
    const id = tabs.space;
    await switchSpace('home');
    if (removed.includes(id)) delete tabs.spaces[id];
    saveTabs();
  }
  projectsChanged();
}

function bindRail() {
  const rail = $('#rail');
  rail.addEventListener('click', e => {
    const item = e.target.closest('.rail-item');
    if (item) return switchSpace(item.dataset.space);
    if (e.target.closest('.rail-add')) return newProject();
    const acct = e.target.closest('.rail-account');
    if (acct) {
      const r = acct.getBoundingClientRect();
      accountMenu(r.right + 6, r.top);
    }
  });
  rail.addEventListener('contextmenu', e => {
    const item = e.target.closest('.rail-item.proj');
    if (!item) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, projectMenuItems(P.getProject(item.dataset.space)));
  });

  // Drag projects to reorder them
  let dragged = null;
  const clearMarks = () => rail.querySelectorAll('.drop-before, .drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
  rail.addEventListener('dragstart', e => {
    const item = e.target.closest('.rail-item.proj');
    if (!item) return;
    dragged = item.dataset.space;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged);
  });
  rail.addEventListener('dragover', e => {
    const item = e.target.closest('.rail-item.proj');
    if (!dragged || !item || item.dataset.space === dragged) return;
    e.preventDefault();
    clearMarks();
    const r = item.getBoundingClientRect();
    item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  rail.addEventListener('drop', e => {
    const item = e.target.closest('.rail-item.proj');
    if (!dragged || !item) return;
    e.preventDefault();
    const moving = dragged;
    dragged = null; // the rail is drawn again, so "dragend" won't reach it
    P.moveProject(moving, item.dataset.space, item.classList.contains('drop-after'));
    renderRail();
  });
  rail.addEventListener('dragend', () => { dragged = null; clearMarks(); rail.querySelector('.dragging')?.classList.remove('dragging'); });
}

function projectMenuItems(p) {
  return [
    { label: 'Open dashboard', run: () => (tabs.space === p.id ? showHome() : switchSpace(p.id)) },
    '-',
    ...(desktop ? addMenuItems(p.id) : []),
    { label: 'Rename…', run: () => renameProject(p.id) },
    '-',
    { label: 'Archive project', run: () => archiveProject(p.id) },
    { label: 'Delete project…', danger: true, run: () => deleteProject(p.id) },
  ];
}

// An archived project leaves the rail with everything it has (folders, links, notes, its tabs), until
// it is restored from the start page.
async function archiveProject(id) {
  const p = P.getProject(id);
  if (!p) return;
  if (tabs.space === id) {
    captureUi();
    tabs.spaces[id] = { list: tabs.list, active: activeKey(), seen: tabs.seen };
  }
  P.archiveProject(id);
  if (tabs.space === id) await switchSpace('home');
  saveTabs();
  projectsChanged();
  toast(`Archived “${p.name}”`, 'ok', 'Its folders, links, notes and tabs are kept. Restore it from the start page (Home), under Archived projects.');
}

function restoreProject(id) {
  const p = P.archivedProjects().find(x => x.id === id);
  if (!p) return;
  P.restoreProject(id);
  projectsChanged();
  toast(`Restored “${p.name}”`, 'ok');
}

// The rail, the toolbar and the pinned tab show the projects: repaint them after a change.
function projectsChanged() {
  renderRail();
  renderTabs();
  renderToolbar();
  if (activeKey()) return;
  if (currentProject()) updateDashboard();
  else renderWelcome();
}

async function newProject() {
  const r = await modal({
    title: 'New project', ok: 'Create project', input: '', placeholder: 'Project name',
    message: 'A project groups folders (Git repositories or not) and has its own tabs, next to its dashboard.',
  });
  if (!r) return;
  switchSpace(P.createProject(r.value).id);
}

async function renameProject(id) {
  const p = P.getProject(id);
  const r = p && await modal({ title: 'Rename project', input: p.name, ok: 'Rename' });
  if (!r) return;
  P.renameProject(id, r.value);
  projectsChanged();
}

// The folders stay where they are and the notes move to Home: only the project and its tabs go away.
// (also an archived project, from the start page)
async function deleteProject(id) {
  const p = P.getProject(id) || P.archivedProjects().find(x => x.id === id);
  const folders = p?.folders.length === 1 ? 'Its folder stays' : `Its ${p?.folders.length} folders stay`;
  const n = S.notesOf(id).length;
  const notes = !n ? '' : n === 1 ? ' Its note moves to Home.' : ` Its ${n} notes move to Home.`;
  if (!p || !(await confirmBox('Delete project', `Delete the project "${p.name}"?\n\n${folders} on disk: only the project and its tabs are removed.${notes}`, 'Delete project'))) return;
  const closing = tabs.space === id ? tabs.list : tabs.spaces[id]?.list || [];
  P.deleteProject(id);
  if (S.notesMode()) S.moveSpace(id, 'home');
  delete tabs.spaces[id];
  if (tabs.space === id) await switchSpace('home');
  forgetTabs(closing);
  saveTabs();
  projectsChanged();
}

// "Add to project" items for a folder: the current project, or (from home) every project.
function addToProjectItems(path) {
  const project = currentProject();
  return (project ? [project] : P.listProjects())
    .filter(p => !P.hasFolder(p, path))
    .map(p => ({
      label: `Add to project “${p.name}”`,
      run: () => {
        P.addFolders(p.id, [path]);
        toast(`Added ${folderName(path)} to “${p.name}”`, 'ok');
        projectsChanged();
      },
    }));
}

// Alt+1 is home, Alt+2… the projects in the order of the rail.
function switchToNth(n) {
  const id = n === 0 ? 'home' : P.listProjects()[n - 1]?.id;
  if (id) switchSpace(id);
}

// Refreshes are serialized; calls made while one is running are merged into a
// single follow-up refresh (so they never return stale data).
let refreshChain = Promise.resolve();
let refreshQueued = null;
function refresh() {
  if (refreshQueued) return refreshQueued;
  refreshQueued = refreshChain.then(() => { refreshQueued = null; return doRefresh(); });
  refreshChain = refreshQueued.catch(() => {});
  return refreshQueued;
}

async function doRefresh({ full = true } = {}) {
  if (!state.repo) {
    if (!state.note && currentProject()) reloadDashboard(); // not awaited: it reads every folder of the project
    return;
  }
  if (state.plain) {
    renderToolbar();
    renderOpBanner();
    return renderMain();
  }
  const spin = addPending({ text: 'Refreshing', on: [at.action('refresh')], quiet: true, delay: 300 });
  try {
    const repo = state.repo;
    const [status, refs, stashes, log, op, submodules, lfs] = await Promise.all([
      G.getStatus(repo), G.getRefs(repo), G.getStashes(repo), full ? G.getLog(repo) : Promise.resolve(null),
      G.getOperation(repo).catch(() => null), G.getSubmodules(repo).catch(() => []), G.getLfs(repo).catch(() => null),
    ]);
    const mergeTool = status.conflicts.length ? await G.getMergeTool(repo) : null;
    if (repo !== state.repo) return;
    state.status = status; state.refs = refs; state.stashes = stashes; state.op = op; state.mergeTool = mergeTool;
    state.submodules = submodules; state.lfs = lfs;
    syncMergeMessage();
    if (log) {
      const prevSha = state.selected != null ? state.log[state.selected]?.sha : null;
      const changed = log.length !== state.log.length || log.some((c, i) => c.sha !== state.log[i]?.sha || c.refs.join() !== state.log[i]?.refs.join());
      if (changed) {
        state.log = log;
        state.graph = computeGraph(log);
        const idx = prevSha ? log.findIndex(c => c.sha === prevSha) : -1;
        state.selected = idx >= 0 ? idx : null;
        state.logDirty = true;
      }
    }
    renderToolbar();
    renderOpBanner();
    renderSidebar();
    renderMain();
  } catch (e) {
    toast('Failed to read the repository', 'error', e.message);
  } finally {
    removePending(spin);
  }
}

// =====================================================================
// Toolbar / statusbar
// =====================================================================

function renderToolbar() {
  const s = state.status, project = currentProject();
  const name = state.repo ? folderName(state.repo) : project ? project.name : state.note || !desktop ? 'Home' : 'Open repository';
  $('#repo-name').textContent = name;
  $('#repo-branch').textContent = state.plain ? 'Folder — not a Git repository' : state.note ? 'Note'
    : !state.repo ? (project ? 'Project dashboard' : '') : !s ? '' : s.detached ? 'Detached HEAD' : s.branch || '';
  const title = [state.repo && name, state.note && noteTitle(state.note), project?.name, 'Roru Dashboard'].filter(Boolean).join(' — ');
  if (desktop) tauri.window?.getCurrentWindow().setTitle(title).catch(() => {});
  else document.title = title;

  const setCount = (action, n) => {
    const b = $(`[data-action="${action}"]`);
    b.querySelector('.count')?.remove();
    if (n > 0) b.insertAdjacentHTML('beforeend', `<span class="count">${n}</span>`);
  };
  setCount('pull', s?.behind || 0);
  setCount('push', s?.ahead || 0);
  setCount('pop', state.repo ? state.stashes.length : 0);

  const left = [];
  if (state.plain) left.push(`<span>${esc(state.repo)}</span>`);
  else if (state.repo && s) {
    left.push(`<span>${esc(state.repo)}</span>`);
    if (s.upstream) left.push(`<span>↑${s.ahead} ↓${s.behind} ${esc(s.upstream)}</span>`);
    else if (s.branch && !s.detached) left.push('<span>no upstream</span>');
  }
  $('#sb-left').innerHTML = left.join('');
}

// =====================================================================
// Operation in progress (merge, rebase, cherry-pick, revert)
// =====================================================================

const changeCount = s => s.staged.length + s.unstaged.length + s.conflicts.length;

function setCommitMsg(value) {
  state.commitMsg = value;
  const box = $('#commit-msg');
  if (box) box.value = value;
}

// While merging, the commit box starts with the message git prepared for the merge commit
// (unless it already had a draft), and that message goes away if the merge is aborted.
function syncMergeMessage() {
  const op = state.op;
  if (op?.kind === 'merge') {
    if (state.mergeMsg != null) return;
    state.mergeMsg = op.message;
    if (!state.commitMsg.trim()) setCommitMsg(op.message);
  } else if (state.mergeMsg != null) {
    if (state.mergeMsg && state.commitMsg === state.mergeMsg) setCommitMsg('');
    state.mergeMsg = null;
  }
}

// A readable name for a commit: a branch (local first) or tag pointing at it, or its short SHA.
function refName(sha) {
  if (!sha) return '';
  const r = state.refs;
  return r?.local.find(b => b.sha === sha)?.name
    || Object.values(r?.remotes || {}).flat().find(b => b.sha === sha)?.full
    || r?.tags.find(t => t.sha === sha)?.name
    || sha.slice(0, 7);
}

// What is being merged, from the message git prepared ("Merge branch 'feature'").
function mergeName(op) {
  return op.message.match(/^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/)?.[1] || refName(op.sha);
}

// Names of the two sides of the conflicts. In a rebase the current side is the branch being
// rebased onto and the incoming side is the commit being replayed.
function sideNames() {
  const op = state.op, s = state.status;
  const branch = (!s.detached && s.branch) || 'HEAD';
  if (op?.kind === 'merge') return { ours: branch, theirs: mergeName(op) };
  if (op?.kind === 'rebase') return { ours: op.onto ? refName(op.onto) : 'HEAD', theirs: op.sha ? op.sha.slice(0, 7) : op.branch };
  if (op) return { ours: branch, theirs: op.sha.slice(0, 7) };
  return { ours: null, theirs: null };
}

function renderOpBanner() {
  const el = $('#op-banner'), op = state.repo && state.op;
  el.hidden = !op;
  if (!op) { el.innerHTML = ''; return; }
  const s = state.status, n = s.conflicts.length;
  const b = text => `<b>${esc(text)}</b>`;
  const commit = op.sha ? `<span class="mono">${op.sha.slice(0, 7)}</span> ${esc(op.subject || '')}` : '';
  const text = {
    merge: () => `Merging ${b(mergeName(op))} into ${b(s.branch || 'HEAD')}`,
    rebase: () => `Rebasing ${b(op.branch)}${op.onto ? ` onto ${b(refName(op.onto))}` : ''}`
      + `${op.total ? ` <span class="op-step">commit ${op.step} of ${op.total}</span>` : ''}${commit ? ` · ${commit}` : ''}`,
    'cherry-pick': () => `Cherry-picking ${commit}`,
    revert: () => `Reverting ${commit}`,
  }[op.kind]();
  const status = n
    ? `<button class="op-status bad" data-op="show" title="Show the conflicted files">${icon('alert')}${plural(n, 'conflict')} to resolve</button>`
    : `<span class="op-status ok">${icon('check')}${op.kind === 'merge' ? 'Ready to commit' : 'Ready to continue'}</span>`;
  const next = op.kind === 'merge' ? 'Commit merge' : `Continue ${op.kind}`;
  el.innerHTML = `${icon('merge')}<span class="op-text">${text}</span>${status}<span class="spacer"></span>
    <button class="btn" data-op="abort" title="Stop the ${op.kind} and go back to how things were before it started">Abort ${op.kind}</button>
    ${op.kind === 'rebase' ? '<button class="btn" data-op="skip" title="Leave this commit out and go on with the next one">Skip commit</button>' : ''}
    <button class="btn primary" data-op="continue" ${n ? 'disabled title="Resolve every conflict first"' : ''}>${next}</button>`;
}

async function abortOp() {
  const op = state.op;
  if (!op) return;
  const ok = await confirmBox(`Abort ${op.kind}`,
    `Stop the ${op.kind} and go back to how things were before it started? Conflict resolutions and other changes made since it started are lost.`,
    `Abort ${op.kind}`);
  if (ok) run(`Abort ${op.kind}`, () => g([op.kind, '--abort']), { success: `${cap(op.kind)} aborted`, busy: 'Aborting', on: [at.op(), at.current()] });
}

async function skipOp() {
  const op = state.op;
  if (op?.kind !== 'rebase') return;
  const what = op.sha ? `commit ${op.sha.slice(0, 7)} "${op.subject}"` : 'the current commit';
  if (!(await confirmBox('Skip commit', `Skip ${what}? Its changes are left out of the rebased branch.`, 'Skip commit'))) return;
  const ok = await run('Skip commit', async () => { await g(['rebase', '--skip']); return true; }, { busy: 'Skipping', on: [at.op()], mayConflict: true });
  if (ok && !state.op) toast('Rebase complete', 'ok');
}

// Merges are concluded with a commit from the commit box; the other operations keep the
// message of the commit they are replaying.
async function continueOp() {
  const op = state.op;
  if (!op) return;
  if (op.kind === 'merge') return commit();
  if (state.status.conflicts.length) return toast('Resolve every conflict first', 'error');
  const ok = await run(`Continue ${op.kind}`, async () => { await g([op.kind, '--continue']); return true; },
    { busy: 'Continuing', on: [at.op(), at.current()], mayConflict: true });
  if (ok && !state.op) toast(`${cap(op.kind)} complete`, 'ok');
}

const cap = s => s[0].toUpperCase() + s.slice(1);

$('#op-banner').addEventListener('click', e => {
  const b = e.target.closest('[data-op]');
  if (!b || b.disabled) return;
  if (b.dataset.op === 'show') return setView('changes');
  ({ abort: abortOp, skip: skipOp, continue: continueOp })[b.dataset.op]();
});

// =====================================================================
// Sidebar
// =====================================================================

// `actions` are [{ act, icon, title }] buttons shown on the group head (see groupAction).
function group(id, title, count, body, forceOpen = false, actions = []) {
  const collapsed = !forceOpen && state.collapsed[id];
  const acts = actions.map(a => `<button class="gh-act" data-gh-act="${a.act}" title="${esc(a.title)}">${icon(a.icon)}</button>`).join('');
  return `<div class="group-head ${collapsed ? 'collapsed' : ''}" data-group="${id}">${icon('chevron')}${esc(title)}<span class="n">${count}</span>${acts ? `<span class="gh-acts">${acts}</span>` : ''}</div>
    <div class="group-body">${body}</div>`;
}

// Why a submodule needs attention, as [css class, label, tooltip], or null.
function submoduleState(sub) {
  const inside = state.status.unstaged.find(f => f.path === sub.path)?.submodule;
  if (sub.state === 'uninitialized') return ['muted', 'not cloned', 'Not checked out yet — update it to clone it'];
  if (sub.state === 'conflict') return ['bad', 'conflict', 'Its recorded commit is in conflict'];
  if (sub.state === 'changed') return ['warn', 'changed', 'The checked-out commit is not the one recorded in this repository'];
  if (inside?.modified || inside?.untracked) return ['warn', 'modified', 'It has uncommitted changes'];
  return null;
}

function renderSubmodulesGroup() {
  const subs = state.submodules;
  const items = subs.map(sub => {
    const st = submoduleState(sub);
    const tip = [sub.path, sub.url, sub.describe && `at ${sub.describe}`, st?.[2]].filter(Boolean).join('\n');
    return `<div class="tree-item" data-submodule="${esc(sub.path)}" title="${esc(tip)}">${icon('submodule')}<span class="label">${esc(sub.path)}</span>
      ${st ? `<span class="track"><span class="${st[0]}">${esc(st[1])}</span></span>` : ''}</div>`;
  }).join('') || '<div class="empty-hint">No submodules</div>';
  const actions = [
    ...(subs.length ? [{ act: 'update-submodules', icon: 'refresh', title: 'Update all submodules to their recorded commits' }] : []),
    { act: 'add-submodule', icon: 'plus', title: 'Add submodule…' },
  ];
  return group('submodules', 'Submodules', subs.length, items, false, actions);
}

// Shown only in repositories that use LFS (files are tracked with it from the file menus).
function renderLfsGroup() {
  const lfs = state.lfs;
  if (!lfs?.patterns.length) return '';
  const items = [
    !lfs.installed && '<div class="empty-hint warn">Git LFS is not installed — LFS files stay as pointers</div>',
    lfs.missing && `<div class="tree-item lfs-missing" data-lfs-pull title="Their content was never downloaded: pull it with Git LFS">${icon('fetch')}<span class="label">${plural(lfs.missing, 'file')} not downloaded</span></div>`,
    ...lfs.patterns.map(p => `<div class="tree-item" data-lfs-pattern="${esc(p)}" title="Files matching ${esc(p)} are stored with Git LFS">${icon('lfs')}<span class="label">${esc(p)}</span></div>`),
  ].filter(Boolean).join('');
  const actions = lfs.installed ? [
    { act: 'lfs-pull', icon: 'pull', title: 'Download the LFS files of this checkout (git lfs pull)' },
    { act: 'lfs-track', icon: 'plus', title: 'Track files with Git LFS…' },
  ] : [];
  return group('lfs', 'Git LFS', lfs.patterns.length, items, false, actions);
}

const indent = (base, depth) => `padding-left: ${base + depth * 14}px`;

// Branches as a flat list, or nested in folders by '/' when branch grouping is on.
// Folders can be collapsed; while the branch filter is active they are all open.
function branchList(branches, nameOf, scope, base, item) {
  if (!state.branchTree) return branches.map(b => item(b, 0)).join('');
  return renderTree(pathTree(branches, nameOf), {
    item,
    dir: (name, path, depth, children) => {
      const key = `bt:${scope}:${path}`;
      const collapsed = !state.branchFilter && state.collapsed[key];
      return `<div class="tree-item folder-row ${collapsed ? 'collapsed' : ''}" data-toggle="${esc(key)}" style="${indent(base - 14, depth)}" title="${esc(path)}">
        ${icon('chevron')}${icon('folder')}<span class="label">${esc(name)}</span></div>${collapsed ? '' : children()}`;
    },
  });
}

function renderSidebar() {
  const s = state.status, r = state.refs;
  if (!s || !r) return;
  const nChanges = changeCount(s);
  const countTip = s.conflicts.length ? ` title="${plural(s.conflicts.length, 'conflict')}"` : '';
  let html = `
    <div class="nav-item ${state.view === 'changes' ? 'active' : ''}" data-nav="changes">${icon('changes')}Local changes${nChanges ? `<span class="count ${s.conflicts.length ? 'bad' : ''}"${countTip}>${nChanges}</span>` : ''}</div>
    <div class="nav-item ${state.view === 'history' ? 'active' : ''}" data-nav="history">${icon('history')}All commits</div>`;

  // The branch filter narrows local and remote branches and expands their groups.
  const bf = state.branchFilter;
  const localMatches = r.local.filter(b => matches(b.name, bf));
  const localItem = (b, depth) => {
    const track = b.gone ? '<span class="muted">gone</span>'
      : `${b.ahead ? `<span class="up">↑${b.ahead}</span>` : ''}${b.behind ? `<span class="dn">↓${b.behind}</span>` : ''}`;
    const label = state.branchTree ? b.name.slice(b.name.lastIndexOf('/') + 1) : b.name;
    return `<div class="tree-item ${b.current ? 'current' : ''}" data-branch="${esc(b.name)}" style="${indent(22, depth)}" title="${esc(b.name)}${b.upstream ? ' → ' + esc(b.upstream) : ''}">
      ${icon(b.current ? 'check' : 'branch')}<span class="label">${esc(label)}</span><span class="track">${track}</span></div>`;
  };
  const locals = branchList(localMatches, b => b.name, 'local', 22, localItem)
    || `<div class="empty-hint">${bf ? 'No matching branches' : 'No branches'}</div>`;
  const treeAct = { act: 'branch-tree', icon: state.branchTree ? 'list' : 'folder', title: state.branchTree ? 'Show branches as a flat list' : 'Group branches into folders by /' };
  html += group('branches', 'Branches', bf ? `${localMatches.length} of ${r.local.length}` : r.local.length, locals, !!bf, [treeAct]);

  let remoteMatches = 0;
  const remoteHtml = r.remoteNames.map(rm => {
    const key = 'remote:' + rm;
    const branches = (r.remotes[rm] || []).filter(b => matches(b.full, bf));
    remoteMatches += branches.length;
    if (bf && !branches.length) return '';
    const collapsed = !bf && state.collapsed[key];
    const items = branchList(branches, b => b.name, key, 36, (b, depth) =>
      `<div class="tree-item sub" data-remote-branch="${esc(b.full)}" style="${indent(36, depth)}" title="${esc(b.full)}">${icon('branch')}<span class="label">${esc(state.branchTree ? b.name.slice(b.name.lastIndexOf('/') + 1) : b.name)}</span></div>`);
    return `<div class="tree-item remote-head ${collapsed ? 'collapsed' : ''}" data-toggle="${esc(key)}" data-remote="${esc(rm)}">${icon('cloud')}<span class="label">${esc(rm)}</span></div>
      ${collapsed ? '' : items}`;
  }).join('') || `<div class="empty-hint">${bf && r.remoteNames.length ? 'No matching remote branches' : 'No remotes'}</div>`;
  html += group('remotes', 'Remotes', bf ? remoteMatches : r.remoteNames.length, remoteHtml, !!bf);

  const tags = r.tags.map(t => `<div class="tree-item" data-tag="${esc(t.name)}" title="${esc(t.name)}">${icon('tag')}<span class="label">${esc(t.name)}</span></div>`).join('')
    || '<div class="empty-hint">No tags</div>';
  const tagRemote = mainRemote();
  html += group('tags', 'Tags', r.tags.length, tags, false,
    tagRemote && r.tags.length ? [{ act: 'push-tags', icon: 'push', title: `Push all tags to "${tagRemote}"` }] : []);

  const stashes = state.stashes.map(st => `<div class="tree-item" data-stash="${esc(st.ref)}" title="${esc(st.subject)}">${icon('stash')}<span class="label">${esc(st.subject)}</span></div>`).join('')
    || '<div class="empty-hint">No stashes</div>';
  html += group('stashes', 'Stashes', state.stashes.length, stashes);
  html += renderSubmodulesGroup();
  html += renderLfsGroup();

  const sb = $('#sidebar');
  const scroll = sb.scrollTop;
  $('#sidebar-body').innerHTML = html;
  sb.scrollTop = scroll;
  paintBusy();
}

{
  const input = $('#branch-filter');
  const apply = value => { input.value = value; state.branchFilter = value.trim(); renderSidebar(); };
  input.addEventListener('input', () => apply(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); apply(''); input.blur(); }
    // Enter reveals the first matching branch in the history
    else if (e.key === 'Enter') $('#sidebar-body [data-branch], #sidebar-body [data-remote-branch]')?.click();
  });
}

$('#sidebar').addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) return setView(nav.dataset.nav);
  const act = e.target.closest('[data-gh-act]');
  if (act) return groupAction(act.dataset.ghAct);
  const gh = e.target.closest('[data-group]');
  if (gh) return toggleCollapsed(gh.dataset.group);
  const tg = e.target.closest('[data-toggle]');
  if (tg) return toggleCollapsed(tg.dataset.toggle);
  if (e.target.closest('[data-lfs-pull]')) return groupAction('lfs-pull');
  const item = e.target.closest('[data-branch],[data-remote-branch],[data-tag]');
  if (!item) return;
  const ref = item.dataset.branch ? `refs/heads/${item.dataset.branch}`
    : item.dataset.remoteBranch ? `refs/remotes/${item.dataset.remoteBranch}`
    : `refs/tags/${item.dataset.tag}`;
  revealRef(ref);
});

$('#sidebar').addEventListener('dblclick', e => {
  const b = e.target.closest('[data-branch]');
  if (b) return checkout(b.dataset.branch);
  const rb = e.target.closest('[data-remote-branch]');
  if (rb) return checkoutRemote(rb.dataset.remoteBranch);
  const sm = e.target.closest('[data-submodule]');
  if (sm) return openSubmodule(sm.dataset.submodule);
});

$('#sidebar').addEventListener('contextmenu', e => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const b = e.target.closest('[data-branch]');
  const rb = e.target.closest('[data-remote-branch]');
  const t = e.target.closest('[data-tag]');
  const st = e.target.closest('[data-stash]');
  const rm = e.target.closest('[data-remote]');
  const sm = e.target.closest('[data-submodule]');
  const lp = e.target.closest('[data-lfs-pattern]');
  const gh = e.target.closest('[data-group]');
  if (sm) return submoduleMenu(e.clientX, e.clientY, state.submodules.find(s => s.path === sm.dataset.submodule));
  if (lp) {
    const p = lp.dataset.lfsPattern;
    return showMenu(e.clientX, e.clientY, [
      { label: `Stop tracking "${p}" with LFS`, disabled: !state.lfs.installed, run: () => untrackLfs(p) },
      { label: 'Copy pattern', run: () => copy(p) },
      '-', ...lfsMenuItems(),
    ]);
  }
  if (gh?.dataset.group === 'submodules') return showMenu(e.clientX, e.clientY, submodulesMenuItems());
  if (gh?.dataset.group === 'lfs') return showMenu(e.clientX, e.clientY, lfsMenuItems());
  if (gh?.dataset.group === 'tags') return showMenu(e.clientX, e.clientY, tagsMenuItems());
  if (b) showMenu(e.clientX, e.clientY, branchMenuItems(b.dataset.branch));
  else if (rb) showMenu(e.clientX, e.clientY, remoteBranchMenuItems(rb.dataset.remoteBranch));
  else if (t) showMenu(e.clientX, e.clientY, tagMenuItems(t.dataset.tag));
  else if (st) {
    const ref = st.dataset.stash;
    showMenu(e.clientX, e.clientY, [
      { label: 'Apply', run: () => run('Apply stash', () => g(['stash', 'apply', ref]), { busy: 'Applying', on: [at.stash(ref)], mayConflict: true }) },
      { label: 'Apply and drop (pop)', run: () => run('Pop', () => g(['stash', 'pop', ref]), { busy: 'Popping', on: [at.stash(ref)], mayConflict: true }) },
      '-',
      { label: 'Drop stash…', danger: true, run: async () => { if (await confirmBox('Drop stash', `Drop ${ref}? This cannot be undone.`)) run('Drop stash', () => g(['stash', 'drop', ref]), { busy: 'Dropping', on: [at.stash(ref)] }); } },
    ]);
  } else if (rm) {
    const name = rm.dataset.remote;
    showMenu(e.clientX, e.clientY, [
      { label: `Fetch "${name}"`, run: () => run('Fetch', () => g(['fetch', '--prune', name]), { busy: 'Fetching', on: [at.remote(name)] }) },
      { label: 'Copy URL', run: async () => copy((await g(['remote', 'get-url', name])).trim()) },
    ]);
  }
});

// Branch and tag menus, shared by the sidebar and the labels in the commit list.
function branchMenuItems(name) {
  const cur = state.status?.branch, isCur = name === cur && !state.status.detached;
  const info = state.refs.local.find(x => x.name === name);
  // Fast-forward only: a branch that also has its own commits must be merged or rebased instead.
  const ffItem = info?.upstream && info.behind && !info.gone ? [{
    label: info.ahead ? `Fast-forward to "${info.upstream}" (diverged)` : `Fast-forward to "${info.upstream}"`,
    disabled: !!info.ahead,
    run: () => run('Fast-forward', () => g(isCur ? ['merge', '--ff-only', info.upstream] : ['fetch', '.', `refs/remotes/${info.upstream}:refs/heads/${name}`]),
      { success: `"${name}" is up to date`, busy: 'Updating', on: [at.branch(name)] }),
  }, '-'] : [];
  return [
    ...ffItem,
    { label: `Checkout "${name}"`, disabled: isCur, run: () => checkout(name) },
    { label: `Merge "${name}" into "${cur}"`, disabled: isCur, run: () => mergeRef(name) },
    { label: `Rebase "${cur}" onto "${name}"`, disabled: isCur, run: () => rebaseOnto(name) },
    '-',
    { label: 'Rename…', run: () => renameBranch(name) },
    { label: 'Copy name', run: () => copy(name) },
    '-',
    { label: 'Delete branch…', danger: true, disabled: isCur, run: () => deleteBranch(name) },
  ];
}

const deleteRemoteBranchItem = full => ({ label: `Delete "${full}" from the remote…`, danger: true, run: () => deleteRemoteBranch(...splitRemote(full)) });

function remoteBranchMenuItems(full) {
  return [
    { label: `Checkout "${splitRemote(full)[1]}"`, run: () => checkoutRemote(full) },
    { label: `Merge "${full}" into "${state.status?.branch}"`, run: () => mergeRef(full) },
    { label: 'Copy name', run: () => copy(full) },
    '-',
    deleteRemoteBranchItem(full),
  ];
}

function tagMenuItems(name) {
  const remotes = state.refs.remoteNames;
  return [
    { label: `Checkout tag "${name}"`, run: () => run('Checkout', () => g(['checkout', name]), { busy: 'Checking out', on: [at.tag(name)] }) },
    ...remotes.map(rm => ({ label: `Push tag to "${rm}"`, run: () => pushTags(rm, name) })),
    { label: 'Copy name', run: () => copy(name) },
    '-',
    ...remotes.map(rm => ({ label: `Delete tag from "${rm}"…`, danger: true, run: () => deleteRemoteTag(name, rm) })),
    { label: 'Delete tag…', danger: true, run: () => deleteTag(name) },
  ];
}

function tagsMenuItems() {
  const remotes = state.refs.remoteNames;
  if (!remotes.length) return [{ label: 'Push all tags (no remote configured)', disabled: true }];
  return remotes.map(rm => ({ label: `Push all tags to "${rm}"`, disabled: !state.refs.tags.length, run: () => pushTags(rm) }));
}

function toggleCollapsed(id) {
  state.collapsed[id] = !state.collapsed[id];
  store('collapsed', state.collapsed);
  renderSidebar();
}

async function revealRef(ref) {
  try {
    const sha = (await g(['rev-parse', ref + '^{commit}'])).trim();
    const idx = state.log.findIndex(c => c.sha === sha);
    if (idx < 0) return toast('Commit is outside the loaded history');
    setView('history');
    selectCommit(idx, { scroll: true });
  } catch (e) {
    toast('Could not find the reference', 'error', e.message);
  }
}

// Shows a commit in the history (from the explorer), with `path` selected among its files.
function revealCommit(sha, path = null) {
  const idx = state.log.findIndex(c => c.sha === sha);
  if (idx < 0) return toast('Commit is outside the loaded history');
  state.selected = idx;
  state.commitFile = path ? { path } : null;
  setView('history');
}

// Shows a file's uncommitted changes in Local changes.
function revealChange(path) {
  if (state.plain || !state.status) return;
  setView('changes');
  const kind = ['conflicts', 'unstaged', 'staged'].find(k => state.status[k].some(f => f.path === path));
  if (!kind) return;
  setSelection(kind, [path]);
  rowFor(kind, path)?.scrollIntoView({ block: 'nearest' });
}

// =====================================================================
// Views
// =====================================================================

function setView(view) {
  if (state.plain) return;
  state.view = view;
  if (state.mode !== 'git') {
    state.mode = 'git';
    applyMode();
    saveSoon();
  }
  $('#main').innerHTML = '';
  state.logDirty = true;
  renderSidebar();
  renderMain();
}

function renderMain() {
  if (state.note) return mountNoteTab(state.note);
  if (!state.repo) return renderHome();
  if (state.mode === 'explorer') renderExplorer();
  else if (!state.status) return; // still loading
  else if (state.view === 'history') renderHistory();
  else renderChanges();
}

const LOGO = '<svg class="logo" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="var(--bg-3)"/><path d="M176 128v256M176 304c0-64 160-48 160-112" fill="none" stroke="#7aa2f7" stroke-width="36" stroke-linecap="round"/><circle cx="176" cy="128" r="40" fill="#9ece6a"/><circle cx="176" cy="384" r="40" fill="#9ece6a"/><circle cx="336" cy="176" r="40" fill="#f7768e"/></svg>';

// The web page needs the account: signed out, the start page only offers to sign in.
function renderSignIn() {
  $('#main').innerHTML = `<div class="welcome">${LOGO}
    <h1>Roru Dashboard</h1>
    ${configured ? `<p>Your projects, on the web and in the desktop app.</p>
      <div class="welcome-acts"><button class="btn primary" id="w-signin">Sign in with Google</button></div>`
    : '<p>The account is not set up yet.</p>'}
  </div>`;
  if (configured) $('#w-signin').onclick = startSignIn;
}

function renderWelcome() {
  if (!desktop && !currentUser()) return renderSignIn();
  if (isMobile()) {
    $('#main').innerHTML = '<div class="welcome-scroll"></div>';
    return M.renderHome($('#main > .welcome-scroll'));
  }
  const recent = desktop ? store('recent') || [] : [];
  const projects = P.listProjects(), archived = P.archivedProjects();
  // (the page scrolls when it is taller than the window, and the recent list in its own box)
  $('#main').innerHTML = `<div class="welcome-scroll"><div class="welcome">${LOGO}
    <h1>Roru Dashboard</h1>
    <p>${desktop ? 'Projects, notes and Git in one place.' : 'Your projects and notes. Git and the folders are in the desktop app.'}</p>
    <div class="welcome-acts">${desktop ? '<button class="btn primary" id="w-open">Open repository or folder…</button>' : ''}<button class="btn ${desktop ? '' : 'primary'}" id="w-project">New project…</button></div>
    <div class="welcome-notes"></div>
    ${projects.length ? `<div class="recent"><h4>Projects</h4>${projects.map(p => `<div class="recent-item proj-item" data-project="${esc(p.id)}">
      <span class="proj-badge" style="--pc: ${p.color}">${esc(P.initials(p.name))}</span><span class="proj-text"><b>${esc(p.name)}</b><span class="p">${plural(p.folders.length, 'folder')}</span></span></div>`).join('')}</div>` : ''}
    ${archived.length ? `<div class="recent archived"><h4>Archived projects</h4>${archived.map(p => `<div class="recent-item proj-item arch-item" data-archived="${esc(p.id)}">
      <span class="proj-badge" style="--pc: ${p.color}">${esc(P.initials(p.name))}</span><span class="proj-text"><b>${esc(p.name)}</b><span class="p">${plural(p.folders.length, 'folder')} · archived ${esc(fmtRelative(p.archived / 1000))}</span></span>
      <span class="spacer"></span><button class="btn-sm" data-arch="restore">Restore</button><button class="btn-sm" data-arch="delete">Delete…</button></div>`).join('')}</div>` : ''}
    ${recent.length ? `<div class="recent"><h4>Recent</h4><div class="recent-list">${recent.map(p => `<div class="recent-item" data-path="${esc(p)}"><b>${esc(folderName(p))}</b><span class="p">${esc(p)}</span></div>`).join('')}</div></div>` : ''}
  </div></div>`;
  if (desktop) $('#w-open').onclick = openRepoDialog;
  $('#w-project').onclick = newProject;
  renderNotesPanel($('.welcome-notes'), 'home');
  document.querySelectorAll('.arch-item').forEach(el => {
    const id = el.dataset.archived;
    el.onclick = e => {
      const act = e.target.closest('[data-arch]')?.dataset.arch;
      if (act === 'restore') restoreProject(id);
      else if (act === 'delete') deleteProject(id);
    };
    el.oncontextmenu = e => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [{ label: 'Restore', run: () => restoreProject(id) }, '-', { label: 'Delete project…', danger: true, run: () => deleteProject(id) }]);
    };
  });
  document.querySelectorAll('.proj-item[data-project]').forEach(el => {
    el.onclick = () => switchSpace(el.dataset.project);
    el.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, projectMenuItems(P.getProject(el.dataset.project))); };
  });
  document.querySelectorAll('.recent-item[data-path]').forEach(el => {
    el.onclick = () => openRecent(el.dataset.path);
    el.oncontextmenu = e => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [{ label: 'Remove from recent', run: () => { store('recent', recent.filter(p => p !== el.dataset.path)); renderWelcome(); } }]);
    };
  });
}

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------

function renderHistory() {
  let root = $('.history');
  if (!root) {
    $('#main').innerHTML = `<div class="history">
      <div class="commit-pane">
        <div class="list-head"><span class="h-graph">Description</span><span class="c-author">Author</span><span class="c-date">Date</span><span class="c-sha">Commit</span></div>
        <div class="commit-list" tabindex="0"></div>
      </div>
      <div class="splitter h" data-split="commits-h"></div>
      <div class="detail">
        <div class="detail-left"><div class="commit-meta"></div><div class="file-list" tabindex="0"></div></div>
        <div class="splitter v" data-split="detail-w"></div>
        <div class="diff-pane"><div class="placeholder">Select a commit</div></div>
      </div>
    </div>`;
    root = $('.history');
    bindSplitters(root);
    bindHistoryEvents(root);
    state.logDirty = true;
  }
  if (state.logDirty) {
    state.logDirty = false;
    renderCommitList();
    if (state.selected != null) selectCommit(state.selected, { scroll: true, force: true });
    else if (state.log.length) selectCommit(0, { force: true });
    else {
      $('.commit-meta').innerHTML = '';
      $('.history .diff-pane').innerHTML = '<div class="placeholder">This repository has no commits yet.</div>';
    }
  }
}

function headSha() {
  return state.refs?.local.find(b => b.current)?.sha
    || state.log.find(c => c.refs.some(r => r === 'HEAD' || r.startsWith('HEAD -> ')))?.sha;
}

// Branch labels for a commit: a local branch and its remote counterpart on the same commit share one
// label, with a house (local) and/or cloud (remote) icon. Labels take the color of the commit's lane.
function refBadges(c, color) {
  const remotes = state.refs?.remoteNames || [];
  const branches = new Map(); // short name -> { key, local, head, remote }
  const other = [];
  for (const r of c.refs) {
    if (r === 'HEAD') { other.push(`<span class="ref detached">HEAD</span>`); continue; }
    if (r.startsWith('tag: ')) { other.push(`<span class="ref tag" data-ref-tag="${esc(r.slice(5))}">${icon('tag')}${esc(r.slice(5))}</span>`); continue; }
    const head = r.startsWith('HEAD -> ');
    const name = head ? r.slice(8) : r;
    const rm = remotes.find(x => name.startsWith(x + '/'));
    if (rm && name.endsWith('/HEAD')) continue;
    const key = rm ? name.slice(rm.length + 1) : name;
    const b = branches.get(key) || { key };
    if (rm) b.remote ||= name;
    else { b.local = true; b.head = head; }
    branches.set(key, b);
  }
  const labels = [...branches.values()].map(b => {
    const icons = [b.head && 'check', b.local && 'home', b.remote && 'cloud'].filter(Boolean).map(n => `<span class="seg">${icon(n)}</span>`).join('');
    const title = [b.local && `Local: ${b.key}`, b.remote && `Remote: ${b.remote}`].filter(Boolean).join('\n');
    const data = (b.local ? ` data-ref-local="${esc(b.key)}"` : '') + (b.remote ? ` data-ref-remote="${esc(b.remote)}"` : '');
    return `<span class="ref branch${b.head ? ' head' : ''}" style="--ref: ${color}" title="${esc(title)}"${data}>${icons}${esc(b.local ? b.key : b.remote)}</span>`;
  });
  return labels.concat(other).join('');
}

// A label stands for a tag, or for a local branch and/or its remote counterpart: a shared label
// gets the local branch's menu plus deleting the remote one.
function badgeMenuItems({ refLocal, refRemote, refTag }) {
  if (refTag) return tagMenuItems(refTag);
  if (!refLocal) return remoteBranchMenuItems(refRemote);
  const items = branchMenuItems(refLocal);
  return refRemote ? [...items, deleteRemoteBranchItem(refRemote)] : items;
}

function renderCommitList() {
  const list = $('.commit-list');
  const maxCols = Math.min(12, Math.max(1, ...state.graph.map(r => r.width)));
  const head = headSha();
  const html = state.log.map((c, i) => {
    const isHead = c.sha === head;
    return `<div class="commit-row ${isHead ? 'is-head' : ''} ${i === state.selected ? 'selected' : ''}" data-i="${i}" data-sha="${c.sha}">
      ${graphSvg(state.graph[i], c, isHead, maxCols)}
      <div class="c-subject">${refBadges(c, laneColor(state.graph[i]?.col ?? 0))}${esc(c.subject)}</div>
      <div class="c-author" title="${esc(c.email)}">${esc(c.author)}</div>
      <div class="c-date" title="${esc(fmtDate(c.time))}">${esc(fmtRelative(c.time))}</div>
      <div class="c-sha">${c.sha.slice(0, 7)}</div>
    </div>`;
  }).join('');
  const top = list.scrollTop;
  list.innerHTML = html;
  list.scrollTop = top;
  $('.history .h-graph').style.minWidth = maxCols * LANE_W + 8 + 'px';
  paintBusy();
}

function bindHistoryEvents(root) {
  const list = $('.commit-list', root);
  list.addEventListener('mousedown', e => {
    const row = e.target.closest('.commit-row');
    if (row) selectCommit(+row.dataset.i);
  });
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('.commit-row');
    if (!row) return;
    const c = state.log[+row.dataset.i];
    const branch = c.refs.find(r => r.startsWith('HEAD -> ')) ? null
      : c.refs.find(r => !r.startsWith('tag: ') && r !== 'HEAD' && state.refs.local.some(b => b.name === r));
    if (branch) checkout(branch);
  });
  list.addEventListener('contextmenu', e => {
    e.preventDefault();
    const row = e.target.closest('.commit-row');
    if (!row) return;
    selectCommit(+row.dataset.i);
    const badge = e.target.closest('[data-ref-local], [data-ref-remote], [data-ref-tag]');
    if (badge) return showMenu(e.clientX, e.clientY, badgeMenuItems(badge.dataset));
    commitMenu(e.clientX, e.clientY, state.log[+row.dataset.i]);
  });
  list.addEventListener('keydown', e => {
    if (state.selected == null) return;
    const page = Math.max(1, Math.floor(list.clientHeight / 26) - 1);
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    selectCommit(Math.max(0, Math.min(state.log.length - 1, state.selected + moves[e.key])), { scroll: true });
  });

  const files = $('.file-list', root);
  files.addEventListener('mousedown', e => {
    const row = e.target.closest('.file-row');
    if (row) showCommitFile(+row.dataset.i);
  });
  files.addEventListener('keydown', e => {
    const cur = state.commitFiles.indexOf(state.commitFile);
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(state.commitFiles.length - 1, cur + d));
    showCommitFile(n);
    files.children[n]?.scrollIntoView({ block: 'nearest' });
  });
  files.addEventListener('contextmenu', e => {
    e.preventDefault();
    const row = e.target.closest('.file-row');
    if (!row) return;
    const f = state.commitFiles[+row.dataset.i];
    const sha = state.log[state.selected].sha;
    showMenu(e.clientX, e.clientY, [
      { label: 'Copy path', run: () => copy(f.path) },
      { label: 'Restore file from this version…', run: async () => {
        if (await confirmBox('Restore file', `Replace "${f.path}" in the working copy with the version from commit ${sha.slice(0, 7)}?`)) run('Restore', () => g(['checkout', sha, '--', f.path]), { busy: 'Restoring', on: [at.commit(sha)] });
      } },
    ]);
  });

  $('.commit-meta', root).addEventListener('click', e => {
    const p = e.target.closest('[data-goto]');
    if (!p) return;
    const idx = state.log.findIndex(c => c.sha === p.dataset.goto);
    if (idx >= 0) selectCommit(idx, { scroll: true });
  });
}

let selectToken = 0;
async function selectCommit(i, { scroll = false, force = false } = {}) {
  if (i == null || !state.log[i]) return;
  if (i === state.selected && !force) return;
  state.selected = i;
  const list = $('.commit-list');
  if (!list) return;
  list.querySelector('.commit-row.selected')?.classList.remove('selected');
  const row = list.querySelector(`[data-i="${i}"]`);
  row?.classList.add('selected');
  if (scroll) row?.scrollIntoView({ block: 'nearest' });

  const c = state.log[i];
  const token = ++selectToken;
  try {
    const [detail, files] = await Promise.all([G.getCommit(state.repo, c.sha), G.getCommitFiles(state.repo, c.sha)]);
    if (token !== selectToken) return;
    const [subject, ...rest] = detail.message.split('\n');
    const body = rest.join('\n').trim();
    const parents = detail.parents.map(p => `<span class="link mono" data-goto="${p}">${p.slice(0, 7)}</span>`).join(', ') || '—';
    $('.commit-meta').innerHTML = `
      <h3>${esc(subject)}</h3>
      ${body ? `<p class="body">${esc(body)}</p>` : ''}
      <dl class="kv">
        <dt>Author</dt><dd title="${esc(detail.email)}">${esc(detail.author)} &lt;${esc(detail.email)}&gt;</dd>
        <dt>Date</dt><dd>${esc(fmtDate(detail.time))}</dd>
        ${detail.committer !== detail.author ? `<dt>Committer</dt><dd>${esc(detail.committer)}</dd>` : ''}
        <dt>SHA</dt><dd class="mono">${detail.sha}</dd>
        <dt>Parents</dt><dd>${parents}</dd>
      </dl>`;
    state.commitFiles = files;
    $('.history .file-list').innerHTML = files.length ? files.map((f, k) => fileRow(f, k)).join('') : '<div class="list-empty">No changed files</div>';
    const keep = state.commitFile ? files.findIndex(f => f.path === state.commitFile.path) : -1;
    showCommitFile(Math.max(0, keep));
  } catch (e) {
    toast('Failed to load commit', 'error', e.message);
  }
}

// `depth` is set in folder mode: the row is indented and shows only the file name.
function fileRow(f, k, action = '', depth = null) {
  const { dir, name } = splitPath(f.path);
  const nested = depth !== null;
  const title = f.orig ? `${f.orig} → ${f.path}` : f.path;
  return `<div class="file-row" data-i="${k}" data-path="${esc(f.path)}"${nested ? ` style="${indent(24, depth)}"` : ''} title="${esc(title)}">
    ${statusBadge(f)}${fileIcon(f.path, f.submodule)}
    <span class="fname">${esc(name)}${nested ? '' : ` <span class="fdir">${esc(dir)}</span>`}</span>${f.submodule ? '<span class="ftag">submodule</span>' : ''}${action}</div>`;
}

async function showCommitFile(k) {
  const f = state.commitFiles[k];
  const pane = $('.history .diff-pane');
  document.querySelectorAll('.history .file-row.selected').forEach(el => el.classList.remove('selected'));
  if (!f) { state.commitFile = null; pane.innerHTML = '<div class="placeholder">No file</div>'; return; }
  state.commitFile = f;
  $(`.history .file-row[data-i="${k}"]`)?.classList.add('selected');
  const token = selectToken;
  try {
    const diff = await G.getCommitDiff(state.repo, state.log[state.selected].sha, f);
    if (token !== selectToken || state.commitFile !== f) return;
    showDiff(pane, diff, f.path);
  } catch (e) {
    pane.innerHTML = `<div class="placeholder">${esc(e.message)}</div>`;
  }
}

function commitMenu(x, y, c) {
  const short = c.sha.slice(0, 7);
  const cur = state.status?.branch || 'HEAD';
  const reset = mode => async () => {
    const msg = { soft: 'keeps changes staged', mixed: 'keeps changes in the working copy', hard: 'DISCARDS all local changes' }[mode];
    if (await confirmBox(`Reset ${mode}`, `Move "${cur}" to ${short} (${msg})?`, `Reset ${mode}`, mode === 'hard')) {
      run('Reset', () => g(['reset', `--${mode}`, c.sha]), { busy: 'Resetting', on: [at.commit(c.sha), at.current()] });
    }
  };
  // Branches (local and remote) whose tip is this commit, except the current one
  const remotes = state.refs?.remoteNames || [];
  const tips = c.refs
    .map(r => (r.startsWith('HEAD -> ') ? r.slice(8) : r))
    .filter(r => r !== 'HEAD' && !r.startsWith('tag: ') && !(remotes.some(rm => r.startsWith(rm + '/')) && r.endsWith('/HEAD')));
  const merges = state.status?.detached ? [] : tips
    .filter(b => b !== cur)
    .map(b => ({ label: `Merge "${b}" into "${cur}"`, run: () => mergeRef(b) }));
  showMenu(x, y, [
    ...merges, ...(merges.length ? ['-'] : []),
    { label: 'Create branch here…', run: () => createBranch(c.sha) },
    { label: 'Create tag here…', run: () => createTag(c.sha) },
    { label: `Checkout ${short} (detached HEAD)`, run: () => run('Checkout', () => g(['checkout', '--detach', c.sha]), { busy: 'Checking out', on: [at.commit(c.sha)] }) },
    '-',
    { label: 'Cherry-pick', run: () => run('Cherry-pick', () => g(['cherry-pick', c.sha]), { busy: 'Cherry-picking', on: [at.commit(c.sha)], mayConflict: true }) },
    { label: 'Revert commit', run: () => run('Revert', () => g(['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.sha]), { busy: 'Reverting', on: [at.commit(c.sha)], mayConflict: true }) },
    '-',
    { label: `Reset "${cur}" to here — soft`, run: reset('soft') },
    { label: `Reset "${cur}" to here — mixed`, run: reset('mixed') },
    { label: `Reset "${cur}" to here — hard…`, danger: true, run: reset('hard') },
    '-',
    { label: 'Copy SHA', run: () => copy(c.sha) },
    { label: 'Copy message', run: () => copy(c.subject) },
  ]);
}

// ---------------------------------------------------------------------
// Local changes
// ---------------------------------------------------------------------

// The selection lives in one list at a time. `anchor` is where Shift ranges start,
// `focus` is the row moved by the arrow keys.
const emptySel = () => ({ kind: null, paths: new Set(), anchor: null, focus: null });
state.sel = emptySel();

const visibleFiles = kind => {
  const files = state.status[kind].filter(f => matches(f.path, state.fileFilter));
  return state.fileTree ? files.sort((a, b) => treeCompare(a.path, b.path)) : files;
};
// Files reachable with the keyboard: visible ones, minus those inside collapsed folders.
const navFiles = kind => visibleFiles(kind).filter(f => !(state.fileTree && hiddenInFolder(kind, f.path)));
const dirKey = (kind, path) => `ft:${kind}:${path}`;
const hiddenInFolder = (kind, path) => Object.keys(state.collapsed).some(k =>
  state.collapsed[k] && k.startsWith(`ft:${kind}:`) && path.startsWith(k.slice(kind.length + 4) + '/'));

// A section's file rows: flat, or nested in collapsible folders in folder mode.
function fileListHtml(kind, files, indexOf, action) {
  if (!state.fileTree) return files.map(f => fileRow(f, indexOf(f), action(f))).join('');
  return renderTree(pathTree(files, f => f.path), {
    item: (f, depth) => fileRow(f, indexOf(f), action(f), depth),
    dir: (name, path, depth, children) => {
      const key = dirKey(kind, path), collapsed = !state.fileFilter && state.collapsed[key];
      return `<div class="dir-row ${collapsed ? 'collapsed' : ''}" data-dir="${esc(key)}" style="${indent(10, depth)}" title="${esc(path)}">
        ${icon('chevron')}${fileIcon(path, true)}<span>${esc(name)}</span></div>${collapsed ? '' : children()}`;
    },
  });
}
const selectedFiles = () => (state.sel.kind ? state.status[state.sel.kind].filter(f => state.sel.paths.has(f.path)) : []);

function renderChanges() {
  let root = $('.changes');
  if (!root) {
    $('#main').innerHTML = `<div class="changes">
      <div class="changes-left">
        <div class="files-filter"><label class="filter-box">${icon('search')}<input type="search" id="file-filter" placeholder="Filter files  (Ctrl+F)" spellcheck="false"></label><button class="view-toggle" id="file-tree-toggle"></button></div>
        <section class="file-section conflicts" data-kind="conflicts" hidden>
          <div class="section-head">${icon('alert')}Conflicts <span class="n"></span></div>
          <div class="file-list" tabindex="0"></div>
        </section>
        <section class="file-section" data-kind="unstaged">
          <div class="section-head">Unstaged <span class="n"></span><button class="btn-sm" data-bulk="stage">Stage all</button></div>
          <div class="file-list" tabindex="0"></div>
        </section>
        <div class="splitter h" data-split="unstaged-h" data-min="60"></div>
        <section class="file-section" data-kind="staged">
          <div class="section-head">Staged <span class="n"></span><button class="btn-sm" data-bulk="unstage">Unstage all</button></div>
          <div class="file-list" tabindex="0"></div>
        </section>
        <div class="splitter h" data-split="commit-box-h" data-min="90" data-target="next"></div>
        <div class="commit-box">
          <textarea id="commit-msg" placeholder="Commit message  (Ctrl+Enter to commit)" spellcheck="false"></textarea>
          <div class="commit-actions">
            <label><input type="checkbox" id="amend"> Amend</label>
            <button class="btn primary" id="commit-btn">Commit</button>
          </div>
        </div>
      </div>
      <div class="splitter v" data-split="changes-w"></div>
      <div class="diff-pane"><div class="placeholder">Select a file to see its changes</div></div>
    </div>`;
    root = $('.changes');
    bindSplitters(root);
    bindChangesEvents(root);
    $('#commit-msg').value = state.commitMsg;
    $('#amend').checked = state.amend;
    $('#file-filter').value = state.fileFilter;
  }
  renderFileLists();
  updateCommitButton();

  // Keep the selection on files that are still listed; otherwise select the first file.
  const { kind } = state.sel;
  const kept = kind ? visibleFiles(kind).filter(f => state.sel.paths.has(f.path)).map(f => f.path) : [];
  if (kept.length) {
    state.sel.paths = new Set(kept);
    if (!kept.includes(state.sel.focus)) state.sel.focus = state.sel.anchor = kept[kept.length - 1];
    paintSelection();
    showSelection({ quiet: true });
  } else {
    selectFirst();
  }
}

function renderFileLists() {
  const root = $('.changes');
  const toggle = $('#file-tree-toggle', root);
  toggle.innerHTML = icon(state.fileTree ? 'list' : 'folder');
  toggle.title = state.fileTree ? 'Show files as a flat list' : 'Group files into folders';
  const conflicts = state.status.conflicts, shown = visibleFiles('conflicts');
  const csec = $('[data-kind="conflicts"]', root);
  csec.hidden = !conflicts.length;
  $('.n', csec).textContent = shown.length === conflicts.length ? `(${conflicts.length})` : `(${shown.length} of ${conflicts.length})`;
  $('.file-list', csec).innerHTML = shown.length
    ? fileListHtml('conflicts', shown, f => conflicts.indexOf(f), f => f.content ? '' : `<span class="ckind">${esc(f.kind)}</span>`)
    : '<div class="list-empty">No files match the filter</div>';
  pruneResolutions();

  for (const kind of ['unstaged', 'staged']) {
    const all = state.status[kind], files = visibleFiles(kind);
    const sec = $(`[data-kind="${kind}"]`, root);
    $('.n', sec).textContent = !all.length ? '' : files.length === all.length ? `(${all.length})` : `(${files.length} of ${all.length})`;
    const bulk = $('.btn-sm', sec);
    bulk.disabled = !files.length;
    bulk.textContent = `${kind === 'unstaged' ? 'Stage' : 'Unstage'} ${state.fileFilter ? 'shown' : 'all'}`;
    const act = `<button class="act" title="${kind === 'unstaged' ? 'Stage' : 'Unstage'}">${icon(kind === 'unstaged' ? 'plus' : 'minus')}</button>`;
    $('.file-list', sec).innerHTML = files.length
      ? fileListHtml(kind, files, f => all.indexOf(f), () => act)
      : `<div class="list-empty">${all.length ? 'No files match the filter' : kind === 'unstaged' ? 'No pending changes' : 'Nothing staged for commit'}</div>`;
  }
  paintBusy();
}

function selectFirst() {
  const kind = ['conflicts', 'unstaged', 'staged'].find(k => visibleFiles(k).length);
  if (kind) return setSelection(kind, [visibleFiles(kind)[0].path]);
  state.sel = emptySel();
  const clean = !changeCount(state.status);
  $('.changes .diff-pane').innerHTML = `<div class="placeholder">${clean ? 'Working copy clean ✨' : 'No files match the filter'}</div>`;
}

function setSelection(kind, paths, { anchor, focus } = {}) {
  const last = paths[paths.length - 1] ?? null;
  state.sel = { kind, paths: new Set(paths), anchor: anchor ?? last, focus: focus ?? last };
  paintSelection();
  showSelection();
}

function paintSelection() {
  document.querySelectorAll('.changes .file-row').forEach(row => {
    const kind = row.closest('[data-kind]').dataset.kind;
    const f = state.status[kind][+row.dataset.i];
    row.classList.toggle('selected', kind === state.sel.kind && state.sel.paths.has(f.path));
  });
}

function rowFile(row) {
  const kind = row.closest('[data-kind]').dataset.kind;
  return { kind, f: state.status[kind][+row.dataset.i] };
}

function rowFor(kind, path) {
  const i = state.status[kind].findIndex(f => f.path === path);
  return $(`.changes [data-kind="${kind}"] .file-row[data-i="${i}"]`);
}

// Plain click selects one file, Ctrl+click toggles, Shift+click selects a range.
function clickFile(kind, f, e) {
  const order = navFiles(kind).map(x => x.path);
  const same = state.sel.kind === kind;
  const a = same ? order.indexOf(state.sel.anchor) : -1;
  if (e.shiftKey && a >= 0) {
    const b = order.indexOf(f.path);
    return setSelection(kind, order.slice(Math.min(a, b), Math.max(a, b) + 1), { anchor: state.sel.anchor, focus: f.path });
  }
  if ((e.ctrlKey || e.metaKey) && same) {
    const paths = new Set(state.sel.paths);
    paths.has(f.path) ? paths.delete(f.path) : paths.add(f.path);
    return setSelection(kind, order.filter(p => paths.has(p)), { anchor: f.path, focus: f.path });
  }
  setSelection(kind, [f.path]);
}

// Actions on a row apply to the whole selection when the row is part of it.
const targetFiles = (kind, f) => (state.sel.kind === kind && state.sel.paths.has(f.path) ? selectedFiles() : [f]);
// Conflicted files are never staged as they are: they get resolved first.
const toggleStage = (kind, files) => files.length && kind !== 'conflicts' && (kind === 'staged' ? unstage(files) : stage(files));

function statusBadge(f) {
  return `<span class="st st-${esc(f.status)}">${esc(f.status === '?' ? 'A' : f.status)}</span>`;
}

function updateCommitButton() {
  const btn = $('#commit-btn');
  if (!btn || committing) return; // keep the "Committing…" state until the commit finishes
  const s = state.status, op = state.op?.kind, n = s.staged.length;
  const msg = $('#commit-msg'), amend = $('#amend');
  // A rebase, cherry-pick or revert is continued instead, keeping the replayed commit's message.
  const replaying = !!op && op !== 'merge';
  msg.disabled = replaying;
  msg.placeholder = replaying ? `Continuing the ${op} keeps the original commit message` : 'Commit message  (Ctrl+Enter to commit)';
  amend.disabled = !!op;
  if (op && amend.checked) amend.checked = state.amend = false;
  const hasMsg = msg.value.trim().length > 0;
  if (replaying) {
    btn.disabled = s.conflicts.length > 0;
    btn.textContent = `Continue ${op}`;
  } else if (op === 'merge') {
    btn.disabled = !hasMsg || s.conflicts.length > 0;
    btn.textContent = 'Commit merge';
  } else {
    btn.disabled = !hasMsg || (!n && !amend.checked);
    btn.textContent = amend.checked ? 'Amend' : n ? `Commit (${n})` : 'Commit';
  }
  btn.title = s.conflicts.length ? 'Resolve every conflict first' : '';
}

function bindChangesEvents(root) {
  root.addEventListener('mousedown', e => {
    if (lineMouseDown(e)) return;
    const row = e.target.closest('.file-row');
    if (!row || e.button !== 0 || e.target.closest('.act')) return;
    const { kind, f } = rowFile(row);
    clickFile(kind, f, e);
  });
  root.addEventListener('click', e => {
    const act = e.target.closest('.act');
    if (act) {
      const { kind, f } = rowFile(act.closest('.file-row'));
      return toggleStage(kind, targetFiles(kind, f));
    }
    const part = e.target.closest('[data-part]');
    if (part) return partClick(part);
    const rs = e.target.closest('[data-rs]');
    if (rs) return rs.disabled || resolverAction(rs);
    const sa = e.target.closest('[data-sub-act]');
    if (sa) return sa.dataset.subAct === 'open' ? openSubmodule(selectedFiles()[0]?.path) : discard(selectedFiles());
    const ms = e.target.closest('[data-ms]');
    if (ms) {
      const files = selectedFiles();
      return { discard: () => discard(files), ours: () => takeSide(files, 'ours'), theirs: () => takeSide(files, 'theirs'),
        resolved: () => markResolved(files), toggle: () => toggleStage(state.sel.kind, files) }[ms.dataset.ms]();
    }
    const bulk = e.target.closest('[data-bulk]');
    if (!bulk) return;
    // `git add -A` would also mark the conflicted files as resolved, markers and all
    if (bulk.dataset.bulk === 'stage') {
      return state.fileFilter || state.status.conflicts.length ? stage(visibleFiles('unstaged'))
        : run('Stage', () => g(['add', '-A']), { busy: 'Staging', on: [at.allFiles('unstaged')] });
    }
    return state.fileFilter ? unstage(visibleFiles('staged')) : unstageAll();
  });
  // Hand-edited conflict results
  root.addEventListener('input', e => {
    const ta = e.target.closest('textarea[data-edit]');
    const entry = ta && resolutionFor(selectedFiles()[0]);
    if (!entry) return;
    entry.segs[+ta.dataset.edit].custom = ta.value;
    ta.rows = Math.max(2, ta.value.split('\n').length);
  });
  root.addEventListener('dblclick', e => {
    const row = e.target.closest('.file-row');
    if (!row || e.target.closest('.act') || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const { kind, f } = rowFile(row);
    toggleStage(kind, [f]);
  });
  root.addEventListener('keydown', e => {
    const list = e.target.closest('.file-list');
    if (!list) return;
    const kind = list.closest('[data-kind]').dataset.kind;
    const order = navFiles(kind).map(f => f.path);
    if (!order.length) return;
    const same = state.sel.kind === kind;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      return setSelection(kind, order, { anchor: order[0], focus: order[order.length - 1] });
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = same ? order.indexOf(state.sel.focus) : -1;
      const next = order[Math.max(0, Math.min(order.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
      const a = same ? order.indexOf(state.sel.anchor) : -1;
      if (e.shiftKey && a >= 0) {
        const b = order.indexOf(next);
        setSelection(kind, order.slice(Math.min(a, b), Math.max(a, b) + 1), { anchor: state.sel.anchor, focus: next });
      } else {
        setSelection(kind, [next]);
      }
      rowFor(kind, next)?.scrollIntoView({ block: 'nearest' });
    } else if ((e.key === 'Enter' || e.key === ' ') && same) {
      e.preventDefault();
      toggleStage(kind, selectedFiles());
    } else if (e.key === 'Delete' && kind === 'unstaged' && same) {
      e.preventDefault();
      discard(selectedFiles());
    }
  });
  root.addEventListener('contextmenu', e => {
    const line = e.target.closest('table.diff.stageable tr[data-h]');
    if (line) { e.preventDefault(); return lineMenu(e, line); }
    const row = e.target.closest('.file-row');
    if (!row) return;
    e.preventDefault();
    const { kind, f } = rowFile(row);
    if (!(state.sel.kind === kind && state.sel.paths.has(f.path))) setSelection(kind, [f.path]);
    const files = targetFiles(kind, f), n = files.length, many = n > 1;
    if (kind === 'conflicts') return conflictMenu(e.clientX, e.clientY, files);
    const staged = kind === 'staged';
    const untracked = files.filter(x => x.untracked);
    showMenu(e.clientX, e.clientY, [
      staged ? { label: many ? `Unstage ${n} files` : 'Unstage', run: () => unstage(files) }
        : { label: many ? `Stage ${n} files` : 'Stage', run: () => stage(files) },
      { label: many ? `Discard changes in ${n} files…` : 'Discard changes…', danger: true, disabled: staged, run: () => discard(files) },
      '-',
      { label: many ? `Copy ${n} paths` : 'Copy path', run: () => copy(files.map(x => x.path).join('\n')) },
      { label: 'Show in Explorer', disabled: many, run: () => invoke('show_in_explorer', { repo: state.repo, path: f.path }).catch(err => toast('Show in Explorer failed', 'error', String(err))) },
      { label: 'Add to .gitignore', disabled: untracked.length !== n, run: () => ignoreFiles(files) },
      ...(!many && f.submodule ? [{ label: 'Open submodule', disabled: !cloned(state.submodules.find(s => s.path === f.path)), run: () => openSubmodule(f.path) }] : []),
      ...lfsFileItems(files, staged),
    ]);
  });

  root.addEventListener('click', e => {
    const dir = e.target.closest('[data-dir]');
    if (dir) {
      state.collapsed[dir.dataset.dir] = !state.collapsed[dir.dataset.dir];
      store('collapsed', state.collapsed);
      return renderFileLists();
    }
    if (e.target.closest('#file-tree-toggle')) {
      state.fileTree = !state.fileTree;
      store('fileTree', state.fileTree);
      renderFileLists();
    }
  });

  const filter = $('#file-filter', root);
  const applyFilter = value => { filter.value = value; state.fileFilter = value.trim(); renderChanges(); };
  filter.addEventListener('input', () => applyFilter(filter.value));
  filter.addEventListener('keydown', e => {
    if (e.key === 'Escape' && filter.value) { e.preventDefault(); applyFilter(''); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); $(`.changes [data-kind="${state.sel.kind || 'unstaged'}"] .file-list`)?.focus(); }
  });

  const msg = $('#commit-msg', root);
  msg.addEventListener('input', () => { state.commitMsg = msg.value; updateCommitButton(); });
  msg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });
  $('#amend', root).addEventListener('change', async e => {
    state.amend = e.target.checked;
    if (state.amend && !msg.value.trim()) {
      try { msg.value = state.commitMsg = (await g(['log', '-1', '--format=%B'])).trim(); } catch {}
    }
    updateCommitButton();
  });
  $('#commit-btn', root).addEventListener('click', commit);
}

// Shows the diff of the selected file, or a summary with bulk actions when several are selected.
async function showSelection({ quiet = false } = {}) {
  const pane = $('.changes .diff-pane');
  const files = selectedFiles(), kind = state.sel.kind;
  const token = ++selectToken;
  if (!files.length) {
    pane.dataset.shown = '';
    pane.innerHTML = '<div class="placeholder">Select a file to see its changes</div>';
    return;
  }
  if (files.length > 1) {
    const staged = kind === 'staged', max = 300, n = plural(files.length, 'file');
    const actions = kind === 'conflicts'
      ? `<button class="btn" data-ms="ours">Use current for ${n}…</button>
         <button class="btn" data-ms="theirs">Use incoming for ${n}…</button>
         <button class="btn" data-ms="resolved">Mark ${n} as resolved</button>`
      : `<button class="btn primary" data-ms="toggle">${staged ? 'Unstage' : 'Stage'} ${n}</button>
         ${staged ? '' : '<button class="btn danger" data-ms="discard">Discard changes…</button>'}`;
    pane.dataset.shown = '';
    pane.innerHTML = `<div class="multi-sel">
      <div class="ms-title">${n} selected</div>
      <div class="ms-list">${files.slice(0, max).map(f => `<div class="ms-file">${statusBadge(f)}${fileIcon(f.path, f.submodule)}<span>${esc(f.path)}</span></div>`).join('')}
        ${files.length > max ? `<div class="ms-file muted">…and ${files.length - max} more</div>` : ''}</div>
      <div class="ms-actions">${actions}</div>
    </div>`;
    return;
  }
  const f = files[0], key = `${kind}:${f.path}`;
  if (kind === 'conflicts') return showConflict(f, { token, quiet });
  if (f.submodule) return showSubmoduleChange(f, kind, token);
  try {
    const text = await G.getWorkDiff(state.repo, f, kind === 'staged');
    if (token !== selectToken) return;
    const scroll = quiet && pane.dataset.shown === key ? pane.querySelector('.diff-scroll')?.scrollTop : 0;
    showDiff(pane, text, f.path, f.path, { kind, path: f.path });
    pane.dataset.shown = key;
    if (scroll) pane.querySelector('.diff-scroll').scrollTop = scroll;
  } catch (e) {
    pane.innerHTML = `<div class="placeholder">${esc(e.message)}</div>`;
  }
}

// "Track with Git LFS" entries of the file menu: by extension or by path.
function lfsFileItems(files, staged) {
  const plain = files.filter(f => !f.submodule && f.status !== 'D');
  if (!state.lfs?.installed || !plain.length) return [];
  const restage = staged ? plain.map(f => f.path) : [];
  const exts = [...new Set(plain.map(f => f.path.match(/\.[^./]+$/)?.[0]?.toLowerCase()))];
  const ext = exts.length === 1 && exts[0];
  return ['-',
    ...(ext ? [{ label: `Track all "*${ext}" files with Git LFS`, run: () => trackLfs([`*${ext}`], restage) }] : []),
    { label: plain.length > 1 ? `Track these ${plain.length} files with Git LFS` : 'Track this file with Git LFS', run: () => trackLfs(plain.map(f => f.path), restage) },
  ];
}

// A submodule entry: the commits it moved by, and what changed inside it.
async function showSubmoduleChange(f, kind, token) {
  const pane = $('.changes .diff-pane');
  const text = await G.getWorkDiff(state.repo, f, kind === 'staged').catch(() => '');
  if (token !== selectToken) return;
  const info = parseSubmoduleLog(text) || { path: f.path, from: null, to: null, note: null, commits: [], modified: false, untracked: false };
  if (kind === 'unstaged') {
    info.modified ||= f.submodule.modified;
    info.untracked ||= f.submodule.untracked;
  }
  const sub = state.submodules.find(s => s.path === f.path);
  const staged = kind === 'staged', moved = staged || f.submodule.commit;
  const actions = [
    moved && `<button class="btn primary" data-ms="toggle">${staged ? 'Unstage' : 'Stage'}</button>`,
    cloned(sub) && `<button class="btn" data-sub-act="open">Open submodule</button>`,
    !staged && f.submodule.commit && '<button class="btn" data-sub-act="reset">Check out the recorded commit…</button>',
  ].filter(Boolean).join('');
  pane.dataset.shown = `${kind}:${f.path}`;
  pane.innerHTML = renderSubmodule(info, { title: f.path, actions });
}

// Runs `git <args> -- <paths>` in chunks so a single call never hits the Windows command-line limit.
async function gitPaths(args, paths) {
  let chunk = [], len = 0;
  for (const p of paths) {
    if (chunk.length && len + p.length > 20000) { await g([...args, '--', ...chunk]); chunk = []; len = 0; }
    chunk.push(p);
    len += p.length + 3;
  }
  if (chunk.length) await g([...args, '--', ...chunk]);
}

const stage = files => run('Stage', () => gitPaths(['add', '-A'], files.map(f => f.path)),
  { busy: 'Staging', on: files.map(f => at.file('unstaged', f.path)) });

function unstage(files) {
  const paths = files.flatMap(f => (f.orig ? [f.orig, f.path] : [f.path]));
  const opts = { busy: 'Unstaging', on: files.map(f => at.file('staged', f.path)) };
  if (state.status.unborn) return run('Unstage', () => gitPaths(['rm', '--cached', '-r', '-q'], paths), opts);
  return run('Unstage', () => gitPaths(['restore', '--staged'], paths), opts);
}

function unstageAll() {
  const opts = { busy: 'Unstaging', on: [at.allFiles('staged')] };
  if (state.status.unborn) return run('Unstage', () => g(['rm', '--cached', '-r', '-q', '.']), opts);
  return run('Unstage', () => g(['reset', '-q']), opts);
}

// Submodules are put back on the commit recorded in this repository instead (what `git restore`
// would do to a file); changes inside them are theirs to discard.
async function discard(files) {
  if (!files.length) return;
  const untracked = files.filter(f => f.untracked), subs = files.filter(f => f.submodule);
  const tracked = files.filter(f => !f.untracked && !f.submodule);
  const subNote = !subs.length ? ''
    : ` ${subs.length === 1 ? 'The submodule goes' : `${plural(subs.length, 'submodule')} go`} back to the commit recorded in this repository; uncommitted changes inside ${subs.length === 1 ? 'it are' : 'them are'} kept.`;
  const message = files.length === 1
    ? (untracked.length ? `Delete the untracked file "${files[0].path}"? This cannot be undone.`
      : subs.length ? `Check out the recorded commit in the submodule "${files[0].path}"?${subNote}`
      : `Discard the changes in "${files[0].path}"? This cannot be undone.`)
    : `Discard the changes in ${plural(files.length, 'file')}?` + (untracked.length ? ` ${plural(untracked.length, 'untracked file')} will be deleted.` : '') + subNote + ' This cannot be undone.';
  if (!(await confirmBox('Discard changes', message, 'Discard'))) return;
  run('Discard', async () => {
    if (tracked.length) await gitPaths(['restore'], tracked.map(f => f.path));
    if (untracked.length) await gitPaths(['clean', '-f'], untracked.map(f => f.path));
    if (subs.length) await gitPaths(['submodule', 'update', '--init'], subs.map(f => f.path));
  }, { busy: 'Discarding', on: files.map(f => at.file('unstaged', f.path)) });
}

function ignoreFiles(files) {
  const paths = files.map(f => f.path);
  run('Update .gitignore', async () => {
    for (const p of paths) await invoke('append_gitignore', { repo: state.repo, pattern: '/' + p });
  }, {
    success: paths.length === 1 ? `"${paths[0]}" added to .gitignore` : `${paths.length} paths added to .gitignore`,
    busy: 'Updating .gitignore', on: paths.map(p => at.file('unstaged', p)),
  });
}

// ---------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------

// Choices made in the resolver, per file, kept until the file is saved or changes on disk.
const resolutions = new Map();
const resolutionKey = path => `${state.repo}\n${path}`;
const resolutionFor = f => f && resolutions.get(resolutionKey(f.path));

function pruneResolutions() {
  const live = new Set(state.status.conflicts.map(f => resolutionKey(f.path)));
  for (const k of resolutions.keys()) if (k.startsWith(state.repo + '\n') && !live.has(k)) resolutions.delete(k);
}

// Shows the resolver of a conflicted file, or a card with the possible resolutions when it
// can't be resolved line by line.
async function showConflict(f, { token, quiet }) {
  const pane = $('.changes .diff-pane');
  const key = `conflicts:${f.path}`;
  const card = (title, message, actions, { diff = false, shown = '' } = {}) => {
    pane.dataset.shown = shown;
    pane.innerHTML = renderConflictCard({ path: f.path, kind: f.kind, title, message, actions, diff });
  };
  const { ours, theirs } = sideNames();
  const current = ours ? `the current side (${ours})` : 'the current side';
  const incoming = theirs ? `the incoming side (${theirs})` : 'the incoming side';
  const versions = [{ rs: 'take-ours', label: 'Use current version' }, { rs: 'take-theirs', label: 'Use incoming version' }];
  const tool = state.mergeTool ? [{ rs: 'tool', label: `Open in ${state.mergeTool}` }] : [];
  const resolved = { rs: 'resolved', label: 'Mark as resolved' };

  if (!f.content) {
    // One side deleted the file (or only one side has it): keep it or delete it.
    const message = {
      DU: `It was deleted on ${current} and changed on ${incoming}.`,
      UD: `It was changed on ${current} and deleted on ${incoming}.`,
      AU: `Only ${current} has this file.`,
      UA: `Only ${incoming} has this file.`,
      DD: 'Both sides deleted this file (it may have been renamed differently on each side).',
    }[f.conflict];
    const side = s => ({ rs: `take-${s}`, label: f[s] ? `Keep the ${s === 'ours' ? 'current' : 'incoming'} version` : 'Delete the file' });
    return card(f.kind, message, f.conflict === 'DD' ? [{ ...side('ours'), primary: true }] : [side('ours'), side('theirs')]);
  }

  let raw;
  try { raw = await G.readFile(state.repo, f.path); } catch { raw = undefined; }
  if (token !== selectToken) return;
  if (raw === null) {
    return card('The file is missing', 'It was deleted from the working copy. Restore one of the versions, or mark the conflict as resolved to delete the file.', [...versions, resolved]);
  }
  if (raw === undefined || raw.includes('\0')) {
    return card('Binary file', 'This file can\'t be resolved line by line. Pick the version to keep, or replace the file yourself and mark it as resolved.', [...versions, ...tool, resolved]);
  }

  const k = resolutionKey(f.path);
  let entry = resolutions.get(k);
  const same = entry?.raw === raw;
  if (!same) resolutions.set(k, (entry = { raw, segs: parseConflicts(raw) }));
  if (!entry.segs) {
    return card('Unreadable conflict markers', 'The conflict markers in this file are incomplete or nested. Fix them in your editor, or use one of the versions.', [...versions, ...tool, resolved]);
  }
  if (!entry.segs.some(s => s.type === 'conflict')) {
    // Resolved in another program: review and mark it.
    if (quiet && same && pane.dataset.shown === key + ':clean') return;
    card('No conflict markers left', 'Review the result below, then mark the file as resolved.',
      [{ ...resolved, primary: true }, ...versions], { diff: true, shown: key + ':clean' });
    const text = await g(['diff', '--ours', '--', f.path]).catch(e => e.message);
    const dp = pane.querySelector('.rs-diff');
    if (token === selectToken && dp) showDiff(dp, text, 'Compared with the current version', f.path);
    return;
  }
  if (quiet && same && pane.dataset.shown === key) return;
  paintResolver(f, entry, { keepScroll: quiet && pane.dataset.shown === key });
}

function paintResolver(f, entry, { keepScroll = true } = {}) {
  const pane = $('.changes .diff-pane');
  const prev = pane.querySelector('.rs-scroll');
  const pos = keepScroll && prev ? [prev.scrollTop, prev.scrollLeft] : null;
  pane.innerHTML = renderResolver(entry.segs, { path: f.path, mergeTool: state.mergeTool });
  pane.dataset.shown = `conflicts:${f.path}`;
  const sc = pane.querySelector('.rs-scroll');
  if (pos) [sc.scrollTop, sc.scrollLeft] = pos;
  else {
    // Start at the first unresolved conflict
    const bar = sc.querySelector('.rs-bar:not(.done)');
    if (bar) sc.scrollTop += bar.getBoundingClientRect().top - sc.getBoundingClientRect().top - 60;
  }
}

function resolverAction(btn) {
  const files = selectedFiles();
  const f = state.sel.kind === 'conflicts' && files.length === 1 ? files[0] : null;
  if (!f) return;
  const act = btn.dataset.rs;
  if (act === 'take-ours' || act === 'take-theirs') return takeSide([f], act.slice(5));
  if (act === 'resolved') return markResolved([f]);
  if (act === 'tool') return openMergeTool(f);
  const entry = resolutionFor(f);
  if (!entry?.segs) return;
  if (act === 'save') return saveResolution(f, entry);
  const seg = entry.segs[+btn.dataset.seg];
  if (act === 'all-ours' || act === 'all-theirs') {
    // hand-edited results are kept
    entry.segs.filter(s => s.type === 'conflict' && s.choice !== 'custom').forEach(c => Object.assign(c, { choice: act.slice(4), editing: false }));
  } else if (act === 'unfold') seg.open = true;
  else if (act === 'edit') startEdit(seg);
  else if (act === 'done') seg.editing = false;
  else if (act === 'undo') Object.assign(seg, { choice: null, custom: null, editing: false });
  else Object.assign(seg, { choice: act, editing: false }); // ours / theirs / both
  paintResolver(f, entry);
  if (act === 'edit') $(`.changes textarea[data-edit="${btn.dataset.seg}"]`)?.focus();
}

function saveResolution(f, entry) {
  if (entry.segs.some(s => s.type === 'conflict' && !s.choice)) return;
  const content = resolvedContent(entry.segs);
  run('Resolve', async () => {
    // Never overwrite edits made in another program since the file was read.
    if ((await G.readFile(state.repo, f.path)) !== entry.raw) {
      throw new Error('The file changed on disk since it was opened. Review it again before saving.');
    }
    await G.writeFile(state.repo, f.path, content);
    resolutions.delete(resolutionKey(f.path));
    await g(['add', '--', f.path]);
  }, { success: `"${f.path}" resolved`, busy: 'Resolving', on: [at.file('conflicts', f.path)] });
}

// Resolves whole files with one side's version: the file is deleted if that side deleted it.
async function takeSide(files, side) {
  if (!files.length) return;
  const name = side === 'ours' ? 'current' : 'incoming';
  const gone = files.filter(f => !f[side]);
  const what = files.length === 1 ? `"${files[0].path}"` : plural(files.length, 'file');
  const deleted = !gone.length ? ''
    : files.length === 1 ? ` The file is deleted, as on the ${name} side.`
    : ` ${plural(gone.length, 'file')} deleted on the ${name} side ${gone.length === 1 ? 'is' : 'are'} deleted.`;
  const message = `Resolve ${what} using the ${name} version? Changes from the other side and edits made to ${files.length === 1 ? 'the file' : 'these files'} are discarded.${deleted}`;
  if (!(await confirmBox(`Use ${name} version`, message, `Use ${name}`))) return;
  run('Resolve', async () => {
    const keep = files.filter(f => f[side]).map(f => f.path);
    if (keep.length) {
      await gitPaths(['checkout', `--${side}`], keep);
      await gitPaths(['add'], keep);
    }
    if (gone.length) await gitPaths(['rm', '-q'], gone.map(f => f.path));
  }, { busy: 'Resolving', on: files.map(f => at.file('conflicts', f.path)) });
}

async function markResolved(files) {
  if (!files.length) return;
  const marked = [];
  for (const f of files.filter(x => x.content)) {
    const raw = await G.readFile(state.repo, f.path).catch(() => null);
    if (raw && hasMarkers(raw)) marked.push(f.path);
  }
  if (marked.length) {
    const what = marked.length === 1 ? `"${marked[0]}" still has` : `${plural(marked.length, 'file')} still have`;
    if (!(await confirmBox('Mark as resolved', `${what} conflict markers. Mark as resolved anyway?`, 'Mark as resolved'))) return;
  }
  run('Mark as resolved', () => gitPaths(['add', '-A'], files.map(f => f.path)),
    { busy: 'Resolving', on: files.map(f => at.file('conflicts', f.path)) });
}

const openMergeTool = f => run('Merge tool', () => g(['mergetool', '--no-prompt', '--', f.path]),
  { busy: `Waiting for ${state.mergeTool}`, on: [at.file('conflicts', f.path)] });

function conflictMenu(x, y, files) {
  const n = files.length, many = n > 1, { ours, theirs } = sideNames();
  const forN = many ? ` for ${n} files` : '';
  showMenu(x, y, [
    { label: `Use current${ours ? ` (${ours})` : ''}${forN}…`, run: () => takeSide(files, 'ours') },
    { label: `Use incoming${theirs ? ` (${theirs})` : ''}${forN}…`, run: () => takeSide(files, 'theirs') },
    { label: many ? `Mark ${n} files as resolved` : 'Mark as resolved', run: () => markResolved(files) },
    ...(state.mergeTool ? [{ label: `Open in ${state.mergeTool}`, disabled: many, run: () => openMergeTool(files[0]) }] : []),
    '-',
    { label: many ? `Copy ${n} paths` : 'Copy path', run: () => copy(files.map(f => f.path).join('\n')) },
  ]);
}

let committing = false;

// Also concludes a merge (the banner's "Commit merge" ends up here, from any view).
async function commit() {
  if (committing) return;
  const op = state.op?.kind;
  if (op && op !== 'merge') return continueOp();
  const merging = op === 'merge';
  const msg = state.commitMsg.trim();
  const amend = state.amend && !op;
  if (state.status.conflicts.length) return toast('Resolve every conflict first', 'error');
  if (!msg) {
    if (state.view !== 'changes') setView('changes');
    return $('#commit-msg')?.focus();
  }
  if (!amend && !merging && !state.status.staged.length) return toast('Nothing staged for commit');
  committing = true;
  const btn = $('#commit-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = busyTag(amend ? 'Amending' : 'Committing');
  }
  const ok = await run(amend ? 'Amend' : merging ? 'Commit merge' : 'Commit', async () => {
    await g(['commit', ...(amend ? ['--amend'] : []), '-m', msg]);
    return true;
  }, { busy: amend ? 'Amending' : 'Committing', on: [at.current(), at.allFiles('staged'), merging && at.op()] });
  committing = false;
  if (ok) {
    setCommitMsg('');
    state.amend = false;
    const box = $('#amend');
    if (box) box.checked = false;
    toast(amend ? 'Commit amended' : merging ? 'Merge committed' : 'Commit created', 'ok');
  }
  updateCommitButton();
}

// =====================================================================
// Branch / remote actions
// =====================================================================

const copy = text => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', 'error'));

function checkout(name, on = []) {
  return run(`Checkout ${name}`, () => g(['switch', name]), { busy: 'Checking out', on: [at.branch(name), ...on] });
}

function checkoutRemote(full) {
  const name = full.slice(full.indexOf('/') + 1);
  if (state.refs.local.some(b => b.name === name)) return checkout(name, [at.remoteBranch(full)]);
  return run(`Checkout ${name}`, () => g(['switch', '--track', full]), { busy: 'Checking out', on: [at.remoteBranch(full)] });
}

async function createBranch(startPoint) {
  const r = await modal({ title: 'New branch', message: startPoint ? `Starting from ${startPoint.slice(0, 7)}` : 'Starting from the current HEAD', input: '', check: { label: 'Check out after creating', value: true }, ok: 'Create branch' });
  if (!r) return;
  const name = r.value.replace(/\s+/g, '-');
  const args = r.checked ? ['switch', '-c', name] : ['branch', name];
  if (startPoint) args.push(startPoint);
  run('Create branch', () => g(args), { success: `Branch "${name}" created`, busy: 'Creating branch', on: [startPoint ? at.commit(startPoint) : at.action('branch')] });
}

// The tag can be pushed right away; that choice is remembered.
async function createTag(sha) {
  const remote = mainRemote();
  const r = await modal({
    title: 'New tag', message: `On commit ${sha.slice(0, 7)}`, input: '', ok: 'Create tag',
    checks: remote ? [{ label: `Push to "${remote}"`, value: !!store('pushNewTag') }] : [],
  });
  if (!r) return;
  const name = r.value.replace(/\s+/g, '-'), push = !!r.checked;
  if (remote) store('pushNewTag', push);
  const created = await run('Create tag', () => g(['tag', name, sha]).then(() => true), { success: push ? null : 'Tag created', busy: 'Tagging', on: [at.commit(sha)] });
  if (created && push) pushTags(remote, name);
}

// Pushes one tag, or all of them without `name`.
function pushTags(remote, name) {
  return run(name ? 'Push tag' : 'Push tags', () => g(['push', remote, name ? `refs/tags/${name}` : '--tags']), {
    success: name ? `Tag "${name}" pushed to "${remote}"` : `Tags pushed to "${remote}"`,
    busy: 'Pushing', on: [name ? at.tag(name) : at.group('tags')],
  });
}

async function deleteTag(name) {
  const remotes = state.refs.remoteNames;
  const r = await modal({
    title: 'Delete tag', ok: 'Delete', danger: true,
    message: `Delete the tag "${name}"?` + (remotes.length ? ' Deleting it from a remote affects everyone using that remote.' : ''),
    checks: remotes.map(rm => ({ label: `Also delete it from "${rm}"`, value: false })),
  });
  if (!r) return;
  const from = remotes.filter((_, i) => r.checks[i]);
  // The remotes go first: if one fails, the local tag is still there to try again.
  run('Delete tag', async () => {
    for (const rm of from) await g(['push', rm, '--delete', `refs/tags/${name}`]);
    await g(['tag', '-d', name]);
  }, { success: from.length ? `Tag "${name}" deleted here and from ${from.map(rm => `"${rm}"`).join(', ')}` : null, busy: 'Deleting', on: [at.tag(name)] });
}

async function deleteRemoteTag(name, remote) {
  if (!(await confirmBox('Delete remote tag', `Delete the tag "${name}" on "${remote}"? This affects everyone using the remote. The local tag is kept.`))) return;
  run('Delete remote tag', () => g(['push', remote, '--delete', `refs/tags/${name}`]), { success: `Tag "${name}" deleted from "${remote}"`, busy: 'Deleting', on: [at.tag(name)] });
}

async function renameBranch(name) {
  const r = await modal({ title: 'Rename branch', input: name, ok: 'Rename' });
  if (!r || r.value === name) return;
  run('Rename', () => g(['branch', '-m', name, r.value.replace(/\s+/g, '-')]), { busy: 'Renaming', on: [at.branch(name)] });
}

// Its remote branch (the upstream, when it still exists) can be deleted along with it.
async function deleteBranch(name) {
  const info = state.refs.local.find(b => b.name === name);
  const up = info?.upstream && !info.gone ? splitRemote(info.upstream) : null;
  const r = await modal({
    title: 'Delete branch', message: `Delete the local branch "${name}"?`, ok: 'Delete', danger: true,
    checks: [
      { label: 'Force (even if not merged)', value: false },
      ...(up ? [{ label: `Also delete "${info.upstream}" from the remote`, value: false, hint: 'This affects everyone using the remote.' }] : []),
    ],
  });
  if (!r) return;
  const [force, remoteToo] = r.checks;
  run('Delete branch', async () => {
    await g(['branch', force ? '-D' : '-d', name]);
    if (remoteToo) await g(['push', up[0], '--delete', `refs/heads/${up[1]}`]);
  }, { success: remoteToo ? `"${name}" deleted here and on "${up[0]}"` : null, busy: 'Deleting', on: [at.branch(name), remoteToo && at.remoteBranch(info.upstream)] });
}

async function deleteRemoteBranch(remote, name) {
  if (!(await confirmBox('Delete remote branch', `Delete "${name}" on "${remote}"? This affects everyone using the remote.`))) return;
  run('Delete remote branch', () => g(['push', remote, '--delete', `refs/heads/${name}`]), { success: 'Remote branch deleted', busy: 'Deleting', on: [at.remoteBranch(`${remote}/${name}`)] });
}

// Splits "origin/feature/x" into its remote and branch name, or gives null when it names no
// remote (the upstream of a branch can be another local branch).
function splitRemote(full) {
  const rm = state.refs?.remoteNames.find(r => full.startsWith(r + '/'));
  return rm ? [rm, full.slice(rm.length + 1)] : null;
}

// The remote of the current branch's upstream, or else the first one.
function mainRemote() {
  return (state.status?.upstream && splitRemote(state.status.upstream)?.[0]) || state.refs?.remoteNames[0];
}

async function mergeRef(ref) {
  if (!(await confirmBox('Merge', `Merge "${ref}" into "${state.status.branch}"?`, 'Merge', false))) return;
  run('Merge', () => g(['merge', '--no-edit', ref]), { busy: 'Merging', on: [at.current(), at.ref(ref)], mayConflict: true });
}

async function rebaseOnto(ref) {
  if (!(await confirmBox('Rebase', `Rebase "${state.status.branch}" onto "${ref}"?`, 'Rebase', false))) return;
  run('Rebase', () => g(['rebase', ref]), { busy: 'Rebasing', on: [at.current(), at.ref(ref)], mayConflict: true });
}

// =====================================================================
// Submodules
// =====================================================================

const cloned = sub => sub && sub.state !== 'uninitialized';

function openSubmodule(path) {
  const sub = state.submodules.find(s => s.path === path);
  if (!sub) return;
  // An empty submodule folder would open the parent repository instead
  if (!cloned(sub)) return toast(`"${path}" is not cloned yet — update it first`, 'error');
  openRepo(`${state.repo}/${path}`);
}

// Checks out the commit recorded in this repository (cloning the submodules not cloned yet),
// or with `remote` the latest commit of each submodule's remote branch.
async function updateSubmodules(subs = state.submodules, { remote = false } = {}) {
  if (!subs.length) return;
  const all = subs === state.submodules;
  const moved = subs.filter(s => s.state === 'changed');
  if (!remote && moved.length) {
    const what = moved.length === 1 ? `"${moved[0].path}" has` : `${plural(moved.length, 'submodule')} have`;
    const ok = await confirmBox('Update submodules',
      `${what} a different commit checked out than the one recorded in this repository. Check out the recorded commit instead? Uncommitted changes inside are kept.`,
      'Update', false);
    if (!ok) return;
  }
  const args = ['submodule', 'update', '--init', '--recursive', ...(remote ? ['--remote'] : []), ...(all ? [] : ['--', ...subs.map(s => s.path)])];
  run(remote ? 'Update from remote' : 'Update submodules', () => g(args), {
    success: remote ? 'Submodules moved to their latest remote commits — commit to record them' : 'Submodules updated',
    busy: remote ? 'Fetching' : 'Updating',
    on: all ? [at.group('submodules'), at.allSubmodules()] : subs.map(s => at.submodule(s.path)),
  });
}

async function addSubmodule() {
  const r = await modal({
    title: 'Add submodule',
    message: 'Clones a repository into a folder of this one and records which of its commits this repository uses.',
    fields: [
      { label: 'Repository URL', placeholder: 'https://github.com/owner/repo.git' },
      { label: 'Folder', placeholder: 'Named after the repository if left empty', optional: true },
    ],
    ok: 'Add submodule',
  });
  if (!r) return;
  const [url, folder] = r.values;
  const path = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  run('Add submodule', () => g(['submodule', 'add', '--', url, ...(path ? [path] : [])]), {
    success: 'Submodule added — commit to record it', busy: 'Cloning', on: [at.group('submodules')],
  });
}

// `git rm -f` is needed for a submodule added but not committed yet; work inside the
// submodule is checked first, since -f would delete it too.
async function removeSubmodule(sub) {
  const inside = state.status.unstaged.find(f => f.path === sub.path)?.submodule;
  if (inside?.modified || inside?.untracked) {
    return toast(`"${sub.path}" has uncommitted changes — commit or discard them inside the submodule first`, 'error');
  }
  const ok = await confirmBox('Remove submodule',
    `Remove the submodule "${sub.path}"? Its folder is deleted (its clone stays in .git/modules) and the removal is staged for commit.`,
    'Remove');
  if (ok) run('Remove submodule', () => g(['rm', '-f', '--', sub.path]), { success: `Submodule "${sub.path}" removed — commit to record it`, busy: 'Removing', on: [at.submodule(sub.path)] });
}

function submoduleMenu(x, y, sub) {
  if (!sub) return;
  showMenu(x, y, [
    { label: 'Open in a new tab', disabled: !cloned(sub), run: () => openSubmodule(sub.path) },
    { label: cloned(sub) ? 'Update to the recorded commit' : 'Clone and check out', run: () => updateSubmodules([sub]) },
    { label: 'Update to the latest remote commit', run: () => updateSubmodules([sub], { remote: true }) },
    '-',
    { label: 'Open terminal here', disabled: !cloned(sub), run: () => invoke('open_terminal', { repo: `${state.repo}/${sub.path}` }).catch(err => toast('Open terminal failed', 'error', String(err))) },
    { label: 'Copy path', run: () => copy(sub.path) },
    { label: 'Copy URL', disabled: !sub.url, run: () => copy(sub.url) },
    '-',
    { label: 'Remove submodule…', danger: true, run: () => removeSubmodule(sub) },
  ]);
}

const submodulesMenuItems = () => [
  { label: 'Add submodule…', run: addSubmodule },
  { label: 'Update all submodules', disabled: !state.submodules.length, run: () => updateSubmodules() },
  { label: 'Update all to their latest remote commits', disabled: !state.submodules.length, run: () => updateSubmodules(state.submodules, { remote: true }) },
];

// =====================================================================
// Git LFS
// =====================================================================

// Without `patterns`, asks for one. Files already staged are staged again so that they
// go through LFS.
async function trackLfs(patterns = null, restage = []) {
  if (!patterns) {
    const r = await modal({
      title: 'Track files with Git LFS',
      message: 'Files matching the pattern are stored with Git LFS from now on. The pattern goes into .gitattributes — commit it to share it.',
      input: '', placeholder: '*.psd', ok: 'Track',
    });
    if (!r) return;
    patterns = [r.value];
  }
  const what = patterns.length === 1 ? `"${patterns[0]}"` : plural(patterns.length, 'pattern');
  run('Track with LFS', async () => {
    await g(['lfs', 'track', '--', ...patterns]);
    if (restage.length) await gitPaths(['add', '--renormalize'], restage);
  }, { success: `Tracking ${what} with Git LFS — commit .gitattributes to share it`, busy: 'Updating .gitattributes', on: [at.group('lfs')] });
}

function untrackLfs(pattern) {
  run('Stop tracking with LFS', () => g(['lfs', 'untrack', '--', pattern]), {
    success: `"${pattern}" removed from .gitattributes — files already stored with LFS stay there`, busy: 'Updating .gitattributes', on: [at.group('lfs')],
  });
}

async function lfsCommand(cmd) {
  if (cmd === 'prune' && !(await confirmBox('Prune LFS files',
    'Delete the local copies of old LFS files that are already on the server? The files of the current checkout and of recent commits are kept.', 'Prune'))) return;
  const opts = {
    pull: ['Pull LFS files', 'Downloading', 'LFS files downloaded'],
    fetch: ['Fetch LFS files', 'Fetching', 'LFS files fetched'],
    prune: ['Prune LFS files', 'Pruning', 'Old LFS files pruned'],
    install: ['Set up Git LFS', 'Setting up', 'Git LFS hooks set up in this repository'],
  }[cmd];
  run(opts[0], () => g(['lfs', cmd, ...(cmd === 'install' ? ['--local'] : [])]), { busy: opts[1], success: opts[2], on: [at.group('lfs')] });
}

function lfsMenuItems() {
  const off = !state.lfs?.installed;
  return [
    { label: 'Track files with Git LFS…', disabled: off, run: () => trackLfs() },
    { label: 'Download LFS files (pull)', disabled: off, run: () => lfsCommand('pull') },
    { label: 'Fetch LFS files', disabled: off, run: () => lfsCommand('fetch') },
    { label: 'Set up LFS hooks in this repository', disabled: off, run: () => lfsCommand('install') },
    '-',
    { label: 'Prune old LFS files…', danger: true, disabled: off, run: () => lfsCommand('prune') },
  ];
}

function groupAction(act) {
  ({
    'add-submodule': addSubmodule,
    'update-submodules': () => updateSubmodules(),
    'lfs-pull': () => lfsCommand('pull'),
    'lfs-track': () => trackLfs(),
    'push-tags': () => pushTags(mainRemote()),
    'branch-tree': () => { state.branchTree = !state.branchTree; store('branchTree', state.branchTree); renderSidebar(); },
  })[act]?.();
}

const openTerminal = path => run('Open terminal', () => invoke('open_terminal', { repo: path }), { reload: false, busy: 'Opening terminal', on: [at.action('terminal')] });

const actions = {
  fetch: () => run('Fetch', () => g(['fetch', '--all', '--prune']), { success: 'Fetch complete', busy: 'Fetching', on: [at.action('fetch'), at.allRemotes()] }),
  pull: () => run('Pull', () => g(['pull']), { success: 'Pull complete', busy: 'Pulling', on: [at.action('pull'), at.current()], mayConflict: true }),
  push: async () => {
    const s = state.status;
    if (s.detached) return toast('Detached HEAD — check out a branch to push', 'error');
    const remote = mainRemote();
    if (!s.upstream && !remote) return toast('No remote configured', 'error');
    const target = s.upstream || `${remote}/${s.branch}`;
    const message = s.upstream
      ? `Push "${s.branch}" to "${target}"` + (s.ahead ? ` (${s.ahead} commit${s.ahead > 1 ? 's' : ''}).` : '.')
      : `"${s.branch}" has no upstream yet. Publish it to "${target}" and start tracking it.`;
    // Pushing tags is remembered; the force push toggle always starts off.
    const r = await modal({
      title: 'Push', message, ok: 'Push',
      checks: [
        ...(remote ? [{ label: `Also push all tags to "${remote}"`, value: !!store('pushTags'), toggle: true }] : []),
        { label: 'Force push', value: false, toggle: true, dangerOk: 'Force push', hint: 'Overwrites the remote branch (uses --force-with-lease: fails if someone pushed commits you don\'t have yet).' },
      ],
    });
    if (!r) return;
    const [tags, forced] = remote ? r.checks : [false, ...r.checks];
    if (remote) store('pushTags', tags);
    const force = forced ? ['--force-with-lease'] : [];
    const args = s.upstream ? ['push', ...force] : ['push', ...force, '-u', remote, 'HEAD'];
    // Tags go in a second push, never forced: a tag that already exists on the remote is kept.
    run(forced ? 'Force push' : 'Push', async () => {
      await g(args);
      if (tags) await g(['push', remote, '--tags']);
    }, {
      success: s.upstream ? 'Push complete' : 'Branch published',
      busy: forced ? 'Force pushing' : s.upstream ? 'Pushing' : 'Publishing',
      on: [at.action('push'), at.current(), s.upstream && at.remoteBranch(s.upstream), tags && at.group('tags')],
    });
  },
  // In the explorer, the terminal opens in the folder being shown
  terminal: () => openTerminal(state.mode === 'explorer' ? explorerFolder() : state.repo),
  branch: () => createBranch(null),
  stash: async () => {
    const r = await modal({ title: 'Stash', message: 'Save all local changes (including untracked files).', input: '', placeholder: 'Description (optional)', allowEmpty: true, ok: 'Stash' });
    if (!r) return;
    run('Stash', () => g(['stash', 'push', '-u', ...(r.value ? ['-m', r.value] : [])]), { busy: 'Stashing', on: [at.action('stash'), at.allFiles('unstaged'), at.allFiles('staged')] });
  },
  pop: () => {
    if (!state.stashes.length) return toast('No stash to apply');
    run('Pop', () => g(['stash', 'pop']), { busy: 'Popping', on: [at.action('pop'), at.stash('stash@{0}')], mayConflict: true });
  },
  refresh: () => refresh(),
};

// =====================================================================
// Resizable splitters
// =====================================================================

function bindSplitters(root) {
  root.querySelectorAll('.splitter[data-split]').forEach(sp => makeSplitter(sp, sp.dataset.split));
}

function makeSplitter(sp, key) {
  const vertical = sp.classList.contains('v');
  // Resizes the element before the splitter, or the one after it with data-target="next".
  const next = sp.dataset.target === 'next';
  const target = next ? sp.nextElementSibling : sp.previousElementSibling;
  const sign = next ? -1 : 1, min = +sp.dataset.min || 140;
  const saved = store('split.' + key);
  if (saved) target.style[vertical ? 'width' : 'height'] = saved + 'px';
  sp.addEventListener('mousedown', e => {
    e.preventDefault();
    const start = vertical ? e.clientX : e.clientY;
    const startSize = vertical ? target.offsetWidth : target.offsetHeight;
    const parent = target.parentElement;
    const max = (vertical ? parent.clientWidth : parent.clientHeight) - 120;
    sp.classList.add('dragging');
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    const move = ev => {
      const size = Math.max(min, Math.min(max, startSize + sign * ((vertical ? ev.clientX : ev.clientY) - start)));
      target.style[vertical ? 'width' : 'height'] = size + 'px';
    };
    const up = () => {
      sp.classList.remove('dragging');
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      store('split.' + key, vertical ? target.offsetWidth : target.offsetHeight);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// =====================================================================
// Startup
// =====================================================================

function initToolbar() {
  const iconsFor = { fetch: 'fetch', pull: 'pull', push: 'push', terminal: 'terminal', branch: 'branch', stash: 'stash', pop: 'pop', refresh: 'refresh' };
  document.querySelectorAll('#toolbar [data-action]').forEach(b => {
    b.insertAdjacentHTML('afterbegin', icon(iconsFor[b.dataset.action]));
    b.addEventListener('click', () => actions[b.dataset.action]());
  });
  $('.repo-glyph').innerHTML = icon('folder');
  $('.repo-chev').innerHTML = icon('down');
  $('.sb-filter .filter-icon').outerHTML = icon('search');
  $('#repo-btn').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    const repoItems = state.plain ? [{ label: 'Initialize Git repository…', run: initRepo }] : [
      { label: 'Add submodule…', run: addSubmodule },
      { label: 'Update submodules', disabled: !state.submodules.length, run: () => updateSubmodules() },
      ...(state.lfs?.installed ? [{ label: 'Track files with Git LFS…', run: () => trackLfs() }] : []),
    ];
    const project = currentProject();
    if (!desktop) return showMenu(r.left, r.bottom + 4, project ? projectMenuItems(project).slice(2) : [{ label: 'New project…', run: newProject }]);
    newTabMenu(r.left, r.bottom + 4, state.repo ? ['-', ...repoItems, '-', { label: 'Close tab', run: () => closeTab() }]
      : project ? ['-', ...projectMenuItems(project).slice(2)] : []);
  });
  document.querySelectorAll('#mode-toggle [data-mode]').forEach(b => {
    b.insertAdjacentHTML('afterbegin', icon(b.dataset.mode === 'git' ? 'branch' : 'folder'));
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  bindTabs();

  const sbZoom = $('#sb-zoom');
  const showZoom = z => (sbZoom.textContent = Math.round(z * 100) + '%');
  showZoom(getZoom());
  onZoom(showZoom);
  sbZoom.addEventListener('click', resetZoom);

  makeSplitter($('#split-sidebar'), 'sidebar');
}

function initKeys() {
  window.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    // on the web, only Alt+1… (the spaces) and Escape: there are no folders or notes, and F5 reloads the page
    if (!desktop && !(e.altKey && !ctrl) && e.key !== 'Escape') return;
    if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) { e.preventDefault(); refresh(); }
    else if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openRepoDialog(); }
    else if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); showNewTabMenu(); }
    else if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); if (activeKey()) closeTab(); }
    else if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote({ space: tabs.space, open: 'tab' }); }
    else if (ctrl && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault();
      cycleTab(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
    }
    else if (ctrl && e.key.toLowerCase() === 'f' && state.repo) {
      // Ctrl+F searches the explorer, filters files in Local changes and branches everywhere else
      e.preventDefault();
      if (state.mode === 'explorer') return focusExplorerSearch();
      const input = (state.view === 'changes' && $('#file-filter')) || $('#branch-filter');
      input.focus();
      input.select();
    }
    else if (ctrl && e.key.toLowerCase() === 'e' && state.repo) { e.preventDefault(); setMode(state.mode === 'git' ? 'explorer' : 'git'); }
    else if (ctrl && e.key === '1' && state.repo) { e.preventDefault(); setView('changes'); }
    else if (ctrl && e.key === '2' && state.repo) { e.preventDefault(); setView('history'); }
    else if (e.altKey && !ctrl && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); switchToNth(+e.code.slice(5) - 1); }
    else if (e.key === 'Escape') {
      if (!$('#menu').hidden) hideMenu();
      else if (!e.target.closest?.('input, textarea, .modal')) clearLines();
    }
  });
  // Native context menu only in text areas
  window.addEventListener('contextmenu', e => {
    if (!e.target.closest('input, textarea, .diff, .commit-meta, .exd-info, .toast')) e.preventDefault();
  });
  // Refresh when the window regains focus (picks up changes made in the editor)
  window.addEventListener('focus', debounce(() => refresh(), 150));
}

initZoom();
initToolbar();
initKeys();
initExplorer({
  repo: () => state.repo,
  plain: () => state.plain,
  status: () => state.status,
  submodules: () => state.submodules,
  head: headSha,
  toast, showMenu, copy, bindSplitters, saveSoon, revealCommit, revealChange,
  terminal: openTerminal,
});
initDashboard({
  open: path => openRepo(path),
  pickFolders, toast, showMenu, modal, copy, renameProject,
  changed: projectsChanged,
  renderNotes: (el, id) => renderNotesPanel(el, id),
});
bindRail();

// Opens what a mention in a note points to: a file in the explorer, a commit or a branch in the history.
async function revealMention({ kind, id, repo }) {
  if (!desktop) return toast('Files, commits and branches open in the desktop app, which has the folders');
  if (!repo || !(await isFolder(repo))) return toast('Folder not found', 'error', repo || '');
  await openRepo(repo);
  if (kind === 'file') {
    if (state.mode !== 'explorer') setMode('explorer');
    revealPath(id);
  } else if (kind === 'commit') {
    if (!state.plain) revealCommit(id);
  } else if (kind === 'branch') {
    if (!state.plain) revealRef(id);
  }
}

S.onNotesChange(() => {
  renderTabs();
  if (state.note) renderToolbar();
});

P.onProjectsChange(projectsChangedElsewhere);
onSyncStatus(() => { paintAccount(); M.paintBar(); });

// The phone's screens (see mobile.js): going to one shows its space and its note, or its pinned page.
M.initMobile({
  screen: () => ({ space: tabs.space, note: state.note }),
  go: async ({ space, note }) => {
    if (space !== tabs.space) await switchSpace(space === 'home' || P.getProject(space) ? space : 'home');
    if (note && S.getNote(note)) openNoteTab(note);
    else if (activeKey()) showHome();
  },
  noteTitle, noteIcon,
  noteMenu: id => noteMenuItems(id, 'tab'),
  projectMenu: p => (p ? projectMenuItems(p).slice(2) : []),
  accountButton, accountMenu, newProject,
  newPage: space => newNote({ space, open: 'tab' }),
  renderNotes: (el, space) => renderNotesPanel(el, space),
  showMenu, toast,
});
// Turning a window into a phone's (or back): no peeks there, and Home is drawn for it.
onMobileChange(() => {
  closePeek();
  if (!activeKey()) renderHome();
  M.paintBar();
});
onAccount(accountChanged);

(async () => {
  P.useAccount(await initAccount().catch(e => { toast('Could not reach your account', 'error', String(e.message || e)); return null; }));
  applyGate();
  if (signInFailure()) toast('Could not sign in — try again', 'error', signInFailure());
  await initNotesUi({
    space: () => tabs.space,
    spaceName: id => P.getProject(id)?.name || 'Home',
    spaces: () => ['home', ...P.listProjects().map(p => p.id)],
    // (the web page has no folders to mention or to take branches from)
    folders: () => (!desktop ? [] : currentProject()?.folders.map(f => f.path) ?? tabs.list.filter(k => !noteOf(k))),
    activeNote: () => state.note,
    openTab: (id, opts) => openNoteTab(id, opts),
    closeTabs: closeNoteTabs,
    reveal: revealMention,
    // a branch was created from a note: the repository's tab shows it
    gitChanged: repo => { if (state.repo === repo) refresh(); },
    toast, showMenu, modal, confirmBox, copy, pickFolders,
  }).catch(e => toast('Could not load the notes', 'error', String(e.message || e)));
  await restoreSpaces();
})().catch(() => { renderRail(); showHome(); });
