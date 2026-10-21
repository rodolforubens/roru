// Notes UI: the page of a note (title, properties when it is a database's item, text) or of a
// database (its views), the tree of a space's pages and databases, the side and center peeks,
// mentions and exporting to Markdown. A note opens in a tab, in a side peek (a panel over the right
// of the window) or in a center peek (over everything), like in Notion; the peeks leave the tab
// below as it was. Pages nest in other pages through their text (a link to the nested page, or a
// database block); databases show in the tree as one item. Tabs and spaces belong to app.js (see
// initNotesUi); the table and board views and the properties are in views.js.
import * as S from './notes-store.js?v=d465f4c';
import * as G from './git.js?v=d465f4c';
import { createEditor, pickImages, addImages } from './editor.js?v=d465f4c';
import { pickEmoji } from './emoji.js?v=d465f4c';
import { toMarkdown } from './markdown.js?v=d465f4c';
import { sharedPath } from './projects.js?v=d465f4c';
import { initViews, renderCollection, renderProps, repaintViews, valueText, createBranchFor, addView } from './views.js?v=d465f4c';
import { importNotion } from './notion-import.js?v=d465f4c';
import { esc, icon, store, folderName, plural, debounce, shrinkImage, fmtRelative } from './util.js?v=d465f4c';
import { desktop, invoke, isMobile } from './platform.js?v=d465f4c';

const $ = (sel, root = document) => root.querySelector(sel);
const tauri = window.__TAURI__;

// Callbacks into the app (see initNotesUi).
let host = null;

export const noteTitle = id => S.getNote(id)?.title || 'Untitled';
// A note's icon: the emoji it was given, or its kind's.
export const noteIcon = id => S.getNote(id)?.icon || (S.isDatabase(id) ? 'table' : 'note');
// Where notes open from views and lists: 'side' (a side peek), 'center' (a center peek) or 'tab' (a
// new tab). Each page or database chooses it for the notes inside it, or opens them like its parent
// does ("Same as parent"); the top of a space opens them as chosen in the dashboard (or start page).
const OPEN_IN = { side: 'Side peek', center: 'Center peek', tab: 'New tab' };
const topOpen = () => store('notesOpen') || 'side';
const openPref = (parent = null) => S.getNote(S.openInSource(parent))?.openIn || topOpen(); // inside `parent`
const openPrefOf = id => openPref(S.getNote(id)?.parent ?? null); // where a note opens

// `h`: { space(), spaceName(space), spaces(), folders() (of the current space), activeNote(),
// openTab(id, { replace }), closeTabs(ids), reveal(mention attrs), toast, showMenu, modal, confirmBox, copy, pickFolders }.
export async function initNotesUi(h) {
  host = h;
  initViews({
    mountTree: (el, space, opts) => mountTree(el, space, { sidebar: false, ...opts }),
    noteMenu: id => noteMenuItems(id),
    openInMenu: openInItems,
    deleteNotes,
    folders: h.folders, reveal: h.reveal, gitChanged: h.gitChanged,
    showMenu: h.showMenu, modal: h.modal, confirmBox: h.confirmBox, toast: h.toast,
  });
  await S.initNotes();
  S.onNotesChange(({ ids, removed }) => {
    // deleted elsewhere: their tabs close
    if (removed?.length) host.closeTabs(removed);
    for (const t of trees) if (t.el.isConnected) paintTree(t); else trees.delete(t);
    for (const p of cardPanels) if (p.el.isConnected) paintCards(p); else cardPanels.delete(p);
    for (const p of pages) if (p.el.isConnected) paintMeta(p); else destroyPage(p);
    repaintViews();
    // mentions of renamed notes show their new title
    for (const id of ids) document.querySelectorAll(`.mention.m-note[data-id="${CSS.escape(id)}"] .m-label`).forEach(el => (el.textContent = noteTitle(id)));
    // database blocks show their database's title (or that it is gone)
    for (const block of document.querySelectorAll('.db-block')) {
      const db = S.getNote(block.dataset.id), name = block.querySelector('.db-name');
      if (!db && name) block.innerHTML = `<div class="db-gone">${icon('table')}This database was deleted</div>`;
      else if (name && document.activeElement !== name && name.value !== db.title) name.value = db.title;
    }
    if (peek && !S.getNote(peek.page.id)) closePeek();
  });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || !peek || $('#modal-root').childElementCount || !$('#menu').hidden) return;
    closePeek();
  });
}

// =====================================================================
// Creating, deleting and exporting
// =====================================================================

// Creates a page and opens it (`open`: 'tab', 'side', 'center', 'none', or where the notes inside
// its parent open). A page nested in another one gets a link at the end of that page's text (an
// item of a database doesn't: the database shows it).
export function newNote({ space = host.space(), parent = null, props = null, open = openPref(parent) } = {}) {
  const n = S.createNote({ space, parent, props });
  if (parent && !S.isDatabase(parent)) {
    expand(parent);
    appendToText(parent, { type: 'paragraph', content: [{ type: 'mention', attrs: { id: n.id, kind: 'note', label: '' } }] });
  }
  if (open !== 'none') openNote(n.id, open, { focusTitle: true });
  return n;
}

// Creates a database with a first view (`view`: 'table', 'board' or 'list'). In a page, it shows
// as a block at the end of the page's text (`block` false when the caller puts it somewhere else).
export function newDatabase({ space = host.space(), parent = null, view = 'table', open = openPref(parent), block = true } = {}) {
  const db = S.createNote({ space, parent, kind: 'database' });
  // the first view takes the place of the list a collection starts with
  const list = S.getCollection(db.id).views[0];
  addView(db.id, view);
  if (view !== 'list') S.deleteView(db.id, list.id);
  if (parent && block) appendToText(parent, { type: 'database', attrs: { id: db.id } });
  if (open !== 'none') openNote(db.id, open, { focusTitle: true });
  return db;
}

// Adds a block at the end of a page's text: through its editor when the page is open, or else in
// its stored content.
async function appendToText(id, node) {
  const open = [...pages].find(p => p.id === id && p.editor);
  if (open) {
    const ed = open.editor, last = ed.state.doc.lastChild;
    // before the empty paragraph that ends the text, if there is one
    const at = last?.type.name === 'paragraph' && !last.content.size ? ed.state.doc.content.size - last.nodeSize : ed.state.doc.content.size;
    ed.chain().insertContentAt(at, node).run();
    return;
  }
  const doc = (await S.loadContent(id)) || { type: 'doc', content: [] };
  const content = [...(doc.content || [])];
  const end = content.length && content[content.length - 1].type === 'paragraph' && !content[content.length - 1].content?.length ? content.length - 1 : content.length;
  content.splice(end, 0, node);
  S.saveContent(id, { ...doc, content });
}

// ---------- pictures ----------

// A picture added to a note goes to its files (made smaller first when it is a big photo); returns its
// `src`. A notice shows while it uploads.
async function uploadImage(id, file) {
  const busy = notice('Adding the image…');
  try {
    const { bytes, ext } = await shrinkImage(file);
    // (file names in the account's storage are plain ASCII)
    const base = file.name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    return await S.saveFile(id, `${base}-${Date.now().toString(36)}.${ext}`, bytes);
  } finally {
    busy.remove();
  }
}

const imageOpts = id => ({
  uploadImage: file => uploadImage(id, file),
  onError: e => host.toast('Could not add the image', 'error', String(e.message || e)),
});

// "Add an image…" from a note's menu: where the caret is when the note is open, or else at the end
// of its text.
async function addImagesTo(id, files) {
  const open = [...pages].find(p => p.id === id && p.editor);
  if (open) return addImages(open.editor, imageOpts(id), files);
  for (const f of files) {
    try {
      appendToText(id, { type: 'paragraph', content: [{ type: 'image', attrs: { src: await uploadImage(id, f), alt: f.name.replace(/\.[^.]+$/, '') } }] });
    } catch (e) {
      imageOpts(id).onError(e);
    }
  }
}

function notice(text) {
  const el = document.createElement('div');
  el.className = 'import-progress';
  el.innerHTML = `<span class="spinner"></span><span>${esc(text)}</span>`;
  document.body.append(el);
  return el;
}

// Deleted databases leave the text of the pages they were shown in.
async function dropBlocks(dbs) {
  for (const { id, parent } of dbs) {
    const open = [...pages].find(p => p.id === parent && p.editor);
    if (open) {
      const ed = open.editor, ranges = [];
      ed.state.doc.descendants((n, pos) => { if (n.type.name === 'database' && n.attrs.id === id) ranges.push([pos, pos + n.nodeSize]); });
      for (const [from, to] of ranges.reverse()) ed.chain().deleteRange({ from, to }).run();
      continue;
    }
    const doc = parent && (await S.loadContent(parent));
    if (!doc?.content?.some(b => b.type === 'database' && b.attrs?.id === id)) continue;
    S.saveContent(parent, { ...doc, content: doc.content.filter(b => !(b.type === 'database' && b.attrs?.id === id)) });
  }
}

async function deleteNote(id) {
  const n = S.getNote(id);
  if (!n) return;
  const subs = S.descendantsOf(id).length;
  const ok = n.kind === 'database'
    ? await host.confirmBox('Delete database', `Delete the database "${noteTitle(id)}"${subs ? ` and its ${plural(subs, 'item')}` : ''}? This can't be undone.`, 'Delete')
    : await host.confirmBox('Delete page', `Delete "${noteTitle(id)}"${subs ? ` and the ${plural(subs, 'page')} inside it` : ''}? This can't be undone.`, 'Delete');
  if (!ok) return;
  const dbs = [n, ...S.descendantsOf(id)].filter(x => x.kind === 'database').map(x => ({ id: x.id, parent: x.parent }));
  const ids = S.deleteNote(id);
  host.closeTabs(ids);
  if (peek && ids.includes(peek.page.id)) closePeek();
  dropBlocks(dbs);
}

// Several notes (a selection in a view) and their sub-pages, after one confirmation (unless the
// caller asked already: `confirm` false).
async function deleteNotes(ids, { confirm = true } = {}) {
  ids = ids.filter(id => S.getNote(id));
  if (!ids.length) return;
  if (confirm && ids.length === 1) return deleteNote(ids[0]);
  const subs = new Set(ids.flatMap(id => S.descendantsOf(id).map(n => n.id)).filter(x => !ids.includes(x))).size;
  if (confirm && !(await host.confirmBox('Delete notes', `Delete ${ids.length} notes${subs ? ` and the ${plural(subs, 'page')} inside them` : ''}? This can't be undone.`, 'Delete'))) return;
  const dbs = ids.flatMap(id => [S.getNote(id), ...S.descendantsOf(id)]).filter(x => x?.kind === 'database').map(x => ({ id: x.id, parent: x.parent }));
  const gone = [];
  await S.batch(() => { for (const id of ids) if (S.getNote(id)) gone.push(...S.deleteNote(id)); });
  host.closeTabs(gone);
  if (peek && gone.includes(peek.page.id)) closePeek();
  dropBlocks(dbs);
}

const fileName = title => (title || 'Untitled').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').slice(0, 120) || 'Untitled';

// An item's properties go in a YAML front matter.
function frontMatter(id) {
  const key = S.collectionOf(id);
  if (!key) return '';
  const n = S.getNote(id), schema = S.getCollection(key).schema;
  const yaml = v => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v));
  const lines = schema.map(p => [p, valueText(p, n.props?.[p.id])])
    .filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))
    .map(([p, v]) => `${/^[\w -]+$/.test(p.name) ? p.name : JSON.stringify(p.name)}: ${yaml(v)}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

// A database as a Markdown table: its items with their properties.
function databaseMarkdown(id) {
  const db = S.getNote(id);
  if (!db) return '';
  const schema = S.getCollection(id).schema, cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const text = (p, v) => { const t = valueText(p, v); return Array.isArray(t) ? t.join(', ') : t === true ? '✓' : t; };
  const rows = S.childrenOf(db.space, id).map(n => [n.title || 'Untitled', ...schema.map(p => text(p, n.props?.[p.id]))]);
  const line = cells => `| ${cells.map(cell).join(' | ')} |`;
  return [`**${cell(noteTitle(id))}**`, '', line(['Name', ...schema.map(p => p.name)]), line(['---', ...schema.map(() => '---')]), ...rows.map(line)].join('\n');
}

async function markdownOf(id) {
  const repoName = r => (r ? folderName(r) + '/' : '');
  if (S.isDatabase(id)) return `# ${noteTitle(id)}\n\n` + databaseMarkdown(id).split('\n').slice(2).join('\n') + '\n';
  return frontMatter(id) + `# ${noteTitle(id)}\n\n` + toMarkdown(await S.loadContent(id), {
    mention: a => ({
      note: () => `@${noteTitle(a.id)}`,
      file: () => '`' + repoName(a.repo) + a.id + '`',
      commit: () => '`' + String(a.id).slice(0, 7) + '`',
      branch: () => '`' + a.id + '`',
    })[a.kind]?.() ?? `@${a.label ?? a.id}`,
    database: a => databaseMarkdown(a.id),
  });
}

// The web page saves a file by downloading it.
function download(name, text, type = 'text/markdown') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportNote(id) {
  if (!desktop) return download(fileName(noteTitle(id)) + '.md', await markdownOf(id));
  try {
    const path = await tauri.dialog.save({ title: 'Export as Markdown', defaultPath: fileName(noteTitle(id)) + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return;
    await invoke('write_text', { path, content: await markdownOf(id) });
    host.toast('Exported as Markdown', 'ok', path);
  } catch (e) {
    host.toast('Export failed', 'error', String(e.message || e));
  }
}

// Every note of a space into a folder: one .md file per note, its sub-pages in a folder of the same name.
export async function exportSpace(space = host.space()) {
  if (!S.notesOf(space).length) return host.toast('There are no notes to export');
  const picked = await host.pickFolders({ title: 'Export the notes as Markdown into a folder' });
  if (!picked) return;
  const base = String(Array.isArray(picked) ? picked[0] : picked).replace(/\\/g, '/').replace(/\/+$/, '');
  let count = 0;
  try {
    const write = async (parent, dir) => {
      const used = new Set();
      for (const n of S.childrenOf(space, parent)) {
        let name = fileName(n.title), k = 2;
        while (used.has(name.toLowerCase())) name = `${fileName(n.title)} (${k++})`;
        used.add(name.toLowerCase());
        await invoke('write_text', { path: `${dir}/${name}.md`, content: await markdownOf(n.id) });
        count++;
        if (S.childrenOf(space, n.id).length) await write(n.id, `${dir}/${name}`);
      }
    };
    await write(null, base);
    host.toast(`Exported ${plural(count, 'note')} as Markdown`, 'ok', base);
  } catch (e) {
    host.toast('Export failed', 'error', String(e.message || e));
  }
}

// Imports a Notion export (.zip, "Markdown & CSV") into the space, or into a note as its sub-pages.
async function importFromNotion(space, parent) {
  let path, picked;
  try {
    if (desktop) path = await tauri.dialog.open({ title: 'Import a Notion export', multiple: false, directory: false, filters: [{ name: 'Notion export (Markdown & CSV)', extensions: ['zip'] }] });
    else {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip,application/zip' });
      picked = await new Promise(done => { input.onchange = () => done(input.files[0]); input.click(); });
    }
  } catch (e) {
    return host.toast('Could not open the file dialog', 'error', String(e));
  }
  if (!path && !picked) return;
  const progress = document.createElement('div');
  progress.className = 'import-progress';
  progress.innerHTML = '<span class="spinner"></span><span>Importing from Notion…</span>';
  document.body.append(progress);
  const say = text => (progress.lastElementChild.textContent = text);
  try {
    const buffer = picked ? await picked.arrayBuffer() : await invoke('read_bytes', { path });
    const r = await importNotion(buffer, { space, parent, onProgress: (done, total) => say(`Importing from Notion… ${done} of ${total}`) });
    host.toast(`Imported ${plural(r.pages, 'page')} and ${plural(r.images, 'image')} from Notion`, 'ok',
      r.missing ? `${plural(r.missing, 'image was', 'images were')} not in the export` : '');
    if (parent) expand(parent);
    if (r.roots.length === 1) openNote(r.roots[0], 'tab');
  } catch (e) {
    host.toast('The import failed', 'error', String(e.message || e));
  } finally {
    progress.remove();
  }
}

// `ctx`: where the menu is ('tab', 'peek', 'list', 'tabbar').
export function noteMenuItems(id, ctx = 'list') {
  const inTab = host.activeNote() === id, n = S.getNote(id), db = n.kind === 'database';
  return [
    ...(inTab ? [] : [{ label: 'Open in new tab', run: () => openNote(id, 'tab') }]),
    // (a phone has no peeks)
    ...(inTab || isMobile() || (ctx === 'peek' && peek?.mode === 'side') ? [] : [{ label: 'Open in side peek', run: () => openNote(id, 'side') }]),
    ...(inTab || isMobile() || (ctx === 'peek' && peek?.mode === 'center') ? [] : [{ label: 'Open in center peek', run: () => openNote(id, 'center') }]),
    { label: db ? 'Open items in…' : 'Open sub-pages in…', run: r => host.showMenu(r.left, r.top, openInItems(id)) },
    { label: n.icon ? 'Change icon…' : 'Add icon…', run: r => pickEmoji(r, n.icon, e => S.setIcon(id, e)) },
    '-',
    ...(db ? [{ label: 'Add an item', run: () => newNote({ space: n.space, parent: id }) }] : [
      { label: 'Add a page inside', run: () => newNote({ space: n.space, parent: id }) },
      { label: 'Add a database inside', run: () => newDatabase({ space: n.space, parent: id, open: 'none' }) },
      ...(desktop && n.space === host.space() ? [{ label: 'Create a branch for this note…', run: () => createBranchFor(id) }] : []),
      ...(S.databasesOf(id).length ? [{ label: `Full-width databases${S.wideViewsOf(id) ? '  ✓' : ''}`, run: () => S.setWideViews(id, !S.wideViewsOf(id)) }] : []),
      { label: 'Import from Notion here…', run: () => importFromNotion(n.space, id) },
    ]),
    ...(n.parent && !S.isDatabase(n.parent) ? [] : [{ label: 'Move to…', run: () => moveToSpace(id) }]),
    '-',
    ...(db ? [] : [{ label: 'Add an image…', run: () => pickImages(files => addImagesTo(id, files)) }]),
    { label: 'Copy as Markdown', run: async () => host.copy(await markdownOf(id)) },
    { label: 'Export as Markdown…', run: () => exportNote(id) },
    '-',
    { label: 'Delete…', danger: true, run: () => deleteNote(id) },
  ];
}

// The choices of where the notes inside a note open: its own, or like its parent (which shows what
// that is now).
function openInItems(id) {
  const n = S.getNote(id), own = n?.openIn ?? null, check = on => (on ? '  ✓' : '');
  return [
    { label: `Same as parent (${OPEN_IN[openPrefOf(id)]})${check(!own)}`, run: () => S.setOpenIn(id, null) },
    '-',
    ...Object.entries(OPEN_IN).map(([mode, name]) => ({ label: name + check(own === mode), run: () => S.setOpenIn(id, mode) })),
  ];
}

// Moves a note (with what is inside it) to the top of another space's notes.
function moveToSpace(id) {
  const n = S.getNote(id);
  const items = host.spaces().filter(s => s !== n.space).map(s => ({
    label: host.spaceName(s),
    run: () => {
      if (peek && [id, ...S.descendantsOf(id).map(d => d.id)].includes(peek.page.id)) closePeek();
      host.closeTabs(S.moveToSpace(id, s));
      host.toast(`Moved to ${host.spaceName(s)}`);
    },
  }));
  if (!items.length) return host.toast('There is no other space to move it to');
  host.showMenu(innerWidth / 2 - 110, innerHeight / 3, items);
}

// =====================================================================
// Opening notes: tabs and peeks
// =====================================================================

// `how`: 'tab', 'side', 'center', or where its parent opens the notes inside it. A phone has no
// peeks: notes open as the whole screen.
export function openNote(id, how = openPrefOf(id), { focusTitle = false } = {}) {
  if (!S.getNote(id)) return;
  if (isMobile()) how = 'tab';
  if (how === 'tab' || host.activeNote() === id) {
    if (peek?.page.id === id) closePeek();
    host.openTab(id);
    if (focusTitle) setTimeout(() => focusPageTitle(tabPage));
  } else {
    peekNote(id, how, { focusTitle });
  }
}

let tabPage = null; // the page shown in the active note tab
let peek = null;    // { mode, page }

// Shows a note in the main area (its tab is active), with the tree of its space in the sidebar.
export function mountNoteTab(id) {
  if (tabPage?.id !== id || !tabPage.el.isConnected) {
    leaveNoteTab();
    tabPage = mountPage($('#main'), id, 'tab');
  }
  renderNoteTree();
}

export function leaveNoteTab() {
  if (tabPage) destroyPage(tabPage);
  tabPage = null;
}

export function peekNote(id, mode = peek?.mode || 'side', { focusTitle = false } = {}) {
  if (!S.getNote(id) || host.activeNote() === id) return;
  const el = $('#peek');
  if (peek?.page.id !== id) {
    if (peek) destroyPage(peek.page);
    el.innerHTML = '<div class="peek-panel"><div class="peek-grip"></div><div class="peek-body"></div></div>';
    peek = { mode, page: mountPage($('.peek-body', el), id, 'peek') };
    bindPeek(el);
  }
  peek.mode = mode;
  el.className = mode;
  el.hidden = false;
  paintMeta(peek.page);
  if (focusTitle) focusPageTitle(peek.page);
}

export function closePeek() {
  if (!peek) return;
  destroyPage(peek.page);
  peek = null;
  const el = $('#peek');
  el.hidden = true;
  el.className = '';
  el.innerHTML = '';
}

function bindPeek(el) {
  if (el._bound) return;
  el._bound = true;
  // the center peek closes with a click on the backdrop
  el.addEventListener('mousedown', e => { if (e.target === el && peek?.mode === 'center') closePeek(); });
  // the side peek is resized from its left edge
  el.addEventListener('mousedown', e => {
    if (!e.target.classList.contains('peek-grip') || peek?.mode !== 'side') return;
    e.preventDefault();
    const panel = $('.peek-panel', el), right = el.getBoundingClientRect().right;
    const max = el.parentElement.clientWidth - 160;
    const move = ev => {
      const w = Math.max(360, Math.min(max, right - ev.clientX));
      panel.style.setProperty('--peek-w', w + 'px');
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      store('peekWidth', panel.offsetWidth);
    };
    document.body.style.cursor = 'col-resize';
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

// =====================================================================
// The page of a note
// =====================================================================

const pages = new Set();

// Items of a database open where the database says, from a tab or a peek (Ctrl+click: a new tab).
const openItem = (id, e) => openNote(id, e?.ctrlKey || e?.metaKey ? 'tab' : undefined);

// A database shown in a page's text: its title (a click opens it on its own) and its views.
function renderDatabaseBlock(el, id, page) {
  const db = S.getNote(id);
  if (!db) {
    el.innerHTML = `<div class="db-gone">${icon('table')}This database was deleted</div>`;
    return;
  }
  el.innerHTML = `<div class="db-head">${icon('table')}<input class="db-name" spellcheck="false" placeholder="Untitled database" value="${esc(db.title)}">
      <button class="db-open" title="Open the database on its own">${icon('expand')}</button></div>
    <div class="db-views"></div>`;
  el.querySelector('.db-open').addEventListener('click', e => (e.ctrlKey || e.metaKey ? openNote(id, 'tab') : goTo(page, id, e)));
  // its title is typed right here
  const name = el.querySelector('.db-name');
  const rename = debounce(() => S.renameNote(id, name.value.trim()), 250);
  name.addEventListener('input', rename);
  name.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
  name.addEventListener('blur', () => S.renameNote(id, name.value.trim()));
  renderCollection(el.querySelector('.db-views'), {
    space: db.space, parent: id, ctx: 'inline',
    open: openItem,
    create: (props, open) => newNote({ space: db.space, parent: id, props, open }),
  });
}

// `place`: 'tab' or 'peek'. A page shows its title, its properties (when it is an item of a
// database) and its text; a database, its title and its views across the page.
function mountPage(container, id, place) {
  const note = S.getNote(id), space = note.space, db = note.kind === 'database';
  container.innerHTML = `<div class="np np-${place} ${db ? 'np-db' : ''}">
    <div class="np-bar"><div class="np-crumbs"></div><div class="np-acts"></div></div>
    <div class="np-scroll"><div class="np-doc">
      <div class="np-icon-row"></div>
      <textarea class="np-title" rows="1" placeholder="${db ? 'Untitled database' : 'Untitled'}" spellcheck="false"></textarea>
      ${db ? '<div class="np-children"></div>' : '<div class="np-props"></div><div class="np-editor"></div>'}
    </div></div>
  </div>`;
  const el = $('.np', container);
  const page = { id, place, el, editor: null, alive: true };
  pages.add(page);
  if (db) {
    renderCollection($('.np-children', el), {
      space, parent: id, ctx: 'page',
      open: openItem,
      create: (props, open) => newNote({ space, parent: id, props, open }),
    });
  } else {
    renderProps($('.np-props', el), id);
  }
  if (place === 'peek') {
    const w = store('peekWidth');
    if (w) container.closest('.peek-panel').style.setProperty('--peek-w', w + 'px');
  }

  const title = $('.np-title', el);
  title.value = S.getNote(id)?.title || '';
  // the title grows with its text (field-sizing in CSS; measured where the webview lacks it)
  const sized = CSS.supports('field-sizing', 'content');
  const fit = () => { if (sized) return; title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  fit();
  requestAnimationFrame(fit);
  const rename = debounce(() => S.renameNote(id, title.value.trim()), 250);
  title.addEventListener('input', () => { fit(); rename(); });
  title.addEventListener('keydown', e => {
    const atEnd = title.selectionStart === title.value.length;
    if ((e.key === 'Enter' || (e.key === 'ArrowDown' && atEnd)) && page.editor) {
      e.preventDefault();
      // at the start of the text, right away (the focus command of the editor waits for a frame)
      page.editor.commands.setTextSelection(1);
      page.editor.view.focus();
    }
  });
  title.addEventListener('blur', () => S.renameNote(id, title.value.trim()));

  el.addEventListener('click', e => {
    const act = e.target.closest('[data-np]');
    if (act) return pageAction(page, act.dataset.np, act, e);
    const link = e.target.closest('[data-open]');
    if (link) return goTo(page, link.dataset.open, e);
  });
  el.addEventListener('contextmenu', e => {
    const link = e.target.closest('[data-open]');
    if (!link) return;
    e.preventDefault();
    host.showMenu(e.clientX, e.clientY, noteMenuItems(link.dataset.open));
  });

  if (!db) S.openContent(id).then(src => {
    if (!page.alive) return;
    // a database made here shows where "/" was typed
    const database = view => (editor, range) => {
      const d = newDatabase({ space, parent: id, view, open: 'none', block: false });
      expand(id);
      editor.chain().focus().deleteRange(range).insertContent({ type: 'database', attrs: { id: d.id } }).run();
    };
    page.editor = createEditor($('.np-editor', el), {
      ...(src.ydoc ? { ydoc: src.ydoc } : { content: src.content, onChange: json => S.saveContent(id, json) }),
      mentions: q => mentionItems(q, id),
      mentionView,
      fileUrl: S.fileUrl,
      renderDatabase: (dom, dbId) => renderDatabaseBlock(dom, dbId, page),
      ...imageOpts(id),
      openMention: (attrs, e) => openMention(page, attrs, e),
      openLink: href => invoke('open_url', { url: href }).catch(err => host.toast('Could not open the link', 'error', String(err))),
      commands: [{
        title: 'Page', hint: 'A page inside this page', icon: 'note', keys: 'page subpage',
        run: (editor, range) => {
          const n = S.createNote({ space, parent: id, title: '' });
          expand(id);
          editor.chain().focus().deleteRange(range).insertContent([{ type: 'mention', attrs: { id: n.id, kind: 'note', label: '' } }, { type: 'text', text: ' ' }]).run();
          goTo(page, n.id, null, { focusTitle: true });
        },
      }, {
        title: 'Database: table', hint: 'Items with properties, in a table', icon: 'table', keys: 'database db spreadsheet',
        run: database('table'),
      }, {
        title: 'Database: board', hint: 'Items in columns by status', icon: 'board', keys: 'database db kanban board',
        run: database('board'),
      }],
    });
    // a click in the empty space around the text puts the caret at its end
    const scroll = $('.np-scroll', el), docEl = $('.np-doc', el);
    scroll.addEventListener('mousedown', e => {
      if (e.target !== scroll && e.target !== docEl) return;
      e.preventDefault();
      page.editor.commands.focus('end');
    });
  }).catch(e => {
    if (page.alive) $('.np-editor', el).innerHTML = `<div class="np-failed">${icon('alert')}Could not open the text of this page — ${esc(String(e.message || e))}</div>`;
  });

  paintMeta(page);
  return page;
}

function destroyPage(page) {
  if (!page.alive) return;
  page.alive = false;
  pages.delete(page);
  page.editor?.destroy();
  S.closeContent(page.id);
}

function focusPageTitle(page) {
  const t = page && $('.np-title', page.el);
  if (!t) return;
  t.focus();
  t.select();
}

// The parts of the page that come from the tree: path and buttons.
function paintMeta(page) {
  const n = S.getNote(page.id);
  if (!n) return;
  const crumb = (id, text) => `<button class="np-crumb" data-open="${esc(id)}">${esc(text)}</button>`;
  $('.np-crumbs', page.el).innerHTML = `<span class="np-space">${esc(host.spaceName(n.space))}</span>`
    + [...S.pathOf(page.id).map(a => crumb(a.id, a.title || 'Untitled')), `<span class="np-here">${esc(n.title || 'Untitled')}</span>`]
      .map(c => `${icon('chevron', 'np-sep')}${c}`).join('');
  const btn = (act, ic, title, on = false) => `<button class="np-btn ${on ? 'on' : ''}" data-np="${act}" title="${title}">${icon(ic)}</button>`;
  $('.np-acts', page.el).innerHTML = page.place === 'peek'
    ? btn('side', 'peekSide', 'Side peek', peek?.mode === 'side') + btn('center', 'peekCenter', 'Center peek', peek?.mode === 'center')
      + btn('tab', 'expand', 'Open in a tab') + btn('more', 'more', 'More') + btn('close', 'close', 'Close (Esc)')
    : btn('more', 'more', 'More');
  const title = $('.np-title', page.el);
  if (document.activeElement !== title && title.value !== n.title) title.value = n.title;
  // its icon over the title (or the button that gives it one)
  $('.np-icon-row', page.el).innerHTML = n.icon
    ? `<button class="np-icon" data-np="icon" title="Change the icon">${icon(n.icon)}</button>`
    : `<button class="np-add-icon" data-np="icon">${icon('smile')}Add icon</button>`;
  page.el.classList.toggle('np-wide', S.wideViewsOf(page.id));
}

function pageAction(page, act, el, e) {
  const r = el.getBoundingClientRect();
  ({
    side: () => setPeekMode(page, 'side'),
    center: () => setPeekMode(page, 'center'),
    tab: () => openNote(page.id, 'tab'),
    close: closePeek,
    more: () => host.showMenu(r.right - 220, r.bottom + 4, noteMenuItems(page.id, page.place)),
    icon: () => pickEmoji(r, S.getNote(page.id)?.icon, e => S.setIcon(page.id, e)),
  })[act]?.(e);
}

// Switching a peek between side and center keeps the choice where the place of its note comes
// from: the nearest of its parents that chose one, or else the dashboard.
function setPeekMode(page, mode) {
  const from = S.openInSource(S.getNote(page.id)?.parent ?? null);
  if (from) S.setOpenIn(from, mode);
  else store('notesOpen', mode);
  peekNote(page.id, mode);
  paintMeta(page);
}

// Following a link to another note: the tab or the peek goes there (Ctrl+click opens a new tab).
function goTo(page, id, e, { focusTitle = false } = {}) {
  if (!S.getNote(id)) return host.toast('This note was deleted');
  if (e?.ctrlKey || e?.metaKey) return openNote(id, 'tab');
  if (page.place === 'peek') return peekNote(id, peek.mode, { focusTitle });
  if (host.activeNote() === page.id) {
    host.openTab(id, { replace: true });
    if (focusTitle) setTimeout(() => focusPageTitle(tabPage));
    return;
  }
  openNote(id, undefined, { focusTitle });
}

// =====================================================================
// The tree of a space's notes (the sidebar of note tabs, the dashboard and the start page)
// =====================================================================

const trees = new Set();
const expanded = new Set(store('notesExpanded') || []);

function expand(id, open = true) {
  if (open) expanded.add(id); else expanded.delete(id);
  store('notesExpanded', [...expanded]);
}

// In the sidebar of a note tab, choosing a note goes there in the same tab.
export function renderNoteTree() {
  const el = $('#note-tree');
  const active = host.activeNote();
  for (const a of S.pathOf(active)) expanded.add(a.id);
  mountTree(el, host.space(), { sidebar: true });
}

// The pages and databases of a space as a section of a page (dashboard, start page): they open in a peek.
// A space's notes show as cards (like the links of a dashboard: a cover, the title and the start of
// the text) or as their tree; projects show cards and Home its tree, until changed in the panel's menu.
const layoutOf = space => store('notesLayout')?.[space] || (space === 'home' ? 'list' : 'cards');
const setLayout = (space, layout) => store('notesLayout', { ...store('notesLayout'), [space]: layout });

export function renderNotesPanel(el, space) {
  const cards = layoutOf(space) === 'cards';
  el.innerHTML = `<div class="nt-panel">
    <div class="nt-panel-head"><h2>Notes</h2><span class="spacer"></span>
      <button class="btn-sm" data-nt="page">${icon('plus')}Page</button>
      <button class="btn-sm" data-nt="database">${icon('table')}Database</button>
      <button class="nt-btn" data-nt="menu" title="More">${icon('more')}</button></div>
    <div class="nt-body ${cards ? 'nt-cards' : 'nt-tree'}"></div>
  </div>`;
  el.querySelector('.nt-panel-head').addEventListener('click', e => {
    const b = e.target.closest('[data-nt]');
    if (!b) return;
    if (b.dataset.nt === 'page') return newNote({ space });
    if (b.dataset.nt === 'database') return newDatabase({ space });
    const r = b.getBoundingClientRect();
    host.showMenu(r.right - 220, r.bottom + 4, [
      { label: 'New page', run: () => newNote({ space }) },
      { label: 'New database', run: () => newDatabase({ space }) },
      '-',
      { label: cards ? 'Show as a list' : 'Show as cards', run: () => { setLayout(space, cards ? 'list' : 'cards'); renderNotesPanel(el, space); } },
      // where the notes at the top open, and the ones inside them that open like their parent
      ...Object.entries(OPEN_IN).map(([m, name]) => ({ label: `Open notes in: ${name}${topOpen() === m ? '  ✓' : ''}`, run: () => store('notesOpen', m) })),
      '-',
      { label: 'Import from Notion…', run: () => importFromNotion(space, null) },
      ...(desktop ? [{ label: 'Export all notes as Markdown…', run: () => exportSpace(space) }] : []),
    ]);
  });
  if (cards) mountCards($('.nt-body', el), space);
  else mountTree($('.nt-body', el), space, { sidebar: false });
}

// ---------- the notes as cards ----------

const cardPanels = new Set(); // { el, space }
const previews = new Map();   // note id -> { updated, cover, text } (from its text, read once per change)

// A hue from the title, for the cards with no picture (like the links).
const hueOf = text => [...(text || 'x')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function mountCards(el, space) {
  const panel = { el, space };
  cardPanels.add(panel);
  paintCards(panel);
  el.addEventListener('click', e => {
    const card = e.target.closest('.nt-card');
    if (e.target.closest('[data-nt="add-page"]')) return newNote({ space });
    if (!card) return;
    const more = e.target.closest('.lk-more');
    if (more) { const r = more.getBoundingClientRect(); return host.showMenu(r.right - 220, r.bottom + 4, noteMenuItems(card.dataset.note)); }
    openNote(card.dataset.note);
  });
  el.addEventListener('contextmenu', e => {
    const card = e.target.closest('.nt-card');
    if (!card) return;
    e.preventDefault();
    host.showMenu(e.clientX, e.clientY, noteMenuItems(card.dataset.note));
  });
  // cards are dragged to another place; a line shows where the dragged one will land
  let dragging = null;
  const clear = () => el.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  const after = (card, e) => { const r = card.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
  el.addEventListener('dragstart', e => {
    const card = e.target.closest?.('.nt-card');
    if (!card) return;
    dragging = card.dataset.note;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    setTimeout(() => card.classList.add('dragging'));
  });
  el.addEventListener('dragover', e => {
    const card = dragging && e.target.closest('.nt-card');
    if (!card) return;
    e.preventDefault();
    clear();
    if (card.dataset.note !== dragging) card.classList.add(after(card, e) ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', e => {
    const card = dragging && e.target.closest('.nt-card');
    if (!card) return;
    e.preventDefault();
    const cards = [...el.querySelectorAll('.nt-card')];
    const before = after(card, e) ? cards[cards.indexOf(card) + 1]?.dataset.note ?? null : card.dataset.note;
    if (card.dataset.note !== dragging && before !== dragging) S.moveNote(dragging, null, before);
    dragging = null;
    clear();
  });
  el.addEventListener('dragend', () => { dragging = null; clear(); el.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); });
}

function paintCards(panel) {
  const notes = S.childrenOf(panel.space, null);
  panel.el.innerHTML = notes.map(cardHtml).join('')
    + `<button class="lk-add" data-nt="add-page">${icon('plus')}<span>Add a page</span></button>`;
  // the covers and the start of the text come as each note's text is read
  for (const n of notes) {
    const hit = previews.get(n.id);
    if (hit?.updated === n.updated) fillCard(panel.el, n.id, hit);
    else previewOf(n.id).then(p => fillCard(panel.el, n.id, p), () => {});
  }
}

function cardHtml(n) {
  const db = n.kind === 'database', title = n.title || (db ? 'Untitled database' : 'Untitled');
  const items = db ? S.childrenOf(n.space, n.id) : [];
  const meta = db ? `Database · ${plural(items.length, 'item')}` : `Page${n.updated ? ` · edited ${fmtRelative(n.updated / 1000)}` : ''}`;
  return `<div class="lk-card nt-card" data-note="${esc(n.id)}" draggable="true">
    <div class="lk-media" style="--h: ${hueOf(title)}"><span class="lk-mark nt-mark">${icon(noteIcon(n.id))}</span></div>
    <div class="lk-body">
      <div class="lk-title ${n.title ? '' : 'untitled'}">${esc(title)}</div>
      <div class="lk-desc">${db ? esc(items.slice(0, 4).map(i => i.title || 'Untitled').join(' · ')) : ''}</div>
      <div class="lk-site">${icon(db ? 'table' : 'note')}<span class="ellip">${esc(meta)}</span></div>
    </div>
    <button class="dash-iconbtn lk-more" title="More actions">${icon('more')}</button>
  </div>`;
}

// The first picture of the note's text, and its start as plain text.
async function previewOf(id) {
  const n = S.getNote(id);
  if (!n || n.kind === 'database') return { updated: n?.updated };
  const doc = await S.loadContent(id);
  let cover = null;
  const parts = [];
  const walk = x => {
    if (x.type === 'image' && !cover && x.attrs?.src) cover = x.attrs.src;
    if (x.type === 'text') parts.push(x.text);
    if (x.type === 'mention') parts.push(`@${x.attrs?.kind === 'note' ? noteTitle(x.attrs.id) : x.attrs?.label ?? ''}`);
    x.content?.forEach(walk);
    if (x.type !== 'text' && x.type !== 'mention' && x.type !== 'doc') parts.push(' ');
  };
  if (doc) walk(doc);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  const p = { updated: n.updated, cover, text: text.length > 220 ? `${text.slice(0, 219).trimEnd()}…` : text };
  previews.set(id, p);
  return p;
}

function fillCard(el, id, p) {
  const card = el.querySelector(`.nt-card[data-note="${CSS.escape(id)}"]`);
  if (!card) return;
  if (p.text) card.querySelector('.lk-desc').textContent = p.text;
  if (p.cover && !card.querySelector('.lk-img')) {
    const img = Object.assign(document.createElement('img'), { className: 'lk-img', alt: '', loading: 'lazy' });
    img.onerror = () => img.remove();
    const url = S.fileUrl(p.cover);
    if (url?.then) url.then(u => { if (u) img.src = u; else img.remove(); });
    else img.src = url;
    card.querySelector('.lk-media').append(img);
  }
}

// `opts`: { sidebar, parent (the tree's root, null for the top of the space), open(id, event) (for
// trees out of the sidebar; by default notes open where notes open from lists) }.
function mountTree(el, space, opts) {
  let t = [...trees].find(x => x.el === el);
  if (!t) {
    t = { el, space, ...opts };
    trees.add(t);
    bindTree(t);
  }
  Object.assign(t, opts);
  t.space = space;
  paintTree(t);
}

// The note a tree shows for another one: its outermost database when it is an item (items show
// in their database, not in the tree).
function shownAs(id) {
  let shown = id;
  for (let p = S.getNote(id)?.parent; p; p = S.getNote(p)?.parent) if (S.isDatabase(p)) shown = p;
  return shown;
}

// A database is a single row: its items are in its views. A tree whose root is a database (its
// List view) shows the items.
function paintTree(t) {
  const active = t.sidebar ? shownAs(host.activeNote()) : null;
  const row = (n, depth) => {
    const db = n.kind === 'database';
    const kids = db ? [] : S.childrenOf(t.space, n.id);
    const open = expanded.has(n.id);
    return `<div class="nt-row ${n.id === active ? 'active' : ''} ${db ? 'nt-db' : ''}" data-note="${esc(n.id)}" style="--depth: ${depth}" draggable="true">
        <button class="nt-chev ${kids.length ? '' : 'leaf'} ${open ? 'open' : ''}" data-nt="toggle">${icon('chevron')}</button>
        ${icon(n.icon || (db ? 'table' : 'note'), 'nt-icon')}<span class="nt-title ${n.title ? '' : 'untitled'}">${esc(n.title || (db ? 'Untitled database' : 'Untitled'))}</span>
        <span class="nt-acts"><button class="nt-btn" data-nt="more" title="More">${icon('more')}</button><button class="nt-btn" data-nt="add" title="${db ? 'Add an item' : 'Add a page inside'}">${icon('plus')}</button></span>
      </div>${open ? kids.map(k => row(k, depth + 1)).join('') : ''}`;
  };
  const top = S.childrenOf(t.space, t.parent ?? null);
  t.el.innerHTML = (t.sidebar ? `<div class="nt-side-head">Notes<span class="spacer"></span>
      <button class="nt-btn" data-nt="new-db" title="New database">${icon('table')}</button><button class="nt-btn" data-nt="new" title="New page (Ctrl+N)">${icon('plus')}</button></div>` : '')
    + (top.length ? top.map(n => row(n, 0)).join('') : `<div class="nt-empty">${t.parent ? 'No items yet' : 'No pages yet'}</div>`);
}

function bindTree(t) {
  const el = t.el;
  const rowOf = e => e.target.closest('.nt-row');
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-nt]'), row = rowOf(e), id = row?.dataset.note;
    if (b?.dataset.nt === 'new') return newNote({ space: t.space, open: 'tab' });
    if (b?.dataset.nt === 'new-db') return newDatabase({ space: t.space, open: 'tab' });
    if (!row) return;
    if (b?.dataset.nt === 'toggle') { expand(id, !expanded.has(id)); return paintTree(t); }
    if (b?.dataset.nt === 'add') return newNote({ space: t.space, parent: id, open: t.sidebar ? 'tab' : undefined });
    if (b?.dataset.nt === 'more') {
      const r = b.getBoundingClientRect();
      return host.showMenu(r.left, r.bottom + 4, noteMenuItems(id, 'list'));
    }
    if (t.open) return t.open(id, e);
    if (e.ctrlKey || e.metaKey) return openNote(id, 'tab');
    if (t.sidebar) {
      if (host.activeNote() !== id) host.openTab(id, { replace: true });
    } else {
      openNote(id);
    }
  });
  el.addEventListener('auxclick', e => { if (e.button === 1 && rowOf(e)) openNote(rowOf(e).dataset.note, 'tab'); });
  el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('contextmenu', e => {
    const row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    host.showMenu(e.clientX, e.clientY, noteMenuItems(row.dataset.note, 'list'));
  });

  // Drag a note before, after or inside another one
  let dragged = null;
  const clear = () => el.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  const zone = (row, e) => {
    const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    return y < .3 ? 'before' : y > .7 ? 'after' : 'inside';
  };
  el.addEventListener('dragstart', e => {
    const row = rowOf(e);
    if (!row) return;
    dragged = row.dataset.note;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged);
  });
  el.addEventListener('dragover', e => {
    const row = rowOf(e);
    if (!dragged || !row || row.dataset.note === dragged) return;
    if (S.descendantsOf(dragged).some(d => d.id === row.dataset.note)) return;
    e.preventDefault();
    clear();
    row.classList.add('drop-' + zone(row, e));
  });
  el.addEventListener('drop', e => {
    const row = rowOf(e);
    if (!dragged || !row) return;
    e.preventDefault();
    const moving = dragged;
    dragged = null; // the tree is drawn again, so "dragend" won't reach it
    const target = S.getNote(row.dataset.note), where = zone(row, e);
    if (where === 'inside') {
      if (S.isDatabase(moving) && target.kind === 'database') return host.toast('A database cannot be an item of another database');
      expand(target.id);
      S.moveNote(moving, target.id, null);
      // in a page, it shows at the end of the text: a link to a page, or a database's block
      if (target.kind !== 'database') {
        appendToText(target.id, S.isDatabase(moving) ? { type: 'database', attrs: { id: moving } }
          : { type: 'paragraph', content: [{ type: 'mention', attrs: { id: moving, kind: 'note', label: '' } }] });
      }
    } else {
      const siblings = S.childrenOf(target.space, target.parent ?? null).filter(s => s.id !== moving);
      const i = siblings.findIndex(s => s.id === target.id);
      S.moveNote(moving, target.parent ?? null, where === 'before' ? target.id : siblings[i + 1]?.id ?? null);
    }
  });
  el.addEventListener('dragend', () => { dragged = null; clear(); el.querySelector('.dragging')?.classList.remove('dragging'); });
}

// =====================================================================
// Mentions
// =====================================================================

function mentionView(a) {
  const where = a.repo ? folderName(a.repo) : '';
  switch (a.kind) {
    case 'note': return { icon: noteIcon(a.id), label: S.getNote(a.id) ? noteTitle(a.id) : 'Deleted note', title: 'Open the note' };
    case 'file': return { icon: 'file', label: a.label || a.id.split('/').pop(), title: `${where}/${a.id}` };
    case 'commit': return { icon: 'commit', label: a.label || String(a.id).slice(0, 7), title: `Commit ${a.id} in ${where}` };
    case 'branch': return { icon: 'branch', label: a.id, title: `Branch ${a.id} in ${where}` };
    default: return { icon: 'note', label: a.label || a.id };
  }
}

function openMention(page, a, e) {
  if (a.kind === 'note') return goTo(page, a.id, e);
  host.reveal(a);
}

// What the folders of the space have to mention, read again after a minute.
const sources = new Map(); // folder -> { at, promise }

function folderSource(repo) {
  const cached = sources.get(repo);
  if (cached && Date.now() - cached.at < 60_000) return cached.promise;
  const promise = (async () => {
    const git = await G.gitRaw(repo, ['rev-parse', '--is-inside-work-tree']).then(r => r.code === 0, () => false);
    if (!git) {
      const walk = await G.walkDir(repo).catch(() => ({ files: [] }));
      return { files: walk.files.slice(0, 100_000), branches: [], commits: [] };
    }
    const [files, refs, log] = await Promise.all([
      G.listFiles(repo).catch(() => []),
      G.getRefs(repo).catch(() => null),
      G.gitRaw(repo, ['log', '-n', '300', '--format=%H%x1f%s']).catch(() => null),
    ]);
    const branches = refs ? [...refs.local.map(b => b.name), ...Object.values(refs.remotes).flat().map(b => b.full)] : [];
    const commits = log?.code === 0 ? log.stdout.split('\n').filter(Boolean).map(l => { const [sha, subject] = l.split('\x1f'); return { sha, subject }; }) : [];
    return { files, branches, commits };
  })();
  sources.set(repo, { at: Date.now(), promise });
  return promise;
}

// 3: starts with the query, 2: a word starts with it, 1: contains it, 0: no match.
function rank(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase(), i = t.indexOf(q);
  if (i < 0) return 0;
  return i === 0 ? 3 : /[\s/_.\-]/.test(t[i - 1]) ? 2 : 1;
}

function best(list, score, limit) {
  return list.map(x => [score(x), x]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, x]) => x);
}

async function mentionItems(query, self) {
  const q = query.toLowerCase().trim();
  const space = S.getNote(self)?.space ?? host.space();
  // (the notes of every space, those of this one first, then the ones changed last)
  const notes = best(host.spaces().flatMap(S.notesOf).filter(n => n.id !== self), n => {
    const r = rank(n.title || 'untitled', q);
    return r && r * 2e13 + (n.space === space ? 1e13 : 0) + n.updated;
  }, q ? 8 : 5).map(n => {
    const path = S.pathOf(n.id).map(a => a.title || 'Untitled');
    if (n.space !== space) path.unshift(host.spaceName(n.space));
    return { kind: 'note', id: n.id, label: n.title || 'Untitled', detail: path.join(' / '), icon: noteIcon(n.id), group: 'Pages and databases' };
  });
  const folders = space === host.space() ? host.folders() : [];
  const multi = folders.length > 1;
  const srcs = (await Promise.all(folders.map(f => folderSource(f).then(s => ({ repo: f, ...s }), () => null)))).filter(Boolean);
  const where = repo => (multi ? folderName(repo) : '');
  // (mentions keep the folder's shared path, the same on every computer: see projects.js)
  const branches = best(srcs.flatMap(s => s.branches.map(b => ({ repo: s.repo, b }))), x => rank(x.b, q), q ? 5 : 3)
    .map(({ repo, b }) => ({ kind: 'branch', id: b, repo: sharedPath(repo), label: b, detail: where(repo), icon: 'branch', group: 'Branches' }));
  const commits = best(srcs.flatMap(s => s.commits.map((c, i) => ({ repo: s.repo, c, i }))),
    x => (q.length >= 4 && x.c.sha.startsWith(q) ? 4 : rank(x.c.subject, q)) * 1e4 - x.i, q ? 5 : 3)
    .map(({ repo, c }) => ({ kind: 'commit', id: c.sha, repo: sharedPath(repo), label: `${c.sha.slice(0, 7)} ${c.subject}`, detail: where(repo), icon: 'commit', group: 'Commits' }));
  const files = q ? best(srcs.flatMap(s => s.files.map(f => ({ repo: s.repo, f }))), x => {
    const name = x.f.slice(x.f.lastIndexOf('/') + 1);
    return rank(name, q) * 10 || rank(x.f, q);
  }, 8).map(({ repo, f }) => ({ kind: 'file', id: f, repo: sharedPath(repo), label: f.slice(f.lastIndexOf('/') + 1), detail: (multi ? folderName(repo) + '/' : '') + f.slice(0, f.lastIndexOf('/') + 1), icon: 'file', group: 'Files' })) : [];
  return [...notes, ...branches, ...commits, ...files];
}
