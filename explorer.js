// File explorer mode: the folder as a tree (in the sidebar), the contents of the current folder
// (icons with thumbnails, or a list) and the details of the selected item (preview, blame, history).
// Typing in the search box enters a transient search mode: the tree and the contents only show the
// matching files and folders, until the search is cleared.
// Also used for folders that are not Git repositories ("plain" folders), without the Git parts.
import * as G from './git.js?v=ceecca2';
import { esc, fmtDate, fmtRelative, fmtSize, debounce, store, icon, fileIcon } from './util.js?v=ceecca2';
import { highlighterFor } from './highlight.js?v=ceecca2';
import { invoke, convertFileSrc } from './platform.js?v=ceecca2';

const $ = (sel, root = document) => root.querySelector(sel);

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'apng']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba']);
const FONT = new Set(['ttf', 'otf', 'woff', 'woff2']);
// Files Windows can make a picture of; the others share the icon of their extension.
// SVG has no Windows thumbnail: the webview shows the file itself.
const THUMB = new Set([...IMAGE, ...VIDEO, 'tif', 'tiff', 'heic', 'heif', 'tga', 'dds', 'psd', 'exr', 'hdr', 'dng', 'cr2', 'nef', 'arw',
  'avi', 'wmv', 'mkv', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'pdf', 'docx', 'xlsx', 'pptx', 'blend', 'fbx', 'glb', 'gltf', 'obj', 'stl', '3mf',
  'ttf', 'otf', 'mp3', 'flac', 'm4a', 'wma', 'exe', 'lnk', 'url', 'cur', 'ani', 'msi']);
THUMB.delete('svg');

const MAX_ITEMS = 3000;          // items shown per folder
const MAX_RESULTS = 2000;        // search results shown
const PREVIEW_BYTES = 512 * 1024;
const PREVIEW_LINES = 5000;
const BLAME_LINES = 20000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => (b.dir - a.dir) || collator.compare(a.name, b.name);
const extOf = name => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const parentOf = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = path => path.slice(path.lastIndexOf('/') + 1);
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const gridView = () => store('exView') !== 'list';
const contentSearch = () => store('exGrep') ?? true;

// Callbacks into the app (see initExplorer).
let host = null;

// =====================================================================
// State
// =====================================================================

// Each open folder keeps its own explorer state, also while its tab is in the background.
const views = new Map();

function newView(saved = {}) {
  return {
    dir: saved.dir || '',             // folder shown in the contents ("" is the root)
    selected: saved.selected ?? null, // selected item, or null for the folder itself
    open: new Set(saved.open || []),  // folders expanded in the tree
    back: [], forward: [],            // navigation history
    tab: 'preview',                   // tab of the details
    query: '',                        // search text
    scope: '',                        // folder the search results are narrowed to
    picked: false,                    // an item was picked from the search results
    before: null,                     // the selection before the search started
  };
}

const view = () => views.get(host.repo());

// Caches of the folder being shown; reset when another one is shown.
let repo = null;
const listings = new Map();   // folder -> { entries, stale, error }
const loading = new Set();
let ignored = null;           // ignored paths (whole ignored folders end with "/")
let everything = null;        // promise of every file and folder, for searching
let search = null;            // results: { query, names, items, grep: 'pending' | 'done' | null, truncated }
const assets = new Map();     // folder -> promise of the webview being allowed to load its files
let pendingReveal = null;     // tree row to scroll into view once it is rendered

const fullPath = path => (!path ? repo : repo.endsWith('/') ? repo + path : `${repo}/${path}`);
const rootName = () => repo.split('/').filter(Boolean).pop() || repo;
const rootEntry = () => ({ name: rootName(), path: '', dir: true });
const here = () => (view().query ? view().scope : view().dir);
// The item the details are about: the selection, or else the folder being shown.
const focusPath = () => view().selected ?? here();
const active = () => !!host.repo() && host.repo() === repo && document.body.classList.contains('mode-explorer') && !!$('#main .explorer');
const assetUrl = e => `${convertFileSrc(fullPath(e.path))}?v=${e.modified || 0}`;

// =====================================================================
// API for the app
// =====================================================================

// `h`: { repo(), plain(), status(), submodules(), head(), toast, showMenu, copy, bindSplitters,
// saveSoon(), revealCommit(sha, path), revealChange(path), terminal(fullPath) }.
export function initExplorer(h) {
  host = h;
  bindSidebar();
}

export function restoreExplorer(path, saved) {
  if (!views.has(path)) views.set(path, newView(saved || {}));
}

export function captureExplorer(path) {
  const v = views.get(path);
  return v && { dir: v.dir, selected: v.query ? v.before : v.selected, open: [...v.open] };
}

export const forgetExplorer = path => views.delete(path);

// Full path of the folder being shown (e.g. to open a terminal there).
export const explorerFolder = () => (host.repo() === repo && view() ? fullPath(here()) : host.repo());

// Shows a file of the open folder: the folder it is in, with the file selected.
export function revealPath(path) {
  if (view()) navigate(parentOf(path), { select: path });
}

export function focusExplorerSearch() {
  const input = $('#ex-search');
  input.focus();
  input.select();
}

// Called when the explorer is shown and on every refresh: shows what is cached, then reloads it.
export function renderExplorer() {
  const r = host.repo();
  if (!r) return;
  if (r !== repo) {
    repo = r;
    listings.clear();
    loading.clear();
    ignored = null;
    search = null;
  } else {
    for (const l of listings.values()) l.stale = true;
  }
  everything = null;
  if (!views.has(r)) views.set(r, newView());
  if (!assets.has(r)) assets.set(r, invoke('allow_assets', { repo: r }).catch(() => {}));
  $('#ex-search').value = view().query;
  paintGrepToggle();
  if (!$('#main .explorer')) build();
  loadIgnored();
  paint();
  if (view().query) runSearch();
}

// =====================================================================
// Loading
// =====================================================================

// The entries of a folder, or null while they load. Stale entries are shown while they reload.
function listing(dir) {
  const l = listings.get(dir);
  if (!l || l.stale) load(dir);
  return l?.entries ?? null;
}

function load(dir) {
  if (loading.has(dir)) return;
  loading.add(dir);
  const r = repo;
  G.listDir(r, dir).then(raw => {
    if (r !== repo) return;
    const entries = raw.filter(e => e.name !== '.git').map(e => ({ ...e, path: dir ? `${dir}/${e.name}` : e.name })).sort(byName);
    const prev = listings.get(dir);
    listings.set(dir, { entries });
    if (!prev?.entries || JSON.stringify(prev.entries) !== JSON.stringify(entries)) schedulePaint();
  }, err => {
    if (r !== repo) return;
    listings.set(dir, { entries: [], error: String(err) });
    // The folder being shown was deleted: go to the closest one that still exists
    const v = views.get(r);
    if (v && dir && dir === v.dir && !v.query && active()) navigate(parentOf(dir), { push: false });
    else schedulePaint();
  }).finally(() => loading.delete(dir));
}

function loadIgnored() {
  if (host.plain()) { ignored = null; return; }
  const r = repo;
  G.listIgnored(r).then(list => {
    if (r !== repo) return;
    if (ignored && ignored.size === list.length && list.every(p => ignored.has(p))) return;
    ignored = new Set(list);
    schedulePaint();
  });
}

function isIgnored(e) {
  if (!ignored || !e.path) return false;
  if (ignored.has(e.dir ? e.path + '/' : e.path)) return true;
  for (let d = parentOf(e.path); d; d = parentOf(d)) if (ignored.has(d + '/')) return true;
  return false;
}

// Git status of files ("M", "A", "?", "U"...) and how many changed files each folder has.
let marks = { status: undefined, files: new Map(), dirs: new Map() };
function gitMarks() {
  const s = host.status();
  if (marks.status === s) return marks;
  const files = new Map(), dirs = new Map();
  const add = (path, st) => {
    if (files.has(path)) return;
    files.set(path, st);
    for (let d = parentOf(path); ; d = parentOf(d)) {
      dirs.set(d, (dirs.get(d) || 0) + 1);
      if (!d) break;
    }
  };
  for (const f of s?.conflicts || []) add(f.path, 'U');
  for (const f of s?.unstaged || []) add(f.path, f.status);
  for (const f of s?.staged || []) add(f.path, f.status);
  return (marks = { status: s, files, dirs });
}

const tint = st => ({ A: 'new', '?': 'new', U: 'bad', D: 'bad' })[st] || 'mod';
const letter = st => (st === '?' ? 'A' : st);
const badge = st => `<span class="st st-${esc(st)}">${esc(letter(st))}</span>`;

// =====================================================================
// Painting
// =====================================================================

function build() {
  $('#main').innerHTML = `<div class="explorer">
    <div class="ex-content">
      <div class="ex-bar"></div>
      <div class="ex-items" tabindex="0"></div>
    </div>
    <div class="splitter v" data-split="ex-detail-w" data-target="next" data-min="240"></div>
    <div class="ex-detail"></div>
  </div>`;
  const root = $('#main .explorer');
  host.bindSplitters(root);
  bindContent(root);
  detailKey = '';
  // Watches the thumbnail boxes: the pending images inside are hidden, so they never intersect.
  observer = new IntersectionObserver(list => {
    for (const en of list) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      requestThumbs(en.target);
    }
  }, { root: $('.ex-items', root), rootMargin: '400px 0px' });
}

function paint() {
  paintTree();
  paintContent();
  paintDetail();
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (active()) paint();
  });
}

// ---------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------

const pad = depth => `padding-left:${4 + depth * 14}px`;

function paintTree() {
  const el = $('#ex-tree');
  const top = el.scrollTop;
  el.innerHTML = view().query ? searchTreeHtml() : browseTreeHtml();
  el.scrollTop = top;
  if (pendingReveal != null) {
    const row = el.querySelector(`.ex-row[data-path="${CSS.escape(pendingReveal)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      pendingReveal = null;
    }
  }
}

function treeRow(e, depth, { open = false, html = null, ctx = false, tag = '' } = {}) {
  const v = view(), m = gitMarks();
  const st = !e.dir && m.files.get(e.path), dirty = e.dir && m.dirs.get(e.path);
  const cls = ['ex-row', e.dir && 'dir', open && 'open', !e.path && 'root', ctx && 'ctx', isIgnored(e) && 'ignored', e.hidden && 'hidden',
    st && `gs-${tint(st)}`, e.path === focusPath() && 'selected', v.selected != null && e.path === here() && 'current'];
  const mark = st ? `<span class="ex-st">${esc(letter(st))}</span>` : dirty ? '<span class="ex-dot"></span>' : '';
  return `<div class="${cls.filter(Boolean).join(' ')}" data-path="${esc(e.path)}"${e.dir ? ' data-dir' : ''} style="${pad(depth)}" title="${esc(e.path || repo)}">
    <span class="ex-chev">${e.dir && e.path ? icon('chevron') : ''}</span>${fileIcon(e.name, e.dir)}<span class="ex-name">${html ?? esc(e.name)}</span>${tag}${mark}</div>`;
}

function browseTreeHtml() {
  const v = view(), rows = [treeRow(rootEntry(), 0, { open: true })];
  const note = (depth, text, title = '') => `<div class="ex-row ex-note" style="${pad(depth)}" title="${esc(title)}"><span class="ex-chev"></span>${esc(text)}</div>`;
  const walk = (dir, depth) => {
    const entries = listing(dir);
    const error = listings.get(dir)?.error;
    if (error) return rows.push(note(depth, 'Can\'t read this folder', error));
    if (!entries) return rows.push(note(depth, 'Loading…'));
    for (const e of entries.slice(0, MAX_ITEMS)) {
      const open = e.dir && v.open.has(e.path);
      rows.push(treeRow(e, depth, { open }));
      if (open) walk(e.path, depth + 1);
    }
    if (entries.length > MAX_ITEMS) rows.push(note(depth, `…and ${plural(entries.length - MAX_ITEMS, 'more item')}`));
  };
  walk('', 1);
  return rows.join('');
}

const contentTag = '<span class="ex-tag" title="The text was found inside the file">text</span>';

// The search results nested in their folders, all expanded.
function searchTreeHtml() {
  if (!search) return '<div class="ex-empty">Searching…</div>';
  if (search.error) return `<div class="ex-empty">${esc(search.error)}</div>`;
  if (!search.items.length) return `<div class="ex-empty">${search.grep === 'pending' ? 'Searching…' : 'No matches'}</div>`;
  const root = { ...rootEntry(), kids: new Map() };
  for (const it of search.items) {
    let node = root;
    const parts = it.path.split('/');
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      let kid = node.kids.get(part);
      if (!kid) node.kids.set(part, kid = { name: part, path: last ? it.path : parts.slice(0, i + 1).join('/'), dir: !last || it.dir, kids: new Map() });
      node = kid;
    });
    node.item = it;
  }
  const terms = searchTerms(), rows = [];
  const walk = (node, depth) => {
    rows.push(treeRow(node, depth, {
      open: node.dir, ctx: !!node.path && !node.item,
      html: node.item ? markName(node.name, terms) : null, tag: node.item?.content ? contentTag : '',
    }));
    [...node.kids.values()].sort(byName).forEach(k => walk(k, depth + 1));
  };
  walk(root, 0);
  return rows.join('');
}

// ---------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------

let observer = null;

// Items of the contents: the folder's entries, or the search results inside the search scope.
function contentItems() {
  const v = view();
  if (!v.query) return listing(v.dir);
  if (!search) return null;
  return v.scope ? search.items.filter(it => it.path.startsWith(v.scope + '/')) : search.items;
}

function paintContent() {
  const v = view(), el = $('.ex-items');
  const list = contentItems();
  paintBar(list);
  if (!list) {
    if (!el.querySelector('[data-path]')) el.innerHTML = '<div class="placeholder">Loading…</div>';
    return;
  }
  const shown = v.query ? `?${v.query}\n${v.scope}` : v.dir;
  const same = el.dataset.shown === shown;
  const top = el.scrollTop;
  const error = !v.query && listings.get(v.dir)?.error;
  observer.disconnect();
  if (error) el.innerHTML = `<div class="placeholder">Can't read this folder<br><span class="muted">${esc(error)}</span></div>`;
  else if (!list.length) {
    el.innerHTML = `<div class="placeholder">${!v.query ? 'This folder is empty'
      : search.grep === 'pending' ? 'Searching…' : `No matches for “${esc(v.query)}”${host.plain() ? '' : '<br><span class="muted">Files ignored by Git are not searched</span>'}`}</div>`;
  } else el.innerHTML = gridView() ? gridHtml(list) : listHtml(list);
  el.dataset.shown = shown;
  if (same) el.scrollTop = top;
  else {
    el.scrollTop = 0;
    el.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }
  el.querySelectorAll('img.thumb.pending').forEach(img => observer.observe(img.parentElement));
}

function paintBar(list) {
  const v = view(), bar = $('.ex-bar');
  const nav = (act, ic, title, disabled) => `<button class="ex-navbtn" data-ex-nav="${act}" title="${title}"${disabled ? ' disabled' : ''}>${icon(ic)}</button>`;
  let crumbs;
  if (v.query) {
    crumbs = `<span class="ex-results" title="Search results — Esc to close">${icon('search')}<span class="ex-rtext">“${esc(v.query)}”</span></span>`
      + (v.scope ? `<span class="ex-scope" title="${esc(v.scope)}">in ${esc(nameOf(v.scope))}<button data-ex-nav="unscope" title="Search the whole folder">${icon('close')}</button></span>` : '');
  } else {
    const parts = v.dir ? v.dir.split('/') : [];
    crumbs = [`<button class="ex-crumb" data-crumb="" title="${esc(repo)}">${esc(rootName())}</button>`,
      ...parts.map((p, i) => `${icon('chevron', 'ex-csep')}<button class="ex-crumb" data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`)].join('');
  }
  let count = '';
  if (list && v.query) {
    count = `${plural(list.length, 'result')}${search?.truncated ? ' (more not shown)' : ''}${search?.grep === 'pending' ? ' · searching inside files…' : ''}`;
  } else if (list) count = plural(list.length, 'item');
  const grid = gridView();
  bar.innerHTML = `${nav('back', 'back', v.query ? 'Close the search (Esc)' : 'Back (Alt+Left)', !v.query && !v.back.length)}
    ${nav('forward', 'forward', 'Forward (Alt+Right)', !!v.query || !v.forward.length)}
    ${nav('up', 'up', 'Up one level (Backspace)', !!v.query || !v.dir)}
    <div class="ex-crumbs">${crumbs}</div><span class="ex-count">${count}</span>
    <div class="diff-mode ex-viewmode"><button data-ex-view="grid" class="${grid ? 'on' : ''}" title="Icons">${icon('grid')}</button><button data-ex-view="list" class="${grid ? '' : 'on'}" title="List">${icon('list')}</button></div>`;
}

const more = list => (list.length > MAX_ITEMS ? `<div class="ex-more">Showing ${plural(MAX_ITEMS, 'item')} of ${list.length.toLocaleString('en-US')}</div>` : '');

function tip(e) {
  return [e.path || repo, e.dir ? '' : e.size != null ? fmtSize(e.size) : '', e.modified ? `Modified ${fmtDate(e.modified)}` : ''].filter(Boolean).join('\n');
}

function itemClasses(base, e, st) {
  return [base, isIgnored(e) && 'ignored', e.hidden && 'hidden', st && `gs-${tint(st)}`, e.path === view().selected && 'selected'].filter(Boolean).join(' ');
}

function gridHtml(list) {
  const v = view(), m = gitMarks(), terms = v.query ? searchTerms() : null;
  return `<div class="ex-grid">${list.slice(0, MAX_ITEMS).map(e => {
    const st = !e.dir && m.files.get(e.path), dirty = e.dir && m.dirs.get(e.path);
    const sub = v.query ? `<div class="ex-sub">${e.content ? 'text · ' : ''}${esc(parentOf(e.path) || rootName())}</div>` : '';
    return `<div class="${itemClasses('ex-tile', e, st)}" data-path="${esc(e.path)}"${e.dir ? ' data-dir' : ''} title="${esc(tip(e))}">
      <div class="ex-thumb">${thumbHtml(e, 128)}${st ? badge(st) : dirty ? '<span class="ex-dot"></span>' : ''}</div>
      <div class="ex-label">${terms ? markName(e.name, terms) : esc(e.name)}</div>${sub}</div>`;
  }).join('')}</div>${more(list)}`;
}

function listHtml(list) {
  const v = view(), m = gitMarks(), terms = v.query ? searchTerms() : null;
  const head = v.query ? '<span>Name</span><span>Folder</span>' : '<span>Name</span><span>Modified</span><span class="num">Size</span>';
  const rows = list.slice(0, MAX_ITEMS).map(e => {
    const st = !e.dir && m.files.get(e.path), dirty = e.dir && m.dirs.get(e.path);
    const cols = v.query ? `<span class="muted ellip">${esc(parentOf(e.path) || rootName())}</span>`
      : `<span class="muted ellip">${e.modified ? esc(fmtDate(e.modified)) : ''}</span><span class="num muted">${e.dir ? '' : esc(fmtSize(e.size))}</span>`;
    return `<div class="${itemClasses('ex-lrow', e, st)}" data-path="${esc(e.path)}"${e.dir ? ' data-dir' : ''} title="${esc(tip(e))}">
      <span class="ex-lname">${fileIcon(e.name, e.dir)}<span class="ex-name">${terms ? markName(e.name, terms) : esc(e.name)}</span>${e.content ? contentTag : ''}${st ? `<span class="ex-st">${esc(letter(st))}</span>` : dirty ? '<span class="ex-dot"></span>' : ''}</span>${cols}</div>`;
  }).join('');
  return `<div class="ex-list${v.query ? ' search' : ''}"><div class="ex-lhead">${head}</div>${rows}</div>${more(list)}`;
}

// ---------------------------------------------------------------------
// Thumbnails (made by Windows, like in its Explorer)
// ---------------------------------------------------------------------

const thumbs = new Map();     // key -> data URL ('' when there is none)
const thumbJobs = new Map();  // key -> promise of the data URL
const thumbQueue = [];
let thumbsRunning = 0;

// Files with a picture of their own are keyed by path and version; the others by extension.
function thumbHtml(e, size) {
  const ext = e.dir ? '' : extOf(e.name);
  const fallback = fileIcon(e.name, e.dir);
  if (ext === 'svg') return `<img class="thumb photo" src="${esc(assetUrl(e))}" alt="" onerror="this.remove()">${fallback}`;
  const own = !e.dir && THUMB.has(ext);
  const key = own ? `${size}|${fullPath(e.path)}|${e.modified ?? ''}|${e.size ?? ''}` : `${size}|${e.dir ? '/' : '.' + ext}`;
  const photo = IMAGE.has(ext) ? ' photo' : '';
  const url = thumbs.get(key);
  if (url) return `<img class="thumb${photo}" src="${url}" alt="">`;
  if (url === '') return fallback;
  return `<img class="thumb pending${photo}" data-key="${esc(key)}" data-src="${esc(fullPath(e.path))}" data-size="${size}"${own ? '' : ' data-icon-only'} alt="">${fallback}`;
}

function requestThumb(img) {
  const key = img.dataset.key;
  getThumb(key, img.dataset.src, +img.dataset.size, 'iconOnly' in img.dataset).then(url => {
    if (url == null) return;
    document.querySelectorAll(`img.thumb.pending[data-key="${CSS.escape(key)}"]`).forEach(el => {
      if (!url) return el.remove();
      el.src = url;
      el.classList.remove('pending');
    });
  });
}

const requestThumbs = root => root.querySelectorAll('img.thumb.pending').forEach(requestThumb);

function getThumb(key, path, size, iconOnly) {
  if (thumbs.has(key)) return Promise.resolve(thumbs.get(key));
  if (!thumbJobs.has(key)) thumbJobs.set(key, new Promise(resolve => { thumbQueue.push({ key, path, size, iconOnly, resolve }); pumpThumbs(); }));
  return thumbJobs.get(key);
}

// A few at a time, most recently requested first (what just scrolled into view).
function pumpThumbs() {
  while (thumbsRunning < 4 && thumbQueue.length) {
    const job = thumbQueue.pop();
    if (!document.querySelector(`img.thumb.pending[data-key="${CSS.escape(job.key)}"]`)) {
      thumbJobs.delete(job.key); // no longer shown
      job.resolve(null);
      continue;
    }
    thumbsRunning++;
    invoke('thumbnail', { path: job.path, size: job.size, iconOnly: job.iconOnly })
      .then(toDataUrl, () => '')
      .then(url => {
        thumbsRunning--;
        thumbJobs.delete(job.key);
        // An extension's icon failing for one file may work for another one
        if (url || !job.iconOnly) thumbs.set(job.key, url);
        job.resolve(url);
        pumpThumbs();
      });
  }
}

// Raw thumbnail: width and height (u32 little endian), then RGBA pixels.
function toDataUrl(data) {
  const buf = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
  const dv = new DataView(buf), w = dv.getUint32(0, true), h = dv.getUint32(4, true);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
  return c.toDataURL();
}

// =====================================================================
// Details
// =====================================================================

let detailKey = '', detailToken = 0;

const findEntry = path => (path === '' ? rootEntry() : listings.get(parentOf(path))?.entries.find(e => e.path === path)
  || search?.items.find(it => it.path === path));

// Repainted only when what it shows changed, so a refresh doesn't restart a video or lose the scroll.
function paintDetail(force = false) {
  const el = $('.ex-detail');
  if (!el) return;
  const v = view(), path = focusPath(), known = findEntry(path), m = gitMarks();
  const key = [repo, path, known?.modified, known?.size, m.files.get(path), m.dirs.get(path), isIgnored({ path, dir: known?.dir }),
    v.tab, host.head(), v.query && contentSearch() ? v.query : ''].join('\n');
  if (!force && key === detailKey) return;
  detailKey = key;
  showDetail(el, path, known, ++detailToken);
}

const kindNames = { pdf: 'PDF document', md: 'Markdown document', txt: 'Text document' };

function kindOf(e) {
  if (!e.path) return host.plain() ? 'Folder' : 'Repository';
  if (e.dir) return host.submodules().some(s => s.path === e.path) ? 'Submodule' : 'Folder';
  const ext = extOf(e.name), up = ext.toUpperCase();
  if (kindNames[ext]) return kindNames[ext];
  if (IMAGE.has(ext)) return `${up} image`;
  if (VIDEO.has(ext)) return `${up} video`;
  if (AUDIO.has(ext)) return `${up} audio`;
  if (FONT.has(ext)) return `${up} font`;
  return ext ? `${up} file` : 'File';
}

// [css class, text] describing the item for Git.
function gitState(e) {
  if (isIgnored(e)) return ['muted', 'Ignored'];
  const m = gitMarks();
  if (e.dir) {
    const n = m.dirs.get(e.path) || 0;
    return n ? ['mod', `${plural(n, 'changed file')} inside`] : ['', 'No changes'];
  }
  const s = host.status();
  if (!s) return ['', ''];
  if (s.conflicts.some(f => f.path === e.path)) return ['bad', 'Conflicted'];
  const u = s.unstaged.find(f => f.path === e.path), sg = s.staged.find(f => f.path === e.path);
  if (u?.untracked) return ['new', 'Untracked'];
  const words = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
  if (sg && u) return ['mod', `${words[sg.status] || 'Changed'} · partly staged`];
  if (sg) return [sg.status === 'A' ? 'new' : 'mod', `${words[sg.status] || 'Changed'} · staged`];
  if (u) return ['mod', words[u.status] || 'Changed'];
  return ['', 'Unchanged'];
}

async function showDetail(el, path, known, token) {
  let e = known;
  if (!e || (path && e.modified == null)) {
    const s = await G.statPath(repo, path).catch(() => null);
    if (token !== detailToken) return;
    if (!s) {
      el.dataset.path = '';
      el.innerHTML = '<div class="placeholder">This item no longer exists</div>';
      return;
    }
    e = { ...s, path, name: path ? nameOf(path) : rootName(), content: known?.content };
  }
  const v = view(), plain = host.plain();
  const st = !e.dir ? gitMarks().files.get(path) : null;
  const tracked = !plain && !isIgnored(e) && st !== '?';
  const tabs = e.dir ? (tracked ? ['history'] : []) : ['preview', ...(tracked ? ['blame', 'history'] : [])];
  const tab = tabs.includes(v.tab) ? v.tab : tabs[0];
  const labels = { preview: 'Preview', blame: 'Blame', history: 'History' };

  const btn = (act, label, ic = '') => `<button class="btn-sm" data-exd-act="${act}">${ic && icon(ic)}${label}</button>`;
  const actions = e.dir
    ? [path !== here() && btn('open', 'Open', 'folder'), btn('explorer', 'Show in Explorer'), btn('terminal', 'Terminal', 'terminal'), btn('copy', 'Copy path')]
    : [btn('open', 'Open', 'open'), btn('explorer', 'Show in Explorer'), btn('copy', 'Copy path'), st && st !== 'D' && btn('changes', 'View changes', 'changes')];
  const [gcls, gtext] = plain ? [] : gitState(e);
  const row = (k, value, hidden = false) => `<dt data-k="${k}"${hidden ? ' hidden' : ''}>${k}</dt><dd data-k="${k}"${hidden ? ' hidden' : ''}>${value}</dd>`;
  const location = path ? esc(parentOf(path) || rootName()) : esc(repo);
  const size = e.size >= 1024 ? `${esc(fmtSize(e.size))} <span class="muted">(${e.size.toLocaleString('en-US')} bytes)</span>` : esc(fmtSize(e.size));
  el.dataset.path = path;
  el.dataset.dir = e.dir ? '1' : '';
  el.innerHTML = `
    <div class="exd-info">
      <div class="exd-head"><div class="exd-thumb">${thumbHtml(e, 128)}</div>
        <div class="exd-title"><div class="exd-name">${esc(e.name)}</div><div class="exd-kind">${esc(kindOf(e))}${e.dir ? '' : ` · ${esc(fmtSize(e.size))}`}</div></div></div>
      <div class="exd-actions">${actions.filter(Boolean).join('')}</div>
      <dl class="kv exd-kv">
        ${row('Location', location)}
        ${row('Contents', '', true)}
        ${e.dir ? '' : row('Size', size)}
        ${row('Dimensions', '', true)}${row('Duration', '', true)}${row('Lines', '', true)}
        ${e.modified ? row('Modified', `${esc(fmtDate(e.modified))} <span class="muted">· ${esc(fmtRelative(e.modified))}</span>`) : ''}
        ${e.created ? row('Created', esc(fmtDate(e.created))) : ''}
        ${gtext ? row('Git', `<span class="gs-${gcls}">${esc(gtext)}</span>`) : ''}
      </dl>
      <div class="exd-last"></div>
    </div>
    ${tabs.length ? `<div class="exd-tabs">${tabs.map(t => `<button class="exd-tab ${t === tab ? 'on' : ''}" data-exd-tab="${t}">${labels[t]}</button>`).join('')}</div>` : ''}
    <div class="exd-view"></div>`;
  requestThumbs(el);

  if (e.dir) {
    G.listDir(repo, path).then(list => {
      const items = list.filter(x => x.name !== '.git'), dirs = items.filter(x => x.dir).length;
      setKv(token, 'Contents', `${plural(dirs, 'folder')}, ${plural(items.length - dirs, 'file')}`);
    }, () => {});
  }
  if (tracked) {
    G.getPathLog(repo, path, { limit: 1 }).then(([c]) => {
      if (token !== detailToken || !c) return;
      $('.exd-last', el).innerHTML = `<div class="exd-lbl">Last commit</div>${commitHtml(c, 'exd-commit')}`;
    });
  }
  const body = $('.exd-view', el);
  if (tab === 'preview') preview(e, body, token);
  else if (tab === 'blame') blame(e, body, token);
  else if (tab === 'history') history(e, body, token);
}

function setKv(token, key, value) {
  if (token !== detailToken) return;
  document.querySelectorAll(`.exd-kv [data-k="${key}"]`).forEach(el => {
    el.hidden = false;
    if (el.tagName === 'DD') el.innerHTML = esc(value);
  });
}

const commitHtml = (c, cls) => `<div class="${cls}" data-sha="${c.sha}" title="Show this commit in the history">
  <div class="exd-csub">${esc(c.subject)}</div>
  <div class="exd-cmeta">${esc(c.author)} · <span title="${esc(fmtDate(c.time))}">${esc(fmtRelative(c.time))}</span> · <span class="mono">${c.sha.slice(0, 7)}</span></div></div>`;

function fmtDuration(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------

async function preview(e, el, token) {
  const ext = extOf(e.name);
  const media = IMAGE.has(ext) || VIDEO.has(ext) || AUDIO.has(ext) || FONT.has(ext) || ext === 'pdf';
  if (media) {
    await assets.get(repo);
    if (token !== detailToken) return;
  }
  if (IMAGE.has(ext)) {
    el.innerHTML = `<div class="exd-media"><img class="checker" src="${esc(assetUrl(e))}" alt=""></div>`;
    const img = $('img', el);
    img.onload = () => setKv(token, 'Dimensions', `${img.naturalWidth} × ${img.naturalHeight} pixels`);
    img.onerror = () => noPreview(e, el, token, 'This image can\'t be shown here.');
    return;
  }
  if (VIDEO.has(ext) || AUDIO.has(ext)) {
    const tag = VIDEO.has(ext) ? 'video' : 'audio';
    el.innerHTML = `<div class="exd-media"><${tag} src="${esc(assetUrl(e))}" controls preload="metadata"></${tag}></div>`;
    const m = $(tag, el);
    m.onloadedmetadata = () => {
      if (m.videoWidth) setKv(token, 'Dimensions', `${m.videoWidth} × ${m.videoHeight} pixels`);
      if (isFinite(m.duration)) setKv(token, 'Duration', fmtDuration(m.duration));
    };
    m.onerror = () => noPreview(e, el, token, `This ${tag} format can't be played here.`);
    return;
  }
  if (ext === 'pdf') {
    el.innerHTML = `<iframe class="exd-pdf" src="${esc(assetUrl(e))}"></iframe>`;
    return;
  }
  if (FONT.has(ext)) return fontPreview(e, el, token);
  if (!e.size) {
    el.innerHTML = '<div class="placeholder">Empty file</div>';
    return;
  }
  el.innerHTML = '<div class="placeholder">Loading…</div>';
  let p;
  try {
    p = await G.readPreview(repo, e.path, PREVIEW_BYTES);
  } catch (err) {
    if (token === detailToken) el.innerHTML = `<div class="placeholder">${esc(String(err))}</div>`;
    return;
  }
  if (token !== detailToken) return;
  if (p.binary) return noPreview(e, el, token);
  if (p.size < 1024 && /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(p.text)) {
    const size = p.text.match(/^size (\d+)/m)?.[1];
    el.innerHTML = `<div class="info-card"><h3>Git LFS file not downloaded</h3>
      <p>Only its pointer is in the working copy${size ? ` (the file has ${esc(fmtSize(+size))})` : ''}. Download the LFS files to see it.</p></div>`;
    return;
  }
  const hit = view().query && contentSearch() ? view().query : null;
  const { html, lines } = codeView(p.text, e.path, { truncated: p.truncated, hit });
  el.innerHTML = html;
  if (!p.truncated) setKv(token, 'Lines', lines.toLocaleString('en-US'));
  const first = el.querySelector('tr.hit');
  if (first) el.scrollTop = first.offsetTop - el.clientHeight / 3;
}

// Syntax-highlighted text with line numbers. Lines containing `hit` are marked.
function codeView(text, path, { truncated = false, hit = null } = {}) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, PREVIEW_LINES);
  const hl = highlighterFor(path), st = {}, q = hit?.toLowerCase();
  const rows = shown.map((l, i) => `<tr${q && l.toLowerCase().includes(q) ? ' class="hit"' : ''}><td class="ln">${i + 1}</td><td class="code">${hl ? hl(l, st) : esc(l)}</td></tr>`).join('');
  const cut = truncated || lines.length > shown.length
    ? `<tr class="d-trunc"><td colspan="2">Showing the first ${shown.length.toLocaleString('en-US')} lines — open the file to see all of it.</td></tr>` : '';
  return { html: `<table class="diff code-view"><tbody>${rows}${cut}</tbody></table>`, lines: lines.length };
}

function noPreview(e, el, token, message = 'No preview for this type of file.') {
  if (token !== detailToken) return;
  el.innerHTML = `<div class="exd-none"><div class="exd-big">${thumbHtml(e, 256)}</div><p>${esc(message)}</p>
    <button class="btn-sm" data-exd-act="open">${icon('open')}Open with the default app</button></div>`;
  requestThumbs(el);
}

let fontSeq = 0;
function fontPreview(e, el, token) {
  const family = `exd-font-${++fontSeq}`;
  new FontFace(family, `url("${assetUrl(e)}")`).load().then(face => {
    if (token !== detailToken) return;
    document.fonts.add(face);
    const sample = 'The quick brown fox jumps over the lazy dog';
    el.innerHTML = `<div class="exd-font" style="font-family: '${family}'">
      ${[36, 24, 16, 12].map(s => `<div style="font-size: ${s}px">${sample}</div>`).join('')}
      <div style="font-size: 20px">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 !?&amp;@#%(){}</div></div>`;
  }, () => noPreview(e, el, token, 'This font can\'t be loaded.'));
}

// ---------------------------------------------------------------------
// Blame and history
// ---------------------------------------------------------------------

async function blame(e, el, token) {
  el.innerHTML = '<div class="placeholder">Loading blame…</div>';
  let b;
  try {
    const head = await G.readPreview(repo, e.path, 8000);
    if (head.binary) throw new Error('Blame is only available for text files.');
    b = await G.getBlame(repo, e.path);
  } catch (err) {
    if (token === detailToken) el.innerHTML = `<div class="placeholder">${esc(err.message || String(err))}</div>`;
    return;
  }
  if (token !== detailToken) return;
  if (!b.lines.length) {
    el.innerHTML = '<div class="placeholder">Empty file</div>';
    return;
  }
  const hl = highlighterFor(e.path), st = {};
  const times = [...b.commits.values()].map(c => c.time).filter(Boolean);
  const min = Math.min(...times), max = Math.max(...times);
  const shown = b.lines.slice(0, BLAME_LINES);
  // Each block of lines from the same commit shows its author and date, then its subject;
  // the bar on the left gets stronger the more recent the commit is.
  const rows = shown.map((l, i) => {
    const c = b.commits.get(l.sha), fresh = /^0+$/.test(l.sha);
    const first = i === 0 || shown[i - 1].sha !== l.sha;
    const second = !first && (i === 1 || shown[i - 2].sha !== l.sha);
    const age = fresh || max <= min ? 1 : (c.time - min) / (max - min);
    let gutter = '';
    if (first) gutter = fresh ? '<span class="bl-who">Not committed yet</span>'
      : `<span class="bl-who">${esc(c.author)}</span><span class="bl-when">${esc(fmtRelative(c.time))}</span>`;
    else if (second && !fresh) gutter = `<span class="bl-sum">${esc(c.summary)}</span>`;
    const title = fresh ? 'Changed since the last commit — click to see the changes' : `${c.summary}\n${c.author}, ${fmtDate(c.time)}\n${l.sha.slice(0, 7)} — click to show it in the history`;
    const data = fresh ? 'data-new' : `data-sha="${l.sha}"`;
    return `<tr class="${first ? 'bl-first' : ''}${fresh ? ' bl-new' : ''}"><td class="bl" ${data} style="--age: ${(0.12 + age * 0.88).toFixed(2)}" title="${esc(title)}">${gutter}</td><td class="ln">${i + 1}</td><td class="code">${hl ? hl(l.text, st) : esc(l.text)}</td></tr>`;
  }).join('');
  const cut = b.lines.length > shown.length ? `<tr class="d-trunc"><td colspan="3">Showing the first ${shown.length.toLocaleString('en-US')} lines.</td></tr>` : '';
  el.innerHTML = `<table class="diff code-view blame"><tbody>${rows}${cut}</tbody></table>`;
}

async function history(e, el, token) {
  el.innerHTML = '<div class="placeholder">Loading history…</div>';
  const log = await G.getPathLog(repo, e.path, { limit: 300, follow: !e.dir });
  if (token !== detailToken) return;
  el.innerHTML = log.length ? `<div class="exd-history">${log.map(c => commitHtml(c, 'exd-hrow')).join('')}</div>`
    : '<div class="placeholder">No commits yet</div>';
}

// =====================================================================
// Navigation and selection
// =====================================================================

function navigate(dir, { push = true, select = null } = {}) {
  const v = view();
  if (v.query) clearSearch();
  if (push && dir !== v.dir) {
    v.back.push(v.dir);
    v.forward = [];
  }
  v.dir = dir;
  v.selected = select;
  for (let d = dir; d; d = parentOf(d)) v.open.add(d);
  pendingReveal = select ?? dir;
  paint();
  host.saveSoon();
}

function goUp() {
  const v = view();
  if (v.dir && !v.query) navigate(parentOf(v.dir), { select: v.dir });
}

// Going back to a parent folder selects the folder we came from.
function goBack() {
  const v = view();
  if (v.query) return endSearch();
  if (!v.back.length) return;
  const from = v.dir, to = v.back.pop();
  v.forward.push(from);
  navigate(to, { push: false, select: parentOf(from) === to && from ? from : null });
}

function goForward() {
  const v = view();
  if (v.query || !v.forward.length) return;
  const from = v.dir, to = v.forward.pop();
  v.back.push(from);
  navigate(to, { push: false, select: parentOf(from) === to && from ? from : null });
}

function select(path, { scroll = false } = {}) {
  const v = view();
  v.selected = path;
  if (v.query && path != null) v.picked = true;
  paintSelection();
  paintDetail();
  if (scroll && path != null) document.querySelector(`.ex-items [data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
  host.saveSoon();
}

function paintSelection() {
  const v = view(), focus = focusPath(), cur = here();
  document.querySelectorAll('.ex-items [data-path]').forEach(el => el.classList.toggle('selected', el.dataset.path === v.selected));
  document.querySelectorAll('#ex-tree .ex-row[data-path]').forEach(el => {
    el.classList.toggle('selected', el.dataset.path === focus);
    el.classList.toggle('current', v.selected != null && el.dataset.path === cur);
  });
}

// Double click or Enter: folders are opened here, files with their default program.
function activate(path, dir) {
  if (dir) return navigate(path);
  G.openPath(repo, path).catch(err => host.toast('Could not open the file', 'error', String(err)));
}

function toggleOpen(path) {
  const v = view();
  if (v.open.has(path)) v.open.delete(path);
  else v.open.add(path);
  paintTree();
  host.saveSoon();
}

const showInExplorer = path => invoke('show_in_explorer', { repo, path }).catch(err => host.toast('Show in Explorer failed', 'error', String(err)));

function showTab(path, tab) {
  view().tab = tab;
  if (view().selected !== path) select(path, { scroll: true });
  paintDetail(true);
}

function itemMenu(x, y, path, dir) {
  const v = view(), full = fullPath(path), plain = host.plain();
  const st = !dir && gitMarks().files.get(path);
  const tracked = !plain && !isIgnored({ path, dir }) && st !== '?';
  host.showMenu(x, y, [
    { label: dir ? 'Open' : 'Open with the default app', disabled: dir && path === here(), run: () => activate(path, dir) },
    ...(v.query && path ? [{ label: dir ? 'Show folder location' : 'Show file location', run: () => navigate(parentOf(path), { select: path }) }] : []),
    { label: 'Show in Explorer', run: () => showInExplorer(path) },
    ...(dir ? [{ label: 'Open terminal here', run: () => host.terminal(full) }] : []),
    '-',
    { label: 'Copy path', run: () => host.copy(path || '.') },
    { label: 'Copy full path', run: () => host.copy(full.replace(/\//g, '\\')) },
    ...(plain ? [] : [
      '-',
      ...(st && st !== 'D' ? [{ label: 'View changes', run: () => host.revealChange(path) }] : []),
      ...(dir ? [] : [{ label: 'Blame', disabled: !tracked, run: () => showTab(path, 'blame') }]),
      { label: 'Show history', disabled: !tracked, run: () => showTab(path, 'history') },
    ]),
  ]);
}

// =====================================================================
// Search
// =====================================================================

let searchToken = 0;
const searchSoon = debounce(() => runSearch(), 120);
const grepSoon = debounce((q, token) => runGrep(q, token), 300);
const searchTerms = () => view().query.toLowerCase().split(/\s+/).filter(Boolean);

function setQuery(text) {
  const v = view(), q = text.trim();
  if (!v || q === v.query) return;
  if (!q) return endSearch();
  if (!v.query) {
    v.before = v.selected;
    v.selected = null;
    v.picked = false;
    v.scope = '';
    $('#ex-tree').scrollTop = 0;
  }
  v.query = q;
  paint();
  searchSoon();
}

function clearSearch() {
  const v = view();
  v.query = '';
  v.scope = '';
  v.picked = false;
  v.before = null;
  search = null;
  searchToken++;
  $('#ex-search').value = '';
}

// Leaving the search goes back to where it started, or to the item picked from the results.
function endSearch() {
  const v = view(), picked = v.picked ? v.selected : null, before = v.before;
  clearSearch();
  if (picked != null) return navigate(parentOf(picked), { select: picked });
  v.selected = before;
  pendingReveal = focusPath();
  paint();
}

async function runSearch() {
  const v = view(), q = v?.query, token = ++searchToken;
  if (!q) return;
  let all;
  try {
    all = await allItems();
  } catch (e) {
    if (token === searchToken) {
      search = { query: q, items: [], names: [], error: e.message || String(e) };
      paint();
    }
    return;
  }
  if (token !== searchToken) return;
  const names = matchNames(all.list, q);
  const grep = contentSearch() && q.length >= 3;
  search = { query: q, names, items: names.slice(0, MAX_RESULTS), truncated: names.length > MAX_RESULTS || all.truncated, grep: grep ? 'pending' : null };
  paint();
  if (grep) grepSoon(q, token);
}

// Files whose text contains the search are added after the ones whose name matches.
async function runGrep(q, token) {
  const files = await G.grepFiles(repo, q, host.plain()).catch(() => []);
  if (token !== searchToken || search?.query !== q) return;
  const have = new Set(search.names.map(it => it.path));
  const content = files.filter(p => !have.has(p)).sort(collator.compare).map(p => ({ path: p, name: nameOf(p), dir: false, content: true }));
  const all = [...search.names, ...content];
  search = { ...search, items: all.slice(0, MAX_RESULTS), truncated: search.truncated || all.length > MAX_RESULTS, grep: 'done' };
  paint();
}

// Every file and folder: from Git (tracked and untracked files, not the ignored ones),
// or by walking the folder when it is not a repository.
function allItems() {
  if (everything) return everything;
  const r = repo;
  const source = host.plain() ? G.walkDir(r) : G.listFiles(r).then(paths => {
    const subs = new Set(host.submodules().map(s => s.path));
    const gone = new Set((host.status()?.unstaged || []).filter(f => f.status === 'D').map(f => f.path));
    const files = [], dirs = new Set();
    for (const p of paths) {
      if (gone.has(p)) continue;
      if (subs.has(p)) dirs.add(p);
      else files.push(p);
      for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
        const d = p.slice(0, i);
        if (dirs.has(d)) break;
        dirs.add(d);
      }
    }
    return { files, dirs: [...dirs], truncated: false };
  });
  const p = everything = source.then(({ files, dirs, truncated }) => ({
    truncated,
    list: [...dirs.map(path => ({ path, dir: true })), ...files.map(path => ({ path, dir: false }))].map(it => {
      const name = nameOf(it.path);
      return { ...it, name, lname: name.toLowerCase(), lpath: it.path.toLowerCase() };
    }),
  }));
  p.catch(() => { if (everything === p) everything = null; });
  return p;
}

// Every word must be in the name (words with "/" are looked for in the whole path).
// Exact names first, then names starting with the first word.
function matchNames(list, q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean), first = terms[0];
  const hits = list.filter(it => terms.every(t => (t.includes('/') ? it.lpath : it.lname).includes(t)));
  const rank = it => (it.lname === first ? 0 : it.lname.startsWith(first) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || b.dir - a.dir || collator.compare(a.path, b.path));
}

function markName(name, terms) {
  const words = terms.filter(t => !t.includes('/'));
  if (!words.length) return esc(name);
  const re = new RegExp(words.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '', last = 0;
  for (const m of name.matchAll(re)) {
    out += `${esc(name.slice(last, m.index))}<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(name.slice(last));
}

function paintGrepToggle() {
  const b = $('#ex-grep'), on = contentSearch();
  b.innerHTML = icon('text');
  b.classList.toggle('on', on);
  b.title = on ? 'Searching names and text inside files — click to search names only' : 'Searching names only — click to also search inside files';
}

// =====================================================================
// Events
// =====================================================================

function bindSidebar() {
  const input = $('#ex-search'), tree = $('#ex-tree');
  input.insertAdjacentHTML('beforebegin', icon('search'));
  input.addEventListener('input', () => setQuery(input.value));
  input.addEventListener('keydown', e => {
    if (!view()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (view().query) endSearch();
      else input.blur();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      const items = $('.ex-items');
      items?.focus();
      const first = items?.querySelector('[data-path]');
      if (view().selected == null && first) select(first.dataset.path, { scroll: true });
    }
  });
  $('#ex-grep').addEventListener('click', () => {
    store('exGrep', !contentSearch());
    paintGrepToggle();
    if (view()?.query) runSearch();
  });

  tree.addEventListener('mousedown', e => {
    if (e.button === 0 && e.target.closest('.ex-chev')) e.preventDefault(); // keeps the focus where it is
  });
  tree.addEventListener('click', e => {
    const row = e.target.closest('.ex-row[data-path]');
    if (row) treePick(row, !!e.target.closest('.ex-chev'));
  });
  tree.addEventListener('dblclick', e => {
    const row = e.target.closest('.ex-row[data-path]');
    if (row && !('dir' in row.dataset)) activate(row.dataset.path, false);
  });
  tree.addEventListener('contextmenu', e => {
    const row = e.target.closest('.ex-row[data-path]');
    if (!row) return;
    e.preventDefault();
    itemMenu(e.clientX, e.clientY, row.dataset.path, 'dir' in row.dataset);
  });
  tree.addEventListener('keydown', e => {
    const rows = [...tree.querySelectorAll('.ex-row[data-path]')];
    const i = rows.findIndex(r => r.classList.contains('selected'));
    const row = rows[i];
    if (!row) return;
    const path = row.dataset.path, dir = 'dir' in row.dataset, open = row.classList.contains('open');
    const go = r => {
      if (!r) return;
      treePick(r, false);
      pendingReveal = r.dataset.path;
      tree.querySelector(`.ex-row[data-path="${CSS.escape(r.dataset.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(rows[i + 1]);
    else if (e.key === 'ArrowUp') go(rows[i - 1]);
    else if (e.key === 'ArrowRight') {
      if (dir && path && !open && !view().query) toggleOpen(path);
      else if (dir) go(rows[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (dir && path && open && !view().query) toggleOpen(path);
      else if (path) go(rows.find(r => r.dataset.path === parentOf(path)));
    } else if (e.key === 'Enter') activate(path, dir);
    else return;
    e.preventDefault();
  });

  // Back and forward: Alt+arrows and the mouse's side buttons
  window.addEventListener('keydown', e => {
    if (!active() || !e.altKey || e.ctrlKey || e.target.closest('input, textarea')) return;
    const fn = { ArrowLeft: goBack, ArrowRight: goForward, ArrowUp: goUp }[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  });
  window.addEventListener('mouseup', e => {
    if (!active() || (e.button !== 3 && e.button !== 4) || !e.target.closest('.explorer, #ex-tree')) return;
    e.preventDefault();
    (e.button === 3 ? goBack : goForward)();
  });
}

// A folder of the tree is shown in the contents (while searching, it narrows the results);
// a file is selected in its folder.
function treePick(row, chevron) {
  const v = view(), path = row.dataset.path, dir = 'dir' in row.dataset;
  if (chevron && path && !v.query) return toggleOpen(path);
  if (v.query) {
    if (!dir) return select(path);
    v.scope = path;
    if (v.selected != null && path && !v.selected.startsWith(path + '/')) v.selected = null;
    return paint();
  }
  if (dir) navigate(path);
  else navigate(parentOf(path), { select: path });
}

function bindContent(root) {
  const items = $('.ex-items', root), bar = $('.ex-bar', root), detail = $('.ex-detail', root);

  items.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const it = e.target.closest('[data-path]');
    const path = it ? it.dataset.path : null;
    if (path !== view().selected) select(path);
  });
  items.addEventListener('dblclick', e => {
    const it = e.target.closest('[data-path]');
    if (it) activate(it.dataset.path, 'dir' in it.dataset);
  });
  items.addEventListener('contextmenu', e => {
    e.preventDefault();
    const it = e.target.closest('[data-path]');
    if (it) {
      select(it.dataset.path);
      itemMenu(e.clientX, e.clientY, it.dataset.path, 'dir' in it.dataset);
    } else {
      select(null);
      itemMenu(e.clientX, e.clientY, here(), true);
    }
  });
  items.addEventListener('keydown', e => {
    const v = view();
    if (e.key === 'Escape' && v.query) return endSearch();
    if (e.key === 'Backspace') { e.preventDefault(); return goUp(); }
    const els = [...items.querySelectorAll('[data-path]')];
    if (!els.length || e.altKey) return;
    const cur = els.findIndex(el => el.dataset.path === v.selected);
    if (e.key === 'Enter') {
      if (cur >= 0) activate(els[cur].dataset.path, 'dir' in els[cur].dataset);
      return;
    }
    const grid = gridView();
    let cols = 1;
    if (grid) {
      const top = els[0].offsetTop;
      cols = els.findIndex(el => el.offsetTop !== top);
      if (cols < 0) cols = els.length;
    }
    const page = Math.max(1, Math.floor(items.clientHeight / (grid ? els[0].offsetHeight : 26))) * cols;
    const moves = { ArrowDown: cols, ArrowUp: -cols, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9, ...(grid ? { ArrowRight: 1, ArrowLeft: -1 } : {}) };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const n = cur < 0 ? 0 : Math.max(0, Math.min(els.length - 1, cur + moves[e.key]));
    select(els[n].dataset.path, { scroll: true });
  });

  bar.addEventListener('click', e => {
    const nav = e.target.closest('[data-ex-nav]');
    if (nav) {
      if (nav.disabled) return;
      if (nav.dataset.exNav === 'unscope') { view().scope = ''; return paint(); }
      return ({ back: goBack, forward: goForward, up: goUp })[nav.dataset.exNav]();
    }
    const crumb = e.target.closest('[data-crumb]');
    if (crumb) return navigate(crumb.dataset.crumb, { select: view().dir.startsWith(crumb.dataset.crumb) && crumb.dataset.crumb !== view().dir ? childToward(crumb.dataset.crumb) : null });
    const mode = e.target.closest('[data-ex-view]');
    if (mode) {
      store('exView', mode.dataset.exView);
      paintContent();
    }
  });

  detail.addEventListener('click', e => {
    const path = detail.dataset.path, dir = !!detail.dataset.dir;
    const tab = e.target.closest('[data-exd-tab]');
    if (tab) {
      view().tab = tab.dataset.exdTab;
      return paintDetail(true);
    }
    const act = e.target.closest('[data-exd-act]');
    if (act) {
      return ({
        open: () => activate(path, dir),
        explorer: () => showInExplorer(path),
        terminal: () => host.terminal(fullPath(path)),
        copy: () => host.copy(path || '.'),
        changes: () => host.revealChange(path),
      })[act.dataset.exdAct]();
    }
    const sha = e.target.closest('[data-sha]');
    if (sha) return host.revealCommit(sha.dataset.sha, dir ? null : path);
    if (e.target.closest('[data-new]')) host.revealChange(path);
  });
}

// The child of `dir` on the way to the folder being shown (selected when going up through the path).
function childToward(dir) {
  const rest = view().dir.slice(dir ? dir.length + 1 : 0);
  return (dir ? dir + '/' : '') + rest.split('/')[0];
}
