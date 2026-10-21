// Project dashboard: the folders of a project with the state of each repository (branch, sync with
// its upstream, local changes, last commit), and fetch/pull for all of them at once.
// Pulls here are fast-forward only, so they never create merge commits or stop on conflicts:
// a branch that diverged from its upstream is reported, to be merged or rebased in its tab.
import * as G from './git.js?v=589d7e5';
import * as P from './projects.js?v=589d7e5';
import { esc, fmtRelative, icon, folderName, normPath, plural } from './util.js?v=589d7e5';
import { desktop, invoke } from './platform.js?v=589d7e5';

const $ = (sel, root = document) => root.querySelector(sel);

const PARALLEL = 4; // folders read, fetched or pulled at the same time

// Callbacks into the app (see initDashboard).
let host = null;

const info = new Map();     // folder -> its state (see readFolder), kept while the app runs
const reads = new Map();    // folder -> number of its latest read, so an older read never wins
const busy = new Map();     // folder -> what is running on it ("Fetching")
const batches = new Map();  // project id -> { verb, done, total } of an action on all its folders
const reloads = new Map();  // project id -> { again } while its folders are being read

const OPS = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' };

const repos = n => plural(n, 'repository', 'repositories');

// Runs `fn` on every item, at most `limit` at a time.
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// =====================================================================
// API for the app
// =====================================================================

// `h`: { open(path), pickFolders({ multiple, title }), toast, showMenu, modal, copy,
// renameProject(id), changed() (after folders were added or removed), renderNotes(el, projectId) }.
export function initDashboard(h) {
  host = h;
}

const shown = () => $('#main > .dash');
const project = () => P.getProject(shown()?.dataset.project);

// Shows the dashboard of a project in the main area and reads the state of its folders.
export function renderDashboard(id) {
  if (!P.getProject(id)) return;
  const blocks = {
    folders: `<div class="dash-sec-head"><h2 class="dash-sec">Folders</h2>
      ${desktop ? `<button class="btn-sm" data-act="add-folders">${icon('plus')}Folder</button>` : ''}</div><div class="dash-list"></div>`,
    links: `<div class="dash-sec-head"><h2 class="dash-sec">Links</h2>
      <button class="btn-sm" data-act="add-link">${icon('plus')}Link</button></div><div class="dash-links"></div>`,
    notes: '<div class="dash-notes"></div>',
  };
  $('#main').innerHTML = `<div class="dash" data-project="${esc(id)}"><div class="dash-head"></div>
    ${P.sections(P.getProject(id)).map(sec => `<section class="dash-block" data-sec="${sec}">
      <span class="dash-grip" draggable="true" title="Drag to move the section">${icon('grip')}</span>${blocks[sec]}</section>`).join('')}</div>`;
  bind(shown());
  bindDrag(shown());
  paint();
  paintLinks();
  host.renderNotes($('.dash-notes', shown()), id);
  reloadDashboard();
}

// After the project changed (renamed, folders added or removed): repaints it and reads new folders.
// Also after it changed elsewhere (see projects.js): its sections, links and name are drawn again.
export function updateDashboard() {
  const p = project();
  if (!p) return;
  const root = shown();
  P.sections(p).forEach(sec => root.appendChild(root.querySelector(`.dash-block[data-sec="${sec}"]`)));
  paint();
  paintLinks();
  if (desktop) pool(P.folderPaths(p).filter(path => !info.has(path) && !busy.has(path)), PARALLEL, loadFolder);
}

// Reads the state of every folder again (F5, or when the window gets the focus back).
export async function reloadDashboard() {
  const p = project();
  if (!p || !desktop) return;
  if (reloads.has(p.id)) { reloads.get(p.id).again = true; return; }
  const r = { again: false };
  reloads.set(p.id, r);
  paintHead();
  try {
    do {
      r.again = false;
      await pool(P.folderPaths(p).filter(path => !busy.has(path)), PARALLEL, loadFolder);
    } while (r.again);
  } finally {
    reloads.delete(p.id);
    paintHead();
  }
}

export const addMenuItems = id => [
  { label: 'Add folders…', run: () => addFolders(id) },
  { label: 'Add the repositories inside a folder…', run: () => addRepositories(id) },
];

// =====================================================================
// State of the folders
// =====================================================================

// 'missing', 'plain' (not a Git repository), 'error' (git failed) or 'git' with
// { status, last (commit), op (merge/rebase in progress), stashes, fetched (time of the last fetch) }.
async function readFolder(path) {
  if (!(await G.statPath(path, '').then(s => s.dir, () => false))) return { kind: 'missing' };
  const r = await G.gitRaw(path, ['rev-parse', '--git-path', 'FETCH_HEAD']).catch(() => null);
  if (r?.code !== 0) return { kind: 'plain' };
  try {
    const [status, last, op, stashes, fetched] = await Promise.all([
      G.getStatus(path),
      G.gitRaw(path, ['log', '-1', '--format=%s%x1f%at%x1f%an']).then(l => {
        if (l.code !== 0 || !l.stdout.trim()) return null; // no commits yet
        const [subject, time, author] = l.stdout.trim().split('\x1f');
        return { subject, time: +time, author };
      }),
      G.getOperation(path).catch(() => null),
      G.getStashes(path),
      G.statPath(path, r.stdout.trim()).then(s => s.modified, () => 0),
    ]);
    return { kind: 'git', status, last, op, stashes: stashes.length, fetched };
  } catch (e) {
    return { kind: 'error', message: String(e.message || e) };
  }
}

async function loadFolder(path) {
  const n = (reads.get(path) || 0) + 1;
  reads.set(path, n);
  const s = await readFolder(path);
  if (reads.get(path) !== n) return;
  info.set(path, s);
  paintRow(path);
}

// =====================================================================
// Rendering
// =====================================================================

function paint() {
  const p = project();
  if (!p) return;
  $('.dash-head', shown()).innerHTML = '';
  paintHead();
  const list = $('.dash-list', shown());
  if (p.folders.length) {
    const rows = P.folderPaths(p).map(rowHtml);
    list.innerHTML = `<div class="dash-lhead"><span>Folder</span><span>Branch</span><span class="h-sync">Sync</span><span>Changes</span><span class="h-commit">Last commit</span><span></span></div>`
      + rows.join('');
    list.querySelectorAll('.dash-row').forEach((row, i) => (row._html = rows[i]));
    return;
  }
  if (!desktop) {
    list.innerHTML = '<div class="dash-empty"><h3>No folders yet</h3><p>Folders are added in the desktop app, where they open in their own tabs.</p></div>';
    return;
  }
  list.innerHTML = `<div class="dash-empty">
    <h3>No folders yet</h3>
    <p>Add the folders of this project: Git repositories or any other folder. Each one opens in its own tab, next to this dashboard.</p>
    <div class="dash-empty-acts">
      <button class="btn primary" data-act="add-folders">Add folders…</button>
      <button class="btn" data-act="add-repos">Add the repositories inside a folder…</button>
    </div>
  </div>`;
}

// Rows are only replaced when they change, so reading the folders again doesn't eat clicks.
function paintRow(path) {
  const row = shown()?.querySelector(`.dash-row[data-path="${CSS.escape(path)}"]`);
  if (!row) return;
  const html = rowHtml(path);
  if (row._html !== html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    const next = t.content.firstElementChild;
    next._html = html;
    row.replaceWith(next);
  }
  paintHead();
}

// The head is built once per paint; afterwards only its summary, progress and buttons are updated,
// so a click on them is not lost while the folders are being read.
function paintHead() {
  const p = project();
  if (!p) return;
  const head = $('.dash-head', shown());
  if (!head.firstElementChild) {
    head.innerHTML = `
      <div class="dash-icon" style="--pc: ${p.color}">${esc(P.initials(p.name))}</div>
      <div class="dash-title">
        <h1 data-act="rename" title="Rename the project">${esc(p.name)}</h1>
        <div class="dash-summary"></div>
      </div>
      <div class="dash-actions">
        <span class="dash-progress"></span>
        <button class="btn" data-act="add">${icon('plus')}Add</button>
        <button class="btn" data-act="fetch-all" title="Fetch every repository of the project">${icon('fetch')}Fetch all</button>
        <button class="btn" data-act="pull-all" title="Pull every repository of the project (fast-forward only)">${icon('pull')}Pull all</button>
        <button class="dash-iconbtn" data-act="lock"></button>
        <button class="dash-iconbtn" data-act="refresh" title="Refresh (F5)">${icon('refresh')}</button>
      </div>`;
  }
  const b = batches.get(p.id);
  const ready = P.folderPaths(p).some(path => info.get(path)?.kind === 'git');
  $('.dash-summary', head).innerHTML = summary(p);
  $('.dash-progress', head).innerHTML = b ? busyTag(`${b.verb} ${b.done} of ${b.total}`) : '';
  head.querySelectorAll('[data-act$="-all"]').forEach(btn => (btn.disabled = !!b || !ready));
  $('[data-act="refresh"]', head).classList.toggle('spinning', reloads.has(p.id));
  const lock = $('[data-act="lock"]', head), locked = !!p.sectionsLocked;
  shown().classList.toggle('locked', locked);
  shown().querySelectorAll('.dash-grip').forEach(g => (g.draggable = !locked));
  lock.classList.toggle('on', locked);
  lock.title = locked ? 'Unlock the order of the sections' : 'Lock the order of the sections';
  lock.innerHTML = icon(locked ? 'lock' : 'unlock');
}

const busyTag = text => `<span class="busy-tag"><span class="spinner"></span><span class="busy-text">${esc(text)}…</span></span>`;

function summary(p) {
  const states = P.folderPaths(p).map(path => info.get(path)).filter(s => s?.kind === 'git');
  const count = test => states.filter(test).length;
  const parts = [plural(p.folders.length, 'folder')];
  const add = (n, text, cls) => n && parts.push(`<span class="${cls}">${n} ${text}</span>`);
  add(count(s => s.status.conflicts.length || s.op), 'need attention', 'bad');
  add(count(s => changedFiles(s.status)), 'with changes', 'warn');
  add(count(s => s.status.behind), 'behind', 'warn');
  add(count(s => s.status.ahead), 'ahead', 'up');
  add(P.folderPaths(p).filter(path => info.get(path)?.kind === 'missing').length, 'not found', 'bad');
  return parts.join('<span class="dot">·</span>');
}

const changedFiles = st => new Set([...st.staged, ...st.unstaged].map(f => f.path)).size;

function rowHtml(path) {
  const s = info.get(path), b = busy.get(path);
  const kind = desktop ? s?.kind || 'loading' : 'web';
  const cells = kind === 'git' ? branchCell(s) + syncCell(s) + changesCell(s) + commitCell(s)
    : `<div class="dash-wide">${{
      loading: '<span class="muted">Loading…</span>',
      web: '<span class="muted">Opens in the desktop app</span>',
      plain: '<span class="muted">Folder — not a Git repository</span>',
      missing: `<span class="bad">${icon('alert')}Not found on this computer — locate it from its menu</span>`,
      error: `<span class="bad" title="${esc(s?.message)}">${icon('alert')}Could not read the repository</span>`,
    }[kind]}</div>`;
  return `<div class="dash-row ${kind}" data-path="${esc(path)}" title="${esc(path)}" draggable="true">
    <div class="dash-name">${icon(kind === 'git' ? 'branch' : 'folder')}<div class="dash-nm"><b>${esc(folderName(path))}</b><span class="dash-path"><bdi>${esc(path)}</bdi></span></div></div>
    ${cells}
    <div class="dash-acts">${b ? busyTag(b) : rowButtons(s)}</div>
  </div>`;
}

function branchCell({ status: st, op }) {
  // While rebasing, HEAD is detached: show the branch being rebased instead.
  const branch = op?.kind === 'rebase' ? op.branch : st.branch;
  const name = st.detached && op?.kind !== 'rebase' ? '<span class="bad">Detached HEAD</span>' : `<span class="ellip">${esc(branch)}</span>`;
  const extra = op ? `<span class="dash-chip">${OPS[op.kind]}</span>`
    : st.conflicts.length ? '<span class="dash-chip">Conflicts</span>'
    : st.unborn ? '<span class="muted">no commits</span>' : '';
  return `<div class="dash-line">${icon('branch')}${name}${extra}</div>`;
}

function syncCell({ status: st, fetched }) {
  let main;
  if (!st.upstream) main = `<span class="muted">${st.detached ? '—' : 'No upstream'}</span>`;
  else if (!st.ahead && !st.behind) main = `<span class="ok">${icon('check')}Up to date</span>`;
  else main = `${st.ahead ? `<span class="up" title="Commits to push">↑${st.ahead}</span>` : ''}${st.behind ? `<span class="dn" title="Commits to pull">↓${st.behind}</span>` : ''}`;
  // ahead/behind are as of the last fetch
  const when = st.upstream && fetched ? `Fetched ${fmtRelative(fetched)}` : '';
  return `<div class="dash-sync" title="${esc(st.upstream || '')}"><div class="dash-line">${main}</div><div class="dash-sub">${when}</div></div>`;
}

function changesCell({ status: st, stashes }) {
  const n = changedFiles(st);
  const main = st.conflicts.length ? `<span class="bad">${plural(st.conflicts.length, 'conflict')}</span>`
    : n ? `<span class="warn">${plural(n, 'changed file')}</span>` : '<span class="muted">Clean</span>';
  return `<div><div class="dash-line">${main}</div><div class="dash-sub">${stashes ? plural(stashes, 'stash', 'stashes') : ''}</div></div>`;
}

function commitCell({ last }) {
  if (!last) return '<div class="dash-commit"><span class="muted">No commits</span></div>';
  return `<div class="dash-commit" title="${esc(last.subject)}"><div class="dash-line"><span class="ellip">${esc(last.subject)}</span></div>
    <div class="dash-sub">${esc(fmtRelative(last.time))} · ${esc(last.author)}</div></div>`;
}

function rowButtons(s) {
  const btn = (act, ic, title, off = false) => `<button class="dash-iconbtn" data-act="${act}" title="${title}" ${off ? 'disabled' : ''}>${icon(ic)}</button>`;
  const git = s?.kind === 'git';
  return (git ? btn('fetch', 'fetch', 'Fetch') + btn('pull', 'pull', 'Pull (fast-forward only)', !s.status.upstream) : '')
    + (s && s.kind !== 'missing' ? btn('terminal', 'terminal', 'Open a terminal in the folder') : '')
    + btn('more', 'more', 'More actions');
}

// =====================================================================
// Events
// =====================================================================

function bind(root) {
  root.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('.dash-row');
    const card = e.target.closest('.lk-card');
    if (act) return act.disabled || action(act.dataset.act, row?.dataset.path ?? card?.dataset.link, act);
    if (card) return openLink(card.dataset.link);
    if (!desktop) return;
    if (row && row.classList.contains('missing')) return locate(project().id, row.dataset.path);
    if (row) host.open(row.dataset.path);
  });
  root.addEventListener('contextmenu', e => {
    const card = e.target.closest('.lk-card');
    if (card) {
      e.preventDefault();
      return host.showMenu(e.clientX, e.clientY, linkMenu(card.dataset.link));
    }
    const row = e.target.closest('.dash-row');
    if (!row) return;
    e.preventDefault();
    host.showMenu(e.clientX, e.clientY, rowMenu(row.dataset.path));
  });
}

function action(act, path, el) {
  const p = project(), r = el.getBoundingClientRect();
  ({
    add: () => host.showMenu(r.left, r.bottom + 4, addMenuItems(p.id)),
    'add-folders': () => addFolders(p.id),
    'add-repos': () => addRepositories(p.id),
    'fetch-all': () => fetchAll(p.id),
    'pull-all': () => pullAll(p.id),
    refresh: reloadDashboard,
    rename: () => host.renameProject(p.id),
    fetch: () => fetchOne(p.id, path),
    pull: () => pullOne(p.id, path),
    terminal: () => terminal(path),
    more: () => host.showMenu(r.left, r.bottom + 4, rowMenu(path)),
    lock: () => { P.setSectionsLocked(p.id, !p.sectionsLocked); paintHead(); },
    'add-link': () => addLink(p.id),
    'link-more': () => host.showMenu(r.right - 200, r.bottom + 4, linkMenu(path)),
  })[act]?.();
}

// Sections are dragged by their grip (unless their order is locked), and folder rows and link cards
// by themselves; a line shows where the dragged one will land.
let dragging = null; // { kind: 'sec' | 'folder' | 'link', id }

function bindDrag(root) {
  const clear = () => root.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  const target = e => e.target.closest({ sec: '.dash-block', folder: '.dash-row', link: '.lk-card' }[dragging?.kind]);
  const idOf = el => ({ sec: el.dataset.sec, folder: el.dataset.path, link: el.dataset.link }[dragging.kind]);
  const after = (el, e) => {
    const r = el.getBoundingClientRect();
    return dragging.kind === 'link' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  };
  root.addEventListener('dragstart', e => {
    const grip = e.target.closest?.('.dash-grip'), card = e.target.closest?.('.lk-card'), row = e.target.closest?.('.dash-row');
    let el;
    if (grip && !project()?.sectionsLocked) {
      el = grip.closest('.dash-block');
      dragging = { kind: 'sec', id: el.dataset.sec };
      e.dataTransfer.setDragImage(el, 20, 20);
    } else if (row) {
      el = row;
      dragging = { kind: 'folder', id: row.dataset.path };
    } else if (card) {
      el = card;
      dragging = { kind: 'link', id: card.dataset.link };
    } else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.id);
    setTimeout(() => el.classList.add('dragging'));
  });
  root.addEventListener('dragover', e => {
    const el = dragging && target(e);
    if (!el) return;
    e.preventDefault();
    clear();
    if (idOf(el) !== dragging.id) el.classList.add(after(el, e) ? 'drop-after' : 'drop-before');
  });
  root.addEventListener('drop', e => {
    const el = dragging && target(e);
    if (!el) return;
    e.preventDefault();
    const p = project(), late = after(el, e);
    if (dragging.kind === 'sec') {
      P.moveSection(p.id, dragging.id, el.dataset.sec, late);
      // the sections are moved, not drawn again, so the folders and notes keep their state
      P.sections(p).forEach(sec => root.appendChild(root.querySelector(`.dash-block[data-sec="${sec}"]`)));
    } else if (dragging.kind === 'folder') {
      P.moveFolder(p.id, dragging.id, el.dataset.path, late);
      paint();
    } else {
      P.moveLink(p.id, dragging.id, el.dataset.link, late);
      paintLinks();
    }
  });
  root.addEventListener('dragend', () => {
    dragging = null;
    clear();
    root.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  });
}

// =====================================================================
// Links
// =====================================================================

const previews = new Set(); // ids of the links whose page is being read

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const absUrl = (u, base) => { try { return new URL(u, base).href; } catch { return ''; } };

// A hue from the site's name, for the cards with no image.
const hue = text => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function paintLinks() {
  const p = project(), el = shown()?.querySelector('.dash-links');
  if (!p || !el) return;
  el.innerHTML = P.links(p).map(cardHtml).join('')
    + `<button class="lk-add" data-act="add-link">${icon('plus')}<span>Add a link</span></button>`;
  if (desktop) P.links(p).filter(l => !l.fetched).forEach(l => loadPreview(p.id, l));
}

function cardHtml(l) {
  const domain = hostOf(l.url), title = l.name || l.title || domain;
  // the web page can't read other sites' pages: the preview comes when the desktop app reads it
  const ic = l.icon || (!desktop && !l.fetched ? absUrl('/favicon.ico', l.url) : '');
  const img = (src, cls = '') => `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">`;
  // with no image, the card shows the site's icon (or its initial) on a color of its own
  return `<div class="lk-card" data-link="${esc(l.id)}" title="${esc(l.url)}" draggable="true">
    <div class="lk-media" style="--h: ${hue(domain)}">
      <span class="lk-mark">${esc(domain[0]?.toUpperCase() || '?')}${ic ? img(ic) : ''}</span>
      ${l.image ? img(l.image, 'lk-img') : ''}
    </div>
    <div class="lk-body">
      <div class="lk-title">${esc(title)}</div>
      ${l.description ? `<div class="lk-desc">${esc(l.description)}</div>` : ''}
      <div class="lk-site">${ic ? img(ic, 'lk-fav') : ''}<span class="ellip">${esc(l.site || domain)}</span>${previews.has(l.id) ? '<span class="spinner"></span>' : ''}</div>
    </div>
    <button class="dash-iconbtn lk-more" data-act="link-more" title="More actions">${icon('more')}</button>
  </div>`;
}

// Reads the page of a link for its preview: Open Graph / Twitter tags, the title and the icon,
// like the cards a chat app makes for a link.
async function loadPreview(id, link) {
  if (previews.has(link.id)) return;
  previews.add(link.id);
  paintLinks();
  let fields;
  try {
    fields = parsePreview(await invoke('fetch_page', { url: link.url }), link.url);
  } catch {
    fields = { icon: new URL('/favicon.ico', link.url).href };
  }
  previews.delete(link.id);
  P.updateLink(id, link.id, { title: '', description: '', image: '', site: '', ...fields, fetched: Date.now() });
  paintLinks();
}

function parsePreview(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const abs = (u, base = url) => { try { return u ? new URL(u, base).href : ''; } catch { return ''; } };
  const base = abs(doc.querySelector('base[href]')?.getAttribute('href')) || url;
  const meta = (...names) => {
    for (const n of names) {
      const v = doc.querySelector(`meta[property="${n}" i], meta[name="${n}" i]`)?.getAttribute('content')?.trim();
      if (v) return v;
    }
    return '';
  };
  // the biggest icon the page lists (touch icons are big and sharp), else /favicon.ico
  const size = l => Math.max(0, ...(l.getAttribute('sizes') || '').split(/\s+/).map(s => parseInt(s, 10) || 0)) + (/apple/i.test(l.rel) ? 100 : 0);
  const icons = [...doc.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i]')]
    .filter(l => l.getAttribute('href')).sort((a, b) => size(b) - size(a));
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  return {
    title: clip(meta('og:title', 'twitter:title') || doc.title.trim(), 200),
    description: clip(meta('og:description', 'twitter:description', 'description'), 300),
    image: abs(meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), base),
    site: meta('og:site_name', 'application-name'),
    icon: abs(icons[0]?.getAttribute('href'), base) || abs('/favicon.ico'),
  };
}

const findLink = id => P.links(project()).find(l => l.id === id);

function openLink(id) {
  const l = findLink(id);
  if (l) invoke('open_url', { url: l.url }).catch(e => host.toast('Could not open the link', 'error', String(e)));
}

// "github.com/x" -> "https://github.com/x"; null when it is not a web address.
function normUrl(text) {
  const t = (text || '').trim();
  try {
    const u = new URL(/^[a-z][\w+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return /^https?:$/.test(u.protocol) && (u.hostname.includes('.') || u.hostname === 'localhost') ? u.href : null;
  } catch { return null; }
}

async function linkForm(title, ok, l = {}) {
  const r = await host.modal({
    title, ok,
    fields: [
      { label: 'Address', value: l.url || '', placeholder: 'https://…' },
      { label: 'Name', value: l.name || '', placeholder: 'The title of the page', optional: true },
    ],
  });
  if (!r) return null;
  const url = normUrl(r.values[0]);
  if (!url) { host.toast('That is not a web address', 'warn', r.values[0]); return null; }
  return { url, name: r.values[1] };
}

async function addLink(id) {
  // a link copied to the clipboard is offered
  // (not on the web, where reading the clipboard asks for permission)
  const copied = desktop && await navigator.clipboard?.readText().then(t => (normUrl(t) && /^https?:\/\//i.test(t.trim()) ? t.trim() : ''), () => '');
  const f = await linkForm('Add a link', 'Add', { url: copied || '' });
  if (!f) return;
  const l = P.addLink(id, f.url);
  P.updateLink(id, l.id, { name: f.name });
  paintLinks();
}

async function editLink(id) {
  const p = project(), l = findLink(id);
  if (!l) return;
  const f = await linkForm('Edit link', 'Save', l);
  if (!f) return;
  P.updateLink(p.id, id, f.url === l.url ? { name: f.name } : { name: f.name, url: f.url, fetched: 0 });
  paintLinks();
}

function linkMenu(id) {
  const p = project(), l = findLink(id);
  if (!l) return [];
  return [
    { label: 'Open', run: () => openLink(id) },
    { label: 'Copy link', run: () => host.copy(l.url) },
    '-',
    { label: 'Edit…', run: () => editLink(id) },
    { label: 'Refresh the preview', run: () => { P.updateLink(p.id, id, { fetched: 0 }); paintLinks(); } },
    '-',
    { label: 'Remove', run: () => { P.removeLink(p.id, id); paintLinks(); } },
  ];
}

// "Move up/down", for touch screens (elsewhere the rows are dragged too).
function moveItems(p, path) {
  const list = P.folderPaths(p), i = list.indexOf(path);
  const move = (target, after) => () => { P.moveFolder(p.id, path, target, after); paint(); };
  return [
    { label: 'Move up', disabled: i <= 0, run: move(list[i - 1], false) },
    { label: 'Move down', disabled: i < 0 || i >= list.length - 1, run: move(list[i + 1], true) },
  ];
}

function rowMenu(path) {
  const p = project(), s = info.get(path);
  const git = s?.kind === 'git', here = s && s.kind !== 'missing';
  if (!desktop) return [{ label: 'Copy path', run: () => host.copy(path) }, '-', ...moveItems(p, path), '-', { label: 'Remove from the project', run: () => removeFolder(p.id, path) }];
  return [
    here ? { label: 'Open', run: () => host.open(path) } : { label: 'Locate the folder…', run: () => locate(p.id, path) },
    ...(here ? [{ label: 'Use another folder on this computer…', run: () => locate(p.id, path) }] : []),
    ...(git ? ['-',
      { label: 'Fetch', disabled: busy.has(path), run: () => fetchOne(p.id, path) },
      { label: 'Pull (fast-forward only)', disabled: busy.has(path) || !s.status.upstream, run: () => pullOne(p.id, path) }] : []),
    '-',
    { label: 'Open terminal here', disabled: !here, run: () => terminal(path) },
    { label: 'Show in Explorer', disabled: !here, run: () => invoke('show_in_explorer', { repo: path, path: '' }).catch(e => host.toast('Show in Explorer failed', 'error', String(e))) },
    { label: 'Copy path', run: () => host.copy(path) },
    '-',
    ...moveItems(p, path),
    '-',
    { label: 'Remove from the project', run: () => removeFolder(p.id, path) },
  ];
}

const terminal = path => invoke('open_terminal', { repo: path }).catch(e => host.toast('Open terminal failed', 'error', String(e)));

// =====================================================================
// Fetch and pull
// =====================================================================

// Runs `fn(path)` on the folders (a few at a time), showing it on their rows, and reads each folder
// again when it is done. With `all`, the dashboard header shows the progress.
async function runOn(id, paths, verb, fn, { all = false } = {}) {
  const b = { verb, done: 0, total: paths.length };
  if (all) batches.set(id, b);
  paths.forEach(path => busy.set(path, verb));
  paths.forEach(paintRow);
  paintHead();
  const ok = [], failed = [];
  await pool(paths, PARALLEL, async path => {
    try {
      ok.push([path, await fn(path)]);
    } catch (e) {
      failed.push([path, String(e.message || e).trim()]);
    }
    busy.delete(path);
    b.done++;
    await loadFolder(path);
  });
  if (all) batches.delete(id);
  paintHead();
  return { ok, failed };
}

const fetchRepo = path => G.git(path, ['fetch', '--all', '--prune']);

// Returns whether the branch moved.
async function pull(path) {
  const head = () => G.git(path, ['rev-parse', 'HEAD']).then(s => s.trim(), () => '');
  const before = await head();
  try {
    await G.git(path, ['pull', '--ff-only', '--no-rebase']);
  } catch (e) {
    if (/not possible to fast-forward/i.test(e.message)) throw new Error('The branch and its upstream have diverged: open the repository to merge or rebase.');
    throw e;
  }
  return (await head()) !== before;
}

// Why a repository is left out of a pull, or null.
function pullBlocker(s) {
  if (s.op) return `${OPS[s.op.kind].toLowerCase()} in progress`;
  if (s.status.conflicts.length) return 'it has conflicts';
  if (s.status.detached) return 'detached HEAD';
  if (!s.status.upstream) return 'no upstream';
  return null;
}

const gitFolders = id => P.folderPaths(P.getProject(id)).filter(path => info.get(path)?.kind === 'git' && !busy.has(path));
const failures = failed => failed.map(([path, msg]) => `${folderName(path)}: ${msg}`).join('\n\n');

async function fetchAll(id) {
  const paths = gitFolders(id);
  if (batches.has(id) || !paths.length) return;
  const { ok, failed } = await runOn(id, paths, 'Fetching', fetchRepo, { all: true });
  if (ok.length) host.toast(`Fetched ${repos(ok.length)}`, 'ok');
  if (failed.length) host.toast(`Fetch failed in ${repos(failed.length)}`, 'error', failures(failed));
}

async function pullAll(id) {
  if (batches.has(id)) return;
  const paths = [], skipped = [];
  for (const path of gitFolders(id)) {
    const why = pullBlocker(info.get(path));
    if (why) skipped.push(`${folderName(path)}: ${why}`);
    else paths.push(path);
  }
  const { ok, failed } = paths.length ? await runOn(id, paths, 'Pulling', pull, { all: true }) : { ok: [], failed: [] };
  const moved = ok.filter(([, changed]) => changed).length;
  if (ok.length) {
    host.toast(moved ? `Pulled ${repos(moved)}${ok.length > moved ? ` — ${ok.length - moved} already up to date` : ''}`
      : `${ok.length === 1 ? 'The repository is' : `All ${ok.length} repositories are`} already up to date`, 'ok');
  }
  if (skipped.length) host.toast(`Skipped ${repos(skipped.length)}`, 'warn', skipped.join('\n'));
  if (failed.length) host.toast(`Pull failed in ${repos(failed.length)}`, 'error', failures(failed));
}

async function fetchOne(id, path) {
  if (busy.has(path)) return;
  const { failed } = await runOn(id, [path], 'Fetching', fetchRepo);
  if (failed.length) host.toast(`Fetch failed — ${folderName(path)}`, 'error', failed[0][1]);
}

async function pullOne(id, path) {
  const why = info.get(path)?.kind === 'git' && pullBlocker(info.get(path));
  if (why) return host.toast(`Can't pull ${folderName(path)} — ${why}`, 'warn');
  if (busy.has(path)) return;
  const { ok, failed } = await runOn(id, [path], 'Pulling', pull);
  if (failed.length) host.toast(`Pull failed — ${folderName(path)}`, 'error', failed[0][1]);
  else host.toast(ok[0][1] ? `Pulled ${folderName(path)}` : `${folderName(path)} is already up to date`, 'ok');
}

// =====================================================================
// Adding and removing folders
// =====================================================================

// A folder inside a Git repository is added as the whole repository, like when it is opened in a tab.
const rootOf = path => G.repoRoot(path).catch(() => normPath(path));
const byName = (a, b) => folderName(a).localeCompare(folderName(b), undefined, { numeric: true, sensitivity: 'base' });

function added(id, n, asked) {
  if (n) host.toast(`Added ${plural(n, 'folder')} to “${P.getProject(id)?.name}”`, 'ok');
  if (n < asked) host.toast(`${plural(asked - n, 'folder was', 'folders were')} already in the project`);
  if (n) host.changed();
}

export async function addFolders(id) {
  let picked = await host.pickFolders({ multiple: true, title: 'Add folders to the project' });
  if (!picked) return;
  picked = Array.isArray(picked) ? picked : [picked];
  if (!picked.length) return;
  const roots = (await Promise.all(picked.map(rootOf))).sort(byName);
  added(id, P.addFolders(id, roots), roots.length);
}

// Looks for Git repositories in a folder (the folder itself and its subfolders) and lets the user
// pick which ones to add.
export async function addRepositories(id) {
  const picked = await host.pickFolders({ title: 'Add the Git repositories inside a folder' });
  if (!picked) return;
  const base = normPath(Array.isArray(picked) ? picked[0] : picked);
  const join = name => (base.endsWith('/') ? base + name : `${base}/${name}`);
  const entries = await G.listDir(base, '').catch(() => []);
  const dirs = [base, ...entries.filter(e => e.dir).map(e => join(e.name))];
  const isRepo = dir => G.statPath(dir, '.git').then(() => true, () => false);
  const found = (await Promise.all(dirs.map(async d => ((await isRepo(d)) ? rootOf(d) : null)))).filter(Boolean);
  const p = P.getProject(id);
  const fresh = [...new Set(found)].filter(path => p && !P.hasFolder(p, path)).sort(byName);
  if (!fresh.length) {
    return host.toast(found.length ? 'The repositories in this folder are already in the project' : 'No Git repositories found in this folder', 'info', base);
  }
  const r = await host.modal({
    title: 'Add repositories',
    message: `${repos(fresh.length)} found in ${base}`,
    checks: fresh.map(path => ({ label: folderName(path), value: true })),
    ok: 'Add',
  });
  if (!r) return;
  const chosen = fresh.filter((_, i) => r.checks[i]);
  added(id, P.addFolders(id, chosen), chosen.length);
}

function removeFolder(id, path) {
  P.removeFolder(id, path);
  host.toast(`Removed ${folderName(path)} from the project`);
  host.changed();
}

// A folder that is not found (moved, or somewhere else on this computer) can be pointed to where it
// is. Only this computer changes: the others keep their own path for it (see projects.js).
async function locate(id, path) {
  const picked = await host.pickFolders({ title: `Locate ${folderName(path)}` });
  if (!picked) return;
  const next = await rootOf(Array.isArray(picked) ? picked[0] : picked);
  P.replaceFolder(id, path, next);
  info.delete(path);
  host.changed();
}
