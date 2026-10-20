// The views of a database (its items), like in Notion: a list (the tree), a table (a spreadsheet of
// the items and their properties) or a board (kanban: a column per option of a select property,
// cards dragged between them). Also the properties block of an item's page, which shares the
// value editors with the table.
// A Branch property links a note to a branch of one of the space's repositories (notes as tasks).
import * as S from './notes-store.js?v=8088795';
import * as G from './git.js?v=8088795';
import { esc, icon, folderName } from './util.js?v=8088795';
import { desktop } from './platform.js?v=8088795';
import { pickEmoji } from './emoji.js?v=8088795';

const $ = (sel, root = document) => root.querySelector(sel);

// Callbacks into the notes UI (see initViews).
let host = null;

// `h`: { mountTree(el, space, { parent, open }), noteMenu(id), deleteNotes(ids), folders() (of the
// current space), reveal({ kind: 'branch', id, repo }), gitChanged(repo), showMenu, modal, confirmBox, toast }.
export function initViews(h) {
  host = h;
  // Delete removes the selected notes (after asking), Escape clears the selection
  addEventListener('keydown', e => {
    if (e.defaultPrevented || e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    if ($('#modal-root').childElementCount || !$('#menu').hidden || picker) return;
    const c = [...mounted].find(x => x.el.isConnected && x.sel?.size);
    if (!c) return;
    // (Escape is taken here, so it doesn't also close a peek)
    if (e.key === 'Escape') { e.preventDefault(); select(c, []); }
    else if (e.key === 'Delete') { e.preventDefault(); host.deleteNotes(selection(c)); }
  });
}

export const TYPES = {
  text: ['Text', 'text'], number: ['Number', 'hash'], select: ['Select', 'select'], multi: ['Multi-select', 'tags'],
  date: ['Date', 'calendar'], checkbox: ['Checkbox', 'checkbox'], url: ['URL', 'link'], branch: ['Branch', 'branch'],
};
const VIEWS = { list: ['List', 'list'], table: ['Table', 'table'], board: ['Board', 'board'] };
const COLOR_NAMES = { gray: 'Gray', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red' };
const hasOptions = p => p.type === 'select' || p.type === 'multi';
const activeView = col => col.views.find(v => v.id === col.active) || col.views[0];
const propOf = (key, id) => S.getCollection(key).schema.find(p => p.id === id) || null;

// While a value or a title is being typed, repaints wait (they would throw the input away).
const editing = el => {
  const a = document.activeElement;
  return !!a && el.contains(a) && a.matches('input:not([data-done]), textarea');
};

// An input that edits a value in place: Enter or a click elsewhere saves, Escape cancels.
// `save(text)` is called when it was changed; the views repaint either way.
function inlineInput(cell, input, initial, save) {
  cell.classList.add('editing');
  cell.replaceChildren(input);
  input.focus();
  if (input.type === 'text') input.select();
  const finish = keep => {
    if (input.dataset.done) return;
    input.dataset.done = '1';
    input.blur();
    if (keep && input.value.trim() !== initial) save(input.value.trim());
    else repaintViews();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// =====================================================================
// Values
// =====================================================================

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const chip = o => `<span class="opt c-${o.color || 'none'}">${esc(o.name)}</span>`;
const checkHtml = v => `<span class="cbx ${v ? 'on' : ''}">${v ? icon('check') : ''}</span>`;

export function valueHtml(p, v) {
  if (p.type === 'checkbox') return checkHtml(v);
  if (v == null || v === '') return '';
  switch (p.type) {
    case 'select': { const o = p.options.find(x => x.id === v); return o ? chip(o) : ''; }
    case 'multi': return [].concat(v).map(id => p.options.find(o => o.id === id)).filter(Boolean).map(chip).join('');
    case 'date': return esc(dateFmt.format(new Date(v + 'T00:00')));
    case 'number': return esc(Number(v).toLocaleString('en-US', { maximumFractionDigits: 10 }));
    case 'url': return `<span class="pv-url">${esc(v)}</span>`;
    case 'branch': return branchHtml(v);
    default: return esc(v);
  }
}

// The value as plain text (Markdown export): options by name, checkboxes as true, branches by name.
export function valueText(p, v) {
  if (v == null) return null;
  if (p.type === 'select') return p.options.find(o => o.id === v)?.name ?? null;
  if (p.type === 'multi') return [].concat(v).map(id => p.options.find(o => o.id === id)?.name).filter(Boolean);
  if (p.type === 'branch') return v.name;
  return v;
}

// Edits a note's value of a property in place: checkboxes toggle, options and branches open a
// picker, the rest becomes an input until Enter, Escape or a click elsewhere.
function editValue(cell, id, p) {
  const v = S.getNote(id)?.props?.[p.id];
  if (p.type === 'checkbox') return S.setProp(id, p.id, !v);
  if (hasOptions(p)) return optionPicker(cell, S.collectionOf(id), p.id, id);
  if (p.type === 'branch') return branchPicker(cell, p.id, id);
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.type = p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text';
  input.spellcheck = false;
  input.value = v ?? '';
  inlineInput(cell, input, String(v ?? ''), text => {
    const val = p.type !== 'number' ? text : text === '' || !Number.isFinite(Number(text)) ? null : Number(text);
    S.setProp(id, p.id, val);
  });
}

// A note's title edited in a table cell.
function editTitle(cell, id) {
  const n = S.getNote(id);
  if (!n) return;
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.spellcheck = false;
  input.placeholder = 'Untitled';
  input.value = n.title;
  inlineInput(cell, input, n.title, text => S.renameNote(id, text));
}

// ---------- the option picker of select and multi-select values ----------

let picker = null;

function closePicker() {
  if (!picker) return;
  picker.el.remove();
  removeEventListener('mousedown', picker.outside, true);
  picker = null;
}

// A picker below `anchor`: a search box and a list. It closes on Escape or a click elsewhere.
function popup(anchor, placeholder) {
  closePicker();
  const el = document.createElement('div');
  el.className = 'opt-pop';
  el.innerHTML = `<input class="opt-q" placeholder="${esc(placeholder)}" spellcheck="false"><div class="opt-list"></div>`;
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(r.left, innerWidth - el.offsetWidth - 6)) + 'px';
  el.style.top = (r.bottom + 4 + 300 < innerHeight ? r.bottom + 4 : Math.max(6, r.top - 4 - 300)) + 'px';
  const outside = e => { if (!el.contains(e.target) && !e.target.closest('#menu, .modal-back')) closePicker(); };
  addEventListener('mousedown', outside, true);
  picker = { el, outside };
  $('.opt-q', el).focus();
  return el;
}

// Sets values on several notes at once (the views repaint once).
const setAll = (ids, propId, valueOf) => S.batch(() => ids.forEach(id => S.setProp(id, propId, valueOf(id))));

// `ids`: one note, or the selected notes (an option is checked when all of them have it).
function optionPicker(anchor, key, propId, ids) {
  ids = [].concat(ids);
  const el = popup(anchor, 'Search for an option, or create one');
  const q = $('.opt-q', el);
  let shown = [];
  const valueOf = id => [].concat(S.getNote(id)?.props?.[propId] ?? []);
  const has = optId => ids.every(id => valueOf(id).includes(optId));

  const paint = () => {
    const p = propOf(key, propId);
    if (!p) return closePicker();
    const text = q.value.trim(), t = text.toLowerCase();
    shown = p.options.filter(o => o.name.toLowerCase().includes(t));
    const exact = p.options.some(o => o.name.toLowerCase() === t);
    $('.opt-list', el).innerHTML = (ids.length > 1 ? `<div class="opt-hint">For ${ids.length} notes</div>` : '')
      + shown.map(o => `<div class="opt-item ${has(o.id) ? 'on' : ''}" data-opt="${o.id}">
        ${chip(o)}<span class="spacer"></span>${has(o.id) ? icon('check') : ''}<button class="opt-more" data-more="${o.id}" title="Edit option">${icon('more')}</button></div>`).join('')
      + (text && !exact ? `<div class="opt-item opt-create" data-create>Create ${chip({ name: text, color: S.OPTION_COLORS[p.options.length % S.OPTION_COLORS.length] })}</div>` : '')
      + (!text && !p.options.length ? '<div class="opt-hint">Type to create the first option</div>' : '')
      + (ids.some(id => valueOf(id).length) ? '<div class="opt-item opt-clear" data-clear>Clear</div>' : '');
  };

  const pick = async optId => {
    const p = propOf(key, propId);
    if (p.type === 'select') {
      closePicker();
      return setAll(ids, propId, () => optId);
    }
    // multi-select: added to every note, or taken from every note when they all have it
    const all = has(optId);
    await setAll(ids, propId, id => (all ? valueOf(id).filter(x => x !== optId) : [...new Set([...valueOf(id), optId])]));
    q.value = '';
    paint();
  };
  const create = () => {
    const o = S.addOption(key, propId, q.value);
    if (o) pick(o.id);
  };

  el.addEventListener('mousedown', e => {
    if (e.target === q) return;
    e.preventDefault(); // keep typing in the search box
    const more = e.target.closest('[data-more]');
    if (more) {
      const rr = more.getBoundingClientRect();
      return host.showMenu(rr.right + 4, rr.top, optionMenuItems(key, propId, more.dataset.more, paint));
    }
    const it = e.target.closest('.opt-item');
    if (!it) return;
    if (it.dataset.opt) pick(it.dataset.opt);
    else if ('create' in it.dataset) create();
    else if ('clear' in it.dataset) { closePicker(); setAll(ids, propId, () => null); }
  });
  q.addEventListener('input', paint);
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const exact = shown.find(o => o.name.toLowerCase() === q.value.trim().toLowerCase());
      if (exact || shown.length === 1) pick((exact || shown[0]).id);
      else if (q.value.trim()) create();
    }
  });
  paint();
}

// Rename, color or delete an option (from the picker or a board column).
function optionMenuItems(key, propId, optId, after = () => {}) {
  const o = propOf(key, propId)?.options.find(x => x.id === optId);
  if (!o) return [];
  return [
    { label: 'Rename…', run: async () => { const r = await host.modal({ title: 'Rename option', input: o.name, ok: 'Rename' }); if (r) { S.updateOption(key, propId, optId, { name: r.value }); after(); } } },
    '-',
    ...S.OPTION_COLORS.map(c => ({ label: `${COLOR_NAMES[c]}${o.color === c ? '  ✓' : ''}`, run: () => { S.updateOption(key, propId, optId, { color: c }); after(); } })),
    '-',
    { label: 'Delete option…', danger: true, run: async () => {
      if (await host.confirmBox('Delete option', `Delete "${o.name}"? Notes that have it lose it.`, 'Delete')) { S.deleteOption(key, propId, optId); after(); }
    } },
  ];
}

// =====================================================================
// Branches
// =====================================================================

// The branches of each folder, read again after half a minute (null when it is not a repository).
const refsCache = new Map(); // folder -> { at, refs, promise }

function refsOf(repo, { fresh = false } = {}) {
  const c = refsCache.get(repo);
  if (c && !fresh && Date.now() - c.at < 30_000) return c.promise;
  const entry = { at: Date.now(), refs: c?.refs, promise: null };
  entry.promise = G.getRefs(repo).catch(() => null).then(refs => {
    const before = JSON.stringify(entry.refs ?? null);
    entry.refs = refs;
    if (JSON.stringify(refs) !== before) repaintViews();
    return refs;
  });
  refsCache.set(repo, entry);
  return entry.promise;
}

// What is known now (the views repaint when a read finishes). The web page has no Git: nothing.
function knownRefs(repo) {
  if (!desktop) return undefined;
  refsOf(repo);
  return refsCache.get(repo)?.refs;
}

// The branch with its state: checked out, commits to push and to pull, or gone. A click on it
// opens the repository at the branch.
function branchHtml(v) {
  const refs = knownRefs(v.repo);
  const b = refs?.local.find(x => x.name === v.name);
  const missing = refs !== undefined && !b;
  const state = b ? (b.current ? '<span class="brc-cur" title="Checked out"></span>' : '')
      + (b.ahead ? `<span class="up" title="Commits to push">↑${b.ahead}</span>` : '')
      + (b.behind ? `<span class="dn" title="Commits to pull">↓${b.behind}</span>` : '')
      + (b.gone ? '<span class="bad" title="Its upstream was deleted">gone</span>' : '')
    : missing ? '<span class="bad">not found</span>' : '';
  const title = `${v.name} in ${folderName(v.repo)}${b?.upstream ? `, tracking ${b.upstream}` : ''}${b?.current ? ' (checked out)' : ''}`;
  const multi = host.folders().length > 1;
  return `<span class="brc ${missing ? 'missing' : ''}" data-repo="${esc(v.repo)}" data-branch="${esc(v.name)}" title="${esc(title)}">`
    + `${icon('branch')}<span class="brc-name">${esc(v.name)}</span>${multi ? `<span class="brc-repo">${esc(folderName(v.repo))}</span>` : ''}${state}</span>`;
}

// A click on a branch chip opens it; returns whether it was one.
function openBranchChip(e) {
  const chip = e.target.closest('.brc');
  if (!chip) return false;
  e.stopPropagation();
  host.reveal({ kind: 'branch', id: chip.dataset.branch, repo: chip.dataset.repo });
  return true;
}

// The local branches of the space's repositories, to pick the one a note (or the selected notes)
// is about. Creating a branch is offered for one note only.
async function branchPicker(anchor, propId, ids) {
  ids = [].concat(ids);
  const id = ids[0];
  closePicker();
  const el = popup(anchor, 'Search for a branch');
  const q = $('.opt-q', el);
  if (!desktop) {
    $('.opt-list', el).innerHTML = '<div class="opt-hint">Branches are picked in the desktop app, which has the repositories</div>';
    return;
  }
  $('.opt-list', el).innerHTML = '<div class="opt-hint">Reading the branches…</div>';
  const repos = (await Promise.all(host.folders().map(async f => ({ repo: f, refs: await refsOf(f) })))).filter(r => r.refs);
  if (picker?.el !== el) return;
  const multi = repos.length > 1;
  let shown = [];
  const paint = () => {
    const vals = ids.map(x => S.getNote(x)?.props?.[propId]);
    const t = q.value.trim().toLowerCase();
    shown = repos.flatMap(({ repo, refs }) => refs.local.filter(b => b.name.toLowerCase().includes(t)).map(b => ({ repo, b })));
    let last = null;
    $('.opt-list', el).innerHTML = (ids.length > 1 ? `<div class="opt-hint">For ${ids.length} notes</div>` : `<div class="opt-item opt-create" data-create>${icon('plus')}Create a branch from this note…</div>`)
      + shown.map(({ repo, b }, i) => {
        const head = multi && repo !== last ? `<div class="opt-group">${esc(folderName(repo))}</div>` : '';
        last = repo;
        const on = vals.every(v => v?.repo === repo && v?.name === b.name);
        return `${head}<div class="opt-item ${on ? 'on' : ''}" data-i="${i}">${icon('branch')}<span class="opt-branch">${esc(b.name)}</span>
          ${b.current ? '<span class="brc-cur" title="Checked out"></span>' : ''}<span class="spacer"></span>${on ? icon('check') : ''}</div>`;
      }).join('')
      + (!repos.length ? '<div class="opt-hint">The folders of this space have no Git repositories</div>' : !shown.length ? '<div class="opt-hint">No branch matches</div>' : '')
      + (vals.some(Boolean) ? '<div class="opt-item opt-clear" data-clear>Clear</div>' : '');
  };
  const pick = i => {
    const { repo, b } = shown[i];
    closePicker();
    setAll(ids, propId, () => ({ repo, name: b.name }));
  };
  el.addEventListener('mousedown', e => {
    if (e.target === q) return;
    e.preventDefault();
    const it = e.target.closest('.opt-item');
    if (!it) return;
    if (it.dataset.i) pick(+it.dataset.i);
    else if ('create' in it.dataset) { const r = it.getBoundingClientRect(); closePicker(); createBranchFor(id, { propId, x: r.left, y: r.bottom }); }
    else if ('clear' in it.dataset) { closePicker(); setAll(ids, propId, () => null); }
  });
  q.addEventListener('input', paint);
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
    else if (e.key === 'Enter' && shown.length) { e.preventDefault(); pick(0); }
  });
  paint();
}

// "Fix login bug" -> "fix-login-bug".
const slug = title => title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

// Creates a branch for a note (named after its title, from the current HEAD of one of the space's
// repositories) and sets it as the note's Branch, adding that property when there is none yet.
// `x`, `y`: where to ask which repository, when there are several.
export async function createBranchFor(id, { propId = null, x = innerWidth / 2 - 120, y = 120 } = {}) {
  const n = S.getNote(id);
  if (!n) return;
  const repos = (await Promise.all(host.folders().map(async f => ((await refsOf(f)) ? f : null)))).filter(Boolean);
  if (!repos.length) return host.toast('The folders of this space have no Git repositories', 'warn');
  const repo = repos.length === 1 ? repos[0]
    : await new Promise(resolve => host.showMenu(x, y, repos.map(f => ({ label: `${folderName(f)}  —  ${f}`, run: () => resolve(f) }))));
  const current = (await refsOf(repo))?.local.find(b => b.current)?.name;
  const r = await host.modal({
    title: 'Create branch',
    message: `In ${folderName(repo)}, starting from ${current ? `"${current}"` : 'the current HEAD'}.`,
    input: `feature/${slug(n.title) || 'note-' + id.slice(0, 6)}`,
    check: { label: 'Check out the new branch', value: true, toggle: true },
    ok: 'Create branch',
  });
  if (!r) return;
  const name = r.value.replace(/\s+/g, '-');
  try {
    await G.git(repo, ['check-ref-format', '--branch', name]).catch(() => { throw new Error(`"${name}" is not a valid branch name`); });
    await G.git(repo, r.checked ? ['switch', '-c', name] : ['branch', name]);
  } catch (e) {
    return host.toast('Could not create the branch', 'error', String(e.message || e));
  }
  const key = S.collectionOf(id);
  const pid = propId || S.getCollection(key).schema.find(p => p.type === 'branch')?.id || S.addProperty(key, { name: 'Branch', type: 'branch' }).id;
  S.setProp(id, pid, { repo, name });
  host.toast(`Branch "${name}" created${r.checked ? ' and checked out' : ''}`, 'ok');
  refsOf(repo, { fresh: true });
  host.gitChanged(repo);
}

// =====================================================================
// Properties
// =====================================================================

// Picks a type, then a name, and adds the property to the collection.
function addProperty(x, y, key, then = () => {}) {
  host.showMenu(x, y, Object.entries(TYPES).map(([type, [name]]) => ({
    label: name,
    run: async () => {
      const r = await host.modal({ title: `New ${name.toLowerCase()} property`, input: name, ok: 'Add property' });
      if (r) then(S.addProperty(key, { name: r.value, type }));
    },
  })));
}

function propMenu(x, y, key, p, view = null) {
  const sortable = view?.type === 'table';
  const schema = S.getCollection(key).schema, at = schema.findIndex(q => q.id === p.id);
  host.showMenu(x, y, [
    { label: 'Rename…', run: async () => { const r = await host.modal({ title: 'Rename property', input: p.name, ok: 'Rename' }); if (r) S.renameProperty(key, p.id, r.value); } },
    // (the order is also dragged by the property's name, in a page)
    ...(at > 0 ? [{ label: 'Move up', run: () => S.moveProperty(key, p.id, schema[at - 1].id) }] : []),
    ...(at >= 0 && at < schema.length - 1 ? [{ label: 'Move down', run: () => S.moveProperty(key, p.id, schema[at + 2]?.id ?? null) }] : []),
    '-',
    ...Object.entries(TYPES).filter(([t]) => t !== p.type).map(([t, [name]]) => ({ label: `Change type to ${name}`, run: () => S.setPropertyType(key, p.id, t) })),
    ...(sortable ? ['-',
      { label: 'Sort ascending', run: () => S.updateView(key, view.id, { sort: { prop: p.id, dir: 1 } }) },
      { label: 'Sort descending', run: () => S.updateView(key, view.id, { sort: { prop: p.id, dir: -1 } }) },
      ...(view.sort ? [{ label: 'Clear sort', run: () => S.updateView(key, view.id, { sort: null }) }] : [])] : []),
    ...(view && view.type !== 'list' ? [{ label: 'Hide in this view', run: () => S.updateView(key, view.id, { hidden: [...(view.hidden || []), p.id] }) }] : []),
    '-',
    { label: 'Delete property…', danger: true, run: async () => {
      if (await host.confirmBox('Delete property', `Delete "${p.name}" and its values in every note it belongs to?`, 'Delete')) S.deleteProperty(key, p.id);
    } },
  ]);
}

// ---------- the properties of a note's page ----------

const blocks = new Set(); // { el, id, dirty }

// Properties come from the note's collection: adding one here adds it to the pages next to it too.
export function renderProps(el, id) {
  let b = [...blocks].find(x => x.el === el);
  if (!b) {
    b = { el, id };
    blocks.add(b);
    bindProps(b);
  }
  b.id = id;
  paintProps(b);
}

function paintProps(b) {
  if (editing(b.el)) { b.dirty = true; return; }
  b.dirty = false;
  // only the items of a database have properties: the database's
  const key = S.collectionOf(b.id), n = S.getNote(b.id);
  b.el.hidden = !key;
  if (!key || !n) { b.el.innerHTML = ''; return; }
  const schema = S.getCollection(key).schema;
  b.el.classList.toggle('has', schema.length > 0);
  b.el.innerHTML = schema.map(p => {
    const v = valueHtml(p, n.props?.[p.id]);
    return `<div class="pp-row" data-row="${p.id}"><button class="pp-name" data-pp="${p.id}" draggable="true" title="Drag to move it">${icon(TYPES[p.type][1])}<span>${esc(p.name)}</span></button>
      <div class="pp-val pt-${p.type}" data-prop="${p.id}">${v || '<span class="pp-empty">Empty</span>'}</div></div>`;
  }).join('') + `<button class="pp-add" title="Adds a property to the database (all its items)">${icon('plus')}Add a property</button>`;
}

function bindProps(b) {
  b.el.addEventListener('click', e => {
    if (openBranchChip(e)) return;
    const key = S.collectionOf(b.id);
    const val = e.target.closest('.pp-val'), name = e.target.closest('.pp-name'), add = e.target.closest('.pp-add');
    if (val) return editValue(val, b.id, propOf(key, val.dataset.prop));
    const r = (name || add)?.getBoundingClientRect();
    if (name) return propMenu(r.left, r.bottom + 4, key, propOf(key, name.dataset.pp));
    if (add) addProperty(r.left, r.bottom + 4, key);
  });
  // A property is dragged by its name to another place; a line shows where it will land.
  let dragging = null;
  const clear = () => b.el.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  const after = (row, e) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  b.el.addEventListener('dragstart', e => {
    const name = e.target.closest?.('.pp-name');
    if (!name) return;
    dragging = name.dataset.pp;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
  });
  b.el.addEventListener('dragover', e => {
    const row = dragging && e.target.closest('.pp-row');
    if (!row) return;
    e.preventDefault();
    clear();
    if (row.dataset.row !== dragging) row.classList.add(after(row, e) ? 'drop-after' : 'drop-before');
  });
  b.el.addEventListener('drop', e => {
    const row = dragging && e.target.closest('.pp-row');
    if (!row) return;
    e.preventDefault();
    const key = S.collectionOf(b.id), rows = [...b.el.querySelectorAll('.pp-row')];
    const before = after(row, e) ? rows[rows.indexOf(row) + 1]?.dataset.row ?? null : row.dataset.row;
    // (right before or after itself it stays where it is)
    if (row.dataset.row !== dragging && before !== dragging) S.moveProperty(key, dragging, before);
    dragging = null;
    clear();
  });
  b.el.addEventListener('dragend', () => { dragging = null; clear(); });
}

// =====================================================================
// Collections
// =====================================================================

const mounted = new Set(); // { el, space, parent, ctx, open(id, event), create(props, open), dirty }

// `opts`: { space, parent (the database), ctx ('inline' in a page's text, or 'page' on its own),
// open(id, event), create(props, open) -> note }.
export function renderCollection(el, opts) {
  let c = [...mounted].find(x => x.el === el);
  if (!c) {
    c = { el, sel: new Set() };
    mounted.add(c);
    bindCollection(c);
  }
  Object.assign(c, opts);
  paint(c);
}

// After notes or collections changed; the ones being typed in wait until the typing ends.
export function repaintViews() {
  for (const c of mounted) if (c.el.isConnected) paint(c); else mounted.delete(c);
  for (const b of blocks) if (b.el.isConnected) paintProps(b); else blocks.delete(b);
}

function paint(c) {
  if (editing(c.el)) { c.dirty = true; return; }
  c.dirty = false;
  const key = S.collectionKey(c.space, c.parent), col = S.getCollection(key), view = activeView(col);
  const notes = S.childrenOf(c.space, c.parent);
  c.el.innerHTML = `<div class="cv cv-${c.ctx}">
    <div class="cv-bar">
      <div class="cv-tabs">${col.views.map(v => `<button class="cv-tab ${v === view ? 'on' : ''}" data-view="${v.id}">${icon(v.icon || VIEWS[v.type][1])}<span>${esc(v.name)}</span></button>`).join('')}
        <button class="cv-btn" data-cv="add-view" title="Add a view">${icon('plus')}</button></div>
      <span class="spacer"></span>
      <button class="cv-btn" data-cv="view-menu" title="View options">${icon('more')}</button>
      <button class="btn-sm" data-cv="new">${icon('plus')}New</button>
    </div>
    <div class="cv-body cv-${view.type}"></div>
  </div>`;
  const body = $('.cv-body', c.el);
  if (view.type === 'list') {
    if (notes.length || c.ctx === 'panel') host.mountTree(body, c.space, { parent: c.parent, open: c.open });
    else body.innerHTML = '<div class="cv-empty">No sub-pages yet</div>';
  } else if (view.type === 'table') {
    body.innerHTML = tableHtml(col, view, notes);
  } else {
    body.innerHTML = boardHtml(col, view, notes);
  }
  // the selection keeps the notes that are still shown
  const here = new Set(view.type === 'list' ? [] : notes.map(n => n.id));
  c.sel = new Set([...(c.sel || [])].filter(id => here.has(id)));
  paintSelection(c);
}

// ---------- selection ----------

// Table rows and board cards can be selected (a box drawn from an empty spot, Shift+click, the
// row's check); the context menu, Delete and dragging then act on all of them.
const itemsOf = c => c.el.querySelectorAll('tr[data-note], .bd-card');

function paintSelection(c) {
  for (const it of itemsOf(c)) it.classList.toggle('selected', c.sel.has(it.dataset.note));
  const all = c.el.querySelector('[data-cv="select-all"]');
  const rows = c.el.querySelectorAll('tr[data-note]');
  all?.classList.toggle('on', !!rows.length && [...rows].every(r => c.sel.has(r.dataset.note)));
  c.el.querySelector('.cv')?.classList.toggle('has-sel', c.sel.size > 0);
}

function select(c, ids, { add = false } = {}) {
  c.sel = new Set([...(add ? c.sel : []), ...ids]);
  paintSelection(c);
}

function toggle(c, id) {
  if (c.sel.has(id)) c.sel.delete(id);
  else c.sel.add(id);
  paintSelection(c);
}

// The selected notes in the order they are shown.
const selection = c => [...itemsOf(c)].map(it => it.dataset.note).filter(id => c.sel.has(id));

// Draws a selection box from an empty spot of a table or a board; with Shift or Ctrl it adds to
// the selection. A click without a drag clears it.
function boxSelect(c, e) {
  const body = e.target.closest('.cv-body');
  if (e.button !== 0 || !body?.matches('.cv-table, .cv-board')) return;
  if (e.target.closest('.bd-card, td:not(.vt-fill), th, button, input, .bd-head, .bd-pin-row, a')) return;
  e.preventDefault();
  const add = e.shiftKey || e.ctrlKey || e.metaKey, base = add ? [...c.sel] : [];
  const x0 = e.clientX, y0 = e.clientY;
  const box = document.createElement('div');
  box.className = 'sel-box';
  let moved = false;
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    if (!moved) document.body.append(box);
    moved = true;
    const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY), r = Math.max(x0, ev.clientX), b = Math.max(y0, ev.clientY);
    Object.assign(box.style, { left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' });
    const hit = [...itemsOf(c)].filter(it => {
      const rr = it.getBoundingClientRect();
      return rr.left < r && rr.right > l && rr.top < b && rr.bottom > t;
    }).map(it => it.dataset.note);
    select(c, [...base, ...hit]);
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    box.remove();
    if (!moved && !add) select(c, []);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// The context menu of several notes: set a property on all of them, open or delete them.
function bulkMenu(c, x, y) {
  const ids = selection(c), key = S.collectionKey(c.space, c.parent), col = S.getCollection(key);
  host.showMenu(x, y, [
    { label: `${ids.length} notes selected`, disabled: true, run: () => {} },
    '-',
    ...col.schema.map(p => ({ label: `Set ${p.name}…`, run: () => bulkEdit(ids, key, p, x, y) })),
    ...(col.schema.length ? ['-'] : []),
    { label: `Open ${ids.length} notes in tabs`, run: () => ids.forEach(id => c.open(id, { ctrlKey: true }, 'table')) },
    { label: 'Clear the selection', run: () => select(c, []) },
    '-',
    { label: `Delete ${ids.length} notes…`, danger: true, run: () => host.deleteNotes(ids) },
  ]);
}

// One value of a property for several notes: the pickers of options and branches take them all,
// checkboxes are checked or unchecked, the other types ask for the value.
function bulkEdit(ids, key, p, x, y) {
  const at = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) };
  if (hasOptions(p)) return optionPicker(at, key, p.id, ids);
  if (p.type === 'branch') return branchPicker(at, p.id, ids);
  if (p.type === 'checkbox') {
    return host.showMenu(x, y, [
      { label: 'Check all', run: () => setAll(ids, p.id, () => true) },
      { label: 'Uncheck all', run: () => setAll(ids, p.id, () => null) },
    ]);
  }
  const hint = { date: 'YYYY-MM-DD', number: 'A number', url: 'https://…' }[p.type] || '';
  host.modal({ title: `Set ${p.name}`, message: `For ${ids.length} notes. Leave it empty to clear it.`, input: '', placeholder: hint, allowEmpty: true, ok: 'Set' }).then(r => {
    if (!r) return;
    let v = r.value;
    if (p.type === 'number') v = v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    if (p.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return host.toast('Dates are written as YYYY-MM-DD', 'error');
    setAll(ids, p.id, () => v);
  });
}

// ---------- table ----------

// Sort keys: empty values go last whatever the direction.
function sortKey(p, v) {
  if (v == null) return null;
  if (p.type === 'select') return p.options.findIndex(o => o.id === v);
  if (p.type === 'multi') return p.options.findIndex(o => o.id === [].concat(v)[0]);
  if (p.type === 'number') return v;
  if (p.type === 'checkbox') return v ? 1 : 0;
  if (p.type === 'branch') return v.name.toLowerCase();
  return String(v).toLowerCase();
}

function sorted(notes, view, schema) {
  const s = view.sort;
  if (!s) return notes;
  const p = schema.find(x => x.id === s.prop);
  if (s.prop !== 'title' && !p) return notes;
  const k = n => (s.prop === 'title' ? (n.title || '').toLowerCase() || null : sortKey(p, n.props?.[p.id]));
  return [...notes].sort((a, b) => {
    const x = k(a), y = k(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (x < y ? -1 : x > y ? 1 : 0) * s.dir;
  });
}

const sortMark = (view, id) => (view.sort?.prop === id ? icon(view.sort.dir > 0 ? 'up' : 'down', 'vt-sort') : '');

function tableHtml(col, view, notes) {
  const props = col.schema.filter(p => !view.hidden?.includes(p.id));
  const head = `<tr><th class="vt-title" data-head="title"><button class="vt-check" data-cv="select-all" title="Select all">${icon('check')}</button>${icon('text')}<span>Name</span>${sortMark(view, 'title')}</th>`
    + props.map(p => `<th class="pt-${p.type}" data-head="${p.id}">${icon(TYPES[p.type][1])}<span>${esc(p.name)}</span>${sortMark(view, p.id)}</th>`).join('')
    + `<th class="vt-addcol" data-cv="add-prop" title="Add a property">${icon('plus')}</th></tr>`;
  const row = n => `<tr data-note="${n.id}">
      <td class="vt-title"><div class="vt-tcell"><button class="vt-check" data-cv="select" title="Select (Shift+click a row)">${icon('check')}</button>${icon(n.icon || 'note')}<span class="vt-tt ${n.title ? '' : 'untitled'}" data-cv="edit-title">${esc(n.title || 'Untitled')}</span>
        <button class="vt-open" data-cv="open">Open</button></div></td>
      ${props.map(p => `<td class="vt-cell pt-${p.type}" data-prop="${p.id}">${valueHtml(p, n.props?.[p.id])}</td>`).join('')}<td class="vt-fill"></td></tr>`;
  return `<div class="vt-wrap"><table class="vt"><thead>${head}</thead><tbody>${notes.length ? sorted(notes, view, col.schema).map(row).join('') : ''}</tbody></table>
    <button class="vt-new" data-cv="new-row">${icon('plus')}New</button></div>`;
}

// ---------- board ----------

// The pencil of a card: its title is edited right there (Enter or leaving it saves, Escape doesn't).
function renameCard(card, id) {
  const t = card?.querySelector('.bd-ct');
  if (!t) return;
  const input = Object.assign(document.createElement('textarea'), { className: 'bd-ct-edit', value: S.getNote(id)?.title || '', rows: 1, placeholder: 'Untitled' });
  t.replaceWith(input);
  card.draggable = false;
  card.classList.add('renaming');
  const fit = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.blur(); // (repaints wait while it has the focus)
    if (save && v !== (S.getNote(id)?.title || '')) S.renameNote(id, v);
    else repaintViews();
  };
  input.addEventListener('input', fit);
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  // clicks in it stay in it (they don't open the note)
  for (const ev of ['click', 'mousedown', 'pointerdown']) input.addEventListener(ev, e => e.stopPropagation());
  fit();
  input.focus();
  input.select();
}

const groupProp = (col, view) => col.schema.find(p => p.id === view.groupBy && p.type === 'select') || col.schema.find(p => p.type === 'select') || null;

function boardHtml(col, view, notes) {
  const g = groupProp(col, view);
  if (!g) {
    return `<div class="cv-empty bd-empty"><p>A board shows the notes in columns, one for each option of a select property like Status.</p>
      <button class="btn-sm" data-cv="add-status">${icon('plus')}Add a Status property</button></div>`;
  }
  const shown = col.schema.filter(p => p.id !== g.id && !view.hidden?.includes(p.id));
  const known = new Set(g.options.map(o => o.id));
  const cardsOf = optId => notes.filter(n => (optId ? n.props?.[g.id] === optId : !known.has(n.props?.[g.id])));
  const card = n => {
    const props = shown.map(p => {
      const v = n.props?.[p.id];
      if (v == null || (p.type === 'checkbox' && !v)) return '';
      return `<div class="bd-prop pt-${p.type}">${p.type === 'checkbox' ? `${valueHtml(p, v)}<span>${esc(p.name)}</span>` : valueHtml(p, v)}</div>`;
    }).join('');
    return `<div class="bd-card" data-note="${n.id}" draggable="true"><div class="bd-ct ${n.title ? '' : 'untitled'}">${n.icon ? icon(n.icon, 'bd-ic') : ''}${esc(n.title || 'Untitled')}</div>${props}
      <button class="cv-btn bd-edit" data-cv="rename-card" title="Rename">${icon('pencil')}</button></div>`;
  };
  const label = o => (o ? chip(o) : `<span class="opt c-none">No ${esc(g.name)}</span>`);
  const column = (o, cards) => `<div class="bd-col" data-group="${o?.id || ''}">
      <div class="bd-head" ${o ? 'draggable="true" title="Drag to move the column"' : ''}>${label(o)}<span class="bd-n">${cards.length}</span>
        <button class="cv-btn bd-more" data-cv="group-menu" title="Group options">${icon('more')}</button>
        <button class="cv-btn bd-top" data-cv="new-top" title="Add a card at the top">${icon('plus')}</button></div>
      <div class="bd-cards">${cards.map(card).join('')}</div>
      <button class="bd-new" data-cv="new-in">${icon('plus')}New</button></div>`;
  // Pinned groups leave the columns for a list on the right, like in Notion
  const pinned = new Set(view.pinned || []);
  const groups = [...(cardsOf(null).length ? [null] : []), ...g.options];
  const pins = groups.filter(o => pinned.has(o?.id ?? ''));
  return `<div class="bd">${groups.filter(o => !pinned.has(o?.id ?? '')).map(o => column(o, cardsOf(o?.id ?? null))).join('')}
    <button class="bd-addcol" data-cv="add-group">${icon('plus')}Add a group</button>
    ${pins.length ? `<div class="bd-pinned"><div class="bd-pinned-head">${icon('pin')}Pinned groups</div>
      ${pins.map(o => `<div class="bd-pin-row" data-group="${o?.id ?? ''}" data-cv="pinned-group" title="Show its notes">${label(o)}<span class="bd-n">${cardsOf(o?.id ?? null).length}</span>
        <button class="cv-btn bd-unpin" data-cv="unpin" title="Show as a column">${icon('pin')}</button></div>`).join('')}</div>` : ''}
  </div>`;
}

// The notes of a pinned group, in a list to open them.
function pinnedPopup(anchor, c, groupId) {
  const key = S.collectionKey(c.space, c.parent), col = S.getCollection(key), g = groupProp(col, activeView(col));
  const known = new Set(g.options.map(o => o.id));
  const notes = S.childrenOf(c.space, c.parent).filter(n => (groupId ? n.props?.[g.id] === groupId : !known.has(n.props?.[g.id])));
  const el = popup(anchor, 'Search in this group');
  const q = $('.opt-q', el);
  let shown = [];
  const paint = () => {
    const t = q.value.trim().toLowerCase();
    shown = notes.filter(n => (n.title || 'Untitled').toLowerCase().includes(t));
    $('.opt-list', el).innerHTML = shown.slice(0, 300).map((n, i) => `<div class="opt-item" data-i="${i}">${icon('note')}<span class="opt-branch">${esc(n.title || 'Untitled')}</span></div>`).join('')
      + (shown.length > 300 ? `<div class="opt-hint">${shown.length - 300} more: search to find them</div>` : '')
      + (!shown.length ? '<div class="opt-hint">No notes</div>' : '')
      + `<div class="opt-item opt-create" data-new>${icon('plus')}New note in this group</div>`;
  };
  el.addEventListener('mousedown', e => {
    if (e.target === q) return;
    e.preventDefault();
    const it = e.target.closest('.opt-item');
    if (!it) return;
    closePicker();
    if (it.dataset.i) c.open(shown[+it.dataset.i].id, e, 'board');
    else c.create(groupId ? { [g.id]: groupId } : {});
  });
  q.addEventListener('input', paint);
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
    else if (e.key === 'Enter' && shown.length) { e.preventDefault(); closePicker(); c.open(shown[0].id, e, 'board'); }
  });
  paint();
}

// A Status property with the usual options, for boards.
function addStatus(key) {
  const p = S.addProperty(key, { name: 'Status', type: 'select' });
  S.addOption(key, p.id, 'Not started', 'gray');
  S.addOption(key, p.id, 'In progress', 'blue');
  S.addOption(key, p.id, 'Done', 'green');
  return p;
}

// ---------- views ----------

// Adds a view to a database (a board gets a Status property when it has no select to group by).
export function addView(key, type) {
  const col = S.getCollection(key);
  const v = S.addView(key, type, VIEWS[type][0]);
  if (type === 'board') S.updateView(key, v.id, { groupBy: (groupProp(col, v) || addStatus(key)).id });
  return v;
}

// `ctx`: where the database is shown ('inline' in a page's text, 'page' on its own).
function viewMenu(x, y, key, ctx) {
  const page = S.getNote(S.getNote(key)?.parent);
  const col = S.getCollection(key), view = activeView(col);
  const selects = col.schema.filter(p => p.type === 'select');
  const g = view.type === 'board' ? groupProp(col, view) : null;
  host.showMenu(x, y, [
    { label: 'Rename view…', run: async () => { const r = await host.modal({ title: 'Rename view', input: view.name, ok: 'Rename' }); if (r) S.updateView(key, view.id, { name: r.value }); } },
    { label: view.icon ? 'Change icon…' : 'Add icon…', run: r => pickEmoji(r, view.icon, e => S.updateView(key, view.id, { icon: e })) },
    ...(view.type === 'board' && selects.length > 1 ? ['-', ...selects.map(p => ({ label: `Group by ${p.name}${g?.id === p.id ? '  ✓' : ''}`, run: () => S.updateView(key, view.id, { groupBy: p.id }) }))] : []),
    ...(view.type !== 'list' && col.schema.length ? ['-', ...col.schema.filter(p => p.id !== g?.id).map(p => {
      const hidden = view.hidden?.includes(p.id);
      return { label: `${hidden ? 'Show' : 'Hide'} ${p.name}`, run: () => S.updateView(key, view.id, { hidden: hidden ? view.hidden.filter(x => x !== p.id) : [...(view.hidden || []), p.id] }) };
    })] : []),
    '-',
    { label: 'Add a property…', run: () => addProperty(x, y, key) },
    ...(S.isDatabase(key) ? [{ label: 'Open items in…', run: r => host.showMenu(r.left, r.top, host.openInMenu(key)) }] : []),
    ...(view.type === 'board' && view.pinned?.length ? [{ label: 'Unpin all groups', run: () => S.updateView(key, view.id, { pinned: null }) }] : []),
    // a database in a page's text can take the page's whole width (the text keeps its column)
    ...(ctx === 'inline' && page ? [{ label: `Full-width databases on this page${S.wideViewsOf(page.id) ? '  ✓' : ''}`, run: () => S.setWideViews(page.id, !S.wideViewsOf(page.id)) }] : []),
    '-',
    { label: 'Delete view…', danger: true, run: () => deleteView(key, view) },
    ...(S.isDatabase(key) ? [{ label: 'Delete database…', danger: true, run: () => host.deleteNotes([key]) }] : []),
  ]);
}

async function deleteView(key, view) {
  const col = S.getCollection(key);
  const last = col.views.length === 1;
  const ok = await host.confirmBox('Delete view', `Delete the view "${view.name}"? The items stay${last ? ', shown in a list' : ''}.`, 'Delete view');
  if (ok) S.deleteView(key, view.id);
}

// ---------- events ----------

function bindCollection(c) {
  const el = c.el;
  const keyOf = () => S.collectionKey(c.space, c.parent);

  el.addEventListener('click', e => {
    if (openBranchChip(e)) return;
    const key = keyOf(), col = S.getCollection(key), view = activeView(col);
    const tab = e.target.closest('.cv-tab');
    if (tab) return S.setActiveView(key, tab.dataset.view);
    const btn = e.target.closest('[data-cv]'), r = btn?.getBoundingClientRect();
    const id = e.target.closest('[data-note]')?.dataset.note;
    const colEl = e.target.closest('.bd-col');
    // Shift+click adds a row or a card to the selection (or takes it out)
    if (e.shiftKey && e.target.closest('tr[data-note], .bd-card')) return toggle(c, id);
    switch (btn?.dataset.cv) {
      case 'select': return toggle(c, id);
      case 'select-all': {
        const rows = [...el.querySelectorAll('tr[data-note]')].map(x => x.dataset.note);
        return select(c, rows.every(x => c.sel.has(x)) ? [] : rows);
      }
      case 'add-view': return host.showMenu(r.left, r.bottom + 4, Object.entries(VIEWS).map(([t, [name]]) => ({ label: `${name} view`, run: () => addView(key, t) })));
      case 'view-menu': return viewMenu(r.right - 220, r.bottom + 4, key, c.ctx);
      case 'new':
        if (view.type === 'table') return newRow(c);
        if (view.type === 'board') { const g = groupProp(col, view); return c.create(g?.options[0] ? { [g.id]: g.options[0].id } : {}); }
        return c.create({});
      case 'new-row': return newRow(c);
      case 'rename-card': return renameCard(btn.closest('.bd-card'), id);
      case 'new-in': { const g = groupProp(col, view); return c.create(colEl.dataset.group ? { [g.id]: colEl.dataset.group } : {}); }
      // the "+" of a column's header: a card at the top of the column
      case 'new-top': {
        const g = groupProp(col, view), first = colEl.querySelector('.bd-card')?.dataset.note;
        const n = c.create(colEl.dataset.group ? { [g.id]: colEl.dataset.group } : {});
        if (n && first) S.moveNote(n.id, n.parent ?? null, first);
        return;
      }
      case 'add-prop': return addProperty(r.left, r.bottom + 4, key);
      case 'add-status': return S.updateView(key, view.id, { groupBy: addStatus(key).id });
      case 'add-group': {
        const g = groupProp(col, view);
        return host.modal({ title: `New ${g.name} option`, input: '', placeholder: 'Name', ok: 'Add' }).then(m => m && S.addOption(key, g.id, m.value));
      }
      case 'group-menu': {
        const group = colEl.dataset.group, pinned = view.pinned || [];
        return host.showMenu(r.left, r.bottom + 4, [
          { label: 'Pin group', run: () => S.updateView(key, view.id, { pinned: [...pinned.filter(x => x !== group), group] }) },
          ...(group ? ['-', ...optionMenuItems(key, groupProp(col, view).id, group)] : []),
        ]);
      }
      case 'unpin': {
        const group = btn.closest('.bd-pin-row').dataset.group, pinned = (view.pinned || []).filter(x => x !== group);
        return S.updateView(key, view.id, { pinned: pinned.length ? pinned : null });
      }
      case 'pinned-group': return pinnedPopup(btn, c, btn.dataset.group);
      case 'open': return c.open(id, e, view.type);
      case 'edit-title': return editTitle(btn, id);
    }
    const th = e.target.closest('th[data-head]');
    if (th) {
      const tr = th.getBoundingClientRect();
      if (th.dataset.head !== 'title') return propMenu(tr.left, tr.bottom + 2, key, propOf(key, th.dataset.head), view);
      return host.showMenu(tr.left, tr.bottom + 2, [
        { label: 'Sort ascending', run: () => S.updateView(key, view.id, { sort: { prop: 'title', dir: 1 } }) },
        { label: 'Sort descending', run: () => S.updateView(key, view.id, { sort: { prop: 'title', dir: -1 } }) },
        ...(view.sort ? [{ label: 'Clear sort', run: () => S.updateView(key, view.id, { sort: null }) }] : []),
      ]);
    }
    const cell = e.target.closest('td.vt-cell');
    if (cell) return editValue(cell, id, propOf(key, cell.dataset.prop));
    if (e.target.closest('.bd-card')) {
      select(c, []);
      return c.open(id, e, 'board');
    }
  });

  el.addEventListener('mousedown', e => boxSelect(c, e));

  // The context menu of a selected note acts on the whole selection; on another note, on that one.
  el.addEventListener('contextmenu', e => {
    const tab = e.target.closest('.cv-tab');
    const item = e.target.closest('tr[data-note], .bd-card');
    if (!tab && !item) return;
    e.preventDefault();
    if (tab) {
      S.setActiveView(keyOf(), tab.dataset.view);
      return viewMenu(e.clientX, e.clientY, keyOf(), c.ctx);
    }
    if (c.sel.has(item.dataset.note) && c.sel.size > 1) return bulkMenu(c, e.clientX, e.clientY);
    select(c, [item.dataset.note]);
    host.showMenu(e.clientX, e.clientY, host.noteMenu(item.dataset.note));
  });
  el.addEventListener('auxclick', e => {
    const item = e.target.closest('tr[data-note], .bd-card');
    if (item && e.button === 1) c.open(item.dataset.note, { ctrlKey: true }, 'table');
  });

  // Board: drag cards to another column (sets the group) or between cards (sets the order);
  // dragging a selected card takes the whole selection
  let drag = null, dragging = [];
  const clear = () => el.querySelectorAll('.drop-before, .drop-end').forEach(x => x.classList.remove('drop-before', 'drop-end'));
  const target = e => {
    // a pinned group takes the cards at its end
    const pin = e.target.closest('.bd-pin-row');
    if (pin) return { colEl: pin, before: null, last: null };
    const colEl = e.target.closest('.bd-col');
    if (!colEl) return null;
    const cards = [...colEl.querySelectorAll('.bd-card')].filter(x => !dragging.includes(x.dataset.note));
    const before = cards.find(x => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
    return { colEl, before, last: cards[cards.length - 1] || null };
  };
  el.addEventListener('dragstart', e => {
    const card = e.target.closest('.bd-card');
    if (!card) return;
    drag = card.dataset.note;
    dragging = c.sel.has(drag) && c.sel.size > 1 ? selection(c) : [drag];
    for (const x of itemsOf(c)) if (dragging.includes(x.dataset.note)) x.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag);
  });
  el.addEventListener('dragover', e => {
    if (!drag) return;
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    clear();
    if (t.before) t.before.classList.add('drop-before');
    else t.colEl.classList.add('drop-end');
  });
  el.addEventListener('drop', e => {
    if (!drag) return;
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    const key = keyOf(), col = S.getCollection(key), g = groupProp(col, activeView(col));
    const ids = dragging;
    drag = null; // the board is drawn again, so "dragend" won't reach it
    dragging = [];
    // the order is kept among all the notes: after the column's last card means before the note that follows it
    let before = t.before?.dataset.note ?? null;
    if (!before && t.last) {
      const siblings = S.childrenOf(c.space, c.parent).filter(n => !ids.includes(n.id));
      before = siblings[siblings.findIndex(n => n.id === t.last.dataset.note) + 1]?.id ?? null;
    }
    S.batch(() => ids.forEach(id => {
      S.moveNote(id, c.parent, before);
      S.setProp(id, g.id, t.colEl.dataset.group || null);
    }));
  });
  el.addEventListener('dragend', () => {
    drag = null;
    dragging = [];
    clear();
    el.querySelectorAll('.bd-card.dragging').forEach(x => x.classList.remove('dragging'));
  });

  // Board: drag a column by its header to reorder the columns (the order of the property's options)
  let dragCol = null;
  const clearCols = () => el.querySelectorAll('.bd-col.drop-left, .bd-col.drop-right').forEach(x => x.classList.remove('drop-left', 'drop-right'));
  const colTarget = e => {
    const colEl = e.target.closest('.bd-col');
    if (!colEl?.dataset.group || colEl.dataset.group === dragCol) return null;
    const r = colEl.getBoundingClientRect();
    return { colEl, left: e.clientX < r.left + r.width / 2 };
  };
  el.addEventListener('dragstart', e => {
    const head = e.target.closest('.bd-head[draggable]');
    if (!head || e.target.closest('.bd-card')) return;
    dragCol = head.closest('.bd-col').dataset.group;
    head.closest('.bd-col').classList.add('dragging-col');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragCol);
  });
  el.addEventListener('dragover', e => {
    if (!dragCol) return;
    const t = colTarget(e);
    if (!t) return;
    e.preventDefault();
    clearCols();
    t.colEl.classList.add(t.left ? 'drop-left' : 'drop-right');
  });
  el.addEventListener('drop', e => {
    if (!dragCol) return;
    const t = colTarget(e);
    if (!t) return;
    e.preventDefault();
    const key = keyOf(), col = S.getCollection(key), g = groupProp(col, activeView(col));
    const moving = dragCol;
    dragCol = null; // the board is drawn again, so "dragend" won't reach it
    // dropped on the right half: before the option that follows the target
    const rest = g.options.filter(o => o.id !== moving);
    const i = rest.findIndex(o => o.id === t.colEl.dataset.group);
    S.moveOption(key, g.id, moving, t.left ? rest[i].id : rest[i + 1]?.id ?? null);
  });
  el.addEventListener('dragend', () => {
    dragCol = null;
    clearCols();
    el.querySelector('.bd-col.dragging-col')?.classList.remove('dragging-col');
  });
}

// A new row of the table, its title typed right there.
function newRow(c) {
  const n = c.create({}, 'none');
  const cell = c.el.querySelector(`tr[data-note="${CSS.escape(n.id)}"] .vt-tt`);
  if (cell) editTitle(cell, n.id);
}
