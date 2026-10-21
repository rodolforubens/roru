// Storage of the notes: pages with a title and rich text content, in a tree per space (a project
// id, or 'home'). The UI only goes through this module, which keeps them in one of two places:
//
// - On this computer (the desktop app signed out), as files in the app data folder:
//     notes/index.json   every note's metadata: { id, space, parent, title, order, created, updated,
//                        props, wideViews, openIn }, and the collections (see below)
//     notes/<id>.json    its content (a ProseMirror document as JSON)
//     notes/files/<id>/  its files (images), referred to in the content as "files/<id>/<name>"
// - In the account (signed in; always on the web page), live like the projects: each note is a row
//   of the `notes` table ({ id, data: its metadata, and a database's collection }, kept by
//   mirror.js), its text is a Yjs document (see "Content" below) and its files are in the
//   `note-files` storage bucket, under "<user id>/files/<id>/<name>".
// Signing in never changes the notes kept on this computer: they are only copied to the account
// when the user asks (copyLocalNotes), the ones in the trash with it.
//
// A note is a page (`kind` 'page', the default: rich text, with its nested pages as children) or a
// database (`kind` 'database': no text, its children are its items). Like in Notion, a database
// is shown in a page's text as a block (or opened on its own), and as a single item in the tree.
// A database's collection, keyed by its id, defines custom properties ({ id, name, type, options }),
// which its items fill in (`props`: property id -> value), and views ({ id, type: 'list' | 'table' |
// 'board', name, sort, hidden, groupBy, pinned }) to show them.
// Values by type: text and url a string, number a number, select an option id, multi a list of
// option ids, date "YYYY-MM-DD", checkbox true, branch { repo (folder path), name }.
//
// A deleted note goes to the trash with what is inside it: it gets `trashed` (when), and it and the
// notes inside it leave every list (getNote, childrenOf…) until it is restored or deleted for good
// (see "The trash" below).
import { desktop, invoke, convertFileSrc } from './platform.js?v=870b4f7';
import { db, currentUser } from './account.js?v=870b4f7';
import { createMirror, clone, reportStatus } from './mirror.js?v=870b4f7';
import { Y, updateYFragment, yDocToProsemirrorJSON } from './vendor/tiptap.js?v=870b4f7';
import { noteSchema, fitToSchema } from './editor.js?v=870b4f7';

const SAVE_DELAY = 300; // ms after the last edit (files on this computer)

let mode = null;             // 'local' (files on this computer), 'account', or null (signed out on the web)
let dir = null;              // the notes' folder on this computer
let all = [];                // every note, the ones in the trash too
let notes = [];              // the notes out of the trash (see sift)
let collections = {};
const contents = new Map();  // id -> content, once loaded or edited (open editors share it; local only)
const pending = new Map();   // id -> timer of a content write ('index' for the index)
const listeners = new Set();
let batching = 0;            // inside batch(): changes are told once, at its end
let batched = [];

const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
const file = name => `${dir}/${name}`;

export const notesMode = () => mode;

export async function initNotes() {
  addEventListener('blur', flushNotes);
  document.addEventListener('visibilitychange', flushNotes);
  if (desktop) dir = (await invoke('app_data_dir')).replace(/\\/g, '/') + '/notes';
  await useAccount(currentUser());
}

// Shows the notes of the account of `user` (signed in), or the ones kept on this computer (null).
export async function useAccount(user) {
  flushNotes();
  closeDocs();
  all = [];
  notes = [];
  collections = {};
  contents.clear();
  if (user && db) {
    mode = 'account';
    mirror.use(user);
    openDocsChannel(user);
    resendKept();
  } else {
    mirror.use(null);
    mode = desktop ? 'local' : null;
    if (mode === 'local') await loadLocal();
  }
  tellAll([]);
}

async function loadLocal() {
  const text = await invoke('read_file', { repo: dir, path: 'index.json' }).catch(() => null);
  let version = 3;
  try {
    const data = text ? JSON.parse(text) : {};
    all = data.notes || [];
    collections = data.collections || {};
    version = data.version || 1;
  } catch {
    all = [];
    collections = {};
  }
  sift();
  if (version < 3) await migrate();
  // the webview loads the notes' images straight from their files
  await invoke('allow_assets', { repo: dir }).catch(() => {});
}

// Many changes at once (an import): the listeners hear about them once, when `fn` is done.
export async function batch(fn) {
  batching++;
  try {
    return await fn();
  } finally {
    if (--batching === 0) {
      const ids = [...new Set(batched)];
      batched = [];
      changed(ids);
    }
  }
}

// ---------- files ----------

const BUCKET = 'note-files';
const signed = new Map(); // "files/<id>/<name>" -> { url (a promise), at }
const isAddress = src => /^[a-z][a-z0-9+.-]*:/i.test(src);

// The address the webview loads a file of the notes from ("files/<id>/<name>"), or a web address as
// is. In the account it is a link that works for an hour, so it comes as a promise.
export function fileUrl(src) {
  if (!src || isAddress(src)) return src;
  if (mode !== 'account') return convertFileSrc(`${dir}/${src}`);
  const hit = signed.get(src);
  if (hit && Date.now() - hit.at < 50 * 60_000) return hit.url;
  const url = db.storage.from(BUCKET).createSignedUrl(`${mirror.user.id}/${src}`, 3600).then(r => r.data?.signedUrl || '', () => '');
  signed.set(src, { url, at: Date.now() });
  return url;
}

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };
const typeOf = name => TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';

// Saves a file of a note; returns how its content refers to it.
export async function saveFile(id, name, bytes) {
  const src = `files/${id}/${name}`;
  if (mode === 'account') {
    const { error } = await db.storage.from(BUCKET).upload(`${mirror.user.id}/${src}`, new Blob([bytes], { type: typeOf(name) }), { upsert: true });
    if (error) throw error;
    signed.delete(src);
    return src;
  }
  await invoke('write_bytes', bytes, { headers: { path: encodeURIComponent(`${dir}/${src}`) } });
  return src;
}

// `fn({ ids, removed })` runs after notes are created, renamed, moved, deleted or get new property
// values, and after collections change (with no ids); `removed` has the notes deleted elsewhere.
export function onNotesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Collections of notes that are not databases (only looked at) are not saved.
const saveIndex = () => schedule('index', () => {
  const used = Object.fromEntries(Object.entries(collections).filter(([key]) => lookup(key)?.kind === 'database'));
  return invoke('write_text', { path: file('index.json'), content: JSON.stringify({ version: 3, notes: all, collections: used }) });
});

const persist = () => (mode === 'account' ? mirror.write() : mode === 'local' ? saveIndex() : null);

// Before databases were notes of their own, any note's sub-pages (or a space's top-level notes)
// had properties and views. Those become databases: a note with no text turns into one; a note
// with text gets a new database, shown at the end of its text, holding the sub-pages its text
// doesn't link to (the linked ones stay nested pages); a space's top-level notes that had values
// move into a new top-level database.
async function migrate() {
  // the index as it was stays next to it, in case something has to be looked up later
  if (all.length) await invoke('write_text', { path: file('index-before-databases.json'), content: JSON.stringify({ version: 2, notes: all, collections }) });
  const used = c => c && (c.schema?.length || c.views?.some(v => v.type !== 'list'));
  const raw = (space, parent, title) => {
    const now = Date.now();
    const n = { id: newId(), space, parent, title, kind: 'database', order: -1, created: now, updated: now };
    all.push(n);
    sift();
    return n;
  };
  const linked = doc => {
    const out = new Set();
    const walk = n => { if (n.type === 'mention' && n.attrs?.kind === 'note') out.add(n.attrs.id); n.content?.forEach(walk); };
    if (doc) walk(doc);
    return out;
  };
  const old = collections;
  collections = {};
  for (const [key, c] of Object.entries(old).filter(([k]) => k.startsWith('space:'))) {
    if (!used(c)) continue;
    const space = key.slice(6);
    const db = raw(space, null, 'Database');
    collections[db.id] = c;
    for (const n of all) if (n.space === space && !n.parent && n !== db && n.props && Object.keys(n.props).length) n.parent = db.id;
  }
  for (const [key, c] of Object.entries(old).filter(([k]) => !k.startsWith('space:'))) {
    const page = getNote(key);
    if (!page || !used(c)) continue;
    const doc = await loadContent(key);
    const text = doc?.content?.some(b => b.content?.length || !['paragraph'].includes(b.type));
    const inItems = page.parent && getNote(page.parent)?.kind === 'database';
    if (!text && !inItems) {
      page.kind = 'database';
      collections[key] = c;
      continue;
    }
    const db = raw(page.space, page.id, 'Database');
    collections[db.id] = c;
    const keep = linked(doc);
    for (const n of all) if (n.parent === page.id && n !== db && !keep.has(n.id)) n.parent = db.id;
    const next = { type: 'doc', content: [...(doc?.content || []), { type: 'database', attrs: { id: db.id } }] };
    contents.set(key, next);
    await invoke('write_text', { path: file(`${key}.json`), content: JSON.stringify(next) });
  }
  // orders count from 0 again under every parent
  const groups = new Map();
  for (const n of all) {
    const k = `${n.space}\n${n.parent ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  for (const list of groups.values()) list.sort((a, b) => a.order - b.order).forEach((n, i) => (n.order = i));
  saveIndex();
}

function changed(ids = []) {
  sift();
  if (batching) { batched.push(...ids); return; }
  persist();
  tellAll(ids);
}

const tellAll = (ids, removed = []) => { for (const fn of listeners) fn({ ids, removed }); };

function schedule(key, write) {
  clearTimeout(pending.get(key)?.timer);
  const entry = { write, timer: setTimeout(() => run(key), SAVE_DELAY) };
  pending.set(key, entry);
}

function run(key) {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  entry.write().catch(e => console.error('Saving notes failed', e));
}

// Writes what is waiting to be saved now (when the window loses the focus, before closing a note).
export function flushNotes() {
  for (const key of [...pending.keys()]) run(key);
  for (const d of docs.values()) send(d);
}

// ---------- the tree ----------

export const getNote = id => notes.find(n => n.id === id) || null;
export const notesOf = space => notes.filter(n => n.space === space);
export const childrenOf = (space, parent = null) =>
  notes.filter(n => n.space === space && (n.parent ?? null) === parent).sort((a, b) => a.order - b.order);
const lookup = id => all.find(n => n.id === id) || null; // (in the trash too)

// The note's ancestors, from the top of the tree (a note in the trash has its own too).
export function pathOf(id) {
  const out = [];
  for (let n = lookup(lookup(id)?.parent); n; n = lookup(n.parent)) out.unshift(n);
  return out;
}

// The notes inside a note, at any depth (`trash`: the ones in the trash too).
export function descendantsOf(id, { trash = false } = {}) {
  const out = [], list = trash ? all : notes;
  const walk = parent => list.filter(n => n.parent === parent).forEach(n => { out.push(n); walk(n.id); });
  walk(id);
  return out;
}

// The notes out of the trash: those that aren't in it, nor inside one that is.
function sift() {
  const byId = new Map(all.map(n => [n.id, n])), binned = new Map();
  const inTrash = n => {
    if (!binned.has(n.id)) {
      binned.set(n.id, false); // (a loop of parents ends here)
      const p = n.parent && byId.get(n.parent);
      binned.set(n.id, !!n.trashed || (!!p && inTrash(p)));
    }
    return binned.get(n.id);
  };
  notes = all.filter(n => !inTrash(n));
}

// `kind`: 'page' or 'database' (see the top of this file).
export function createNote({ space, parent = null, title = '', props = null, kind = 'page' }) {
  const siblings = childrenOf(space, parent);
  const now = Date.now();
  const note = { id: newId(), space, parent, title, order: siblings.length ? siblings[siblings.length - 1].order + 1 : 0, created: now, updated: now };
  if (kind === 'database') note.kind = 'database';
  if (props && Object.keys(props).length) note.props = { ...props };
  all.push(note);
  if (mode === 'account') newDoc(note.id); // (nothing to read: it starts empty)
  else contents.set(note.id, null);
  changed([note.id]);
  return note;
}

// A note's icon: an emoji, or null for none (pages and databases then show their kind's icon).
export function setIcon(id, emoji) {
  const n = getNote(id);
  if (!n || (n.icon ?? null) === (emoji || null)) return;
  if (emoji) n.icon = emoji;
  else delete n.icon;
  changed([id]);
}

export function renameNote(id, title) {
  const n = getNote(id);
  if (!n || n.title === title) return;
  n.title = title;
  n.updated = Date.now();
  changed([id]);
}

// Moves a note under `parent` (null for the top), before the sibling `before` (null for the end).
// A note can't go inside itself or one of its sub-pages.
export function moveNote(id, parent, before = null) {
  const n = getNote(id);
  if (!n || id === parent || descendantsOf(id).some(d => d.id === parent)) return false;
  const siblings = childrenOf(n.space, parent).filter(s => s.id !== id);
  const i = before ? siblings.findIndex(s => s.id === before) : -1;
  siblings.splice(i < 0 ? siblings.length : i, 0, n);
  n.parent = parent;
  siblings.forEach((s, k) => (s.order = k));
  changed([id]);
  return true;
}

// Moves a note, with everything inside it (what is in the trash too), to the top of another space;
// returns the moved ids. Its values of its old database's properties stay behind.
export function moveToSpace(id, space) {
  const n = getNote(id);
  if (!n || n.space === space) return [];
  const moved = [n, ...descendantsOf(id, { trash: true })];
  const top = childrenOf(space, null);
  if (n.parent && isDatabase(n.parent)) delete n.props;
  n.parent = null;
  n.order = top.length ? top[top.length - 1].order + 1 : 0;
  for (const m of moved) m.space = space;
  changed(moved.map(m => m.id));
  return moved.map(m => m.id);
}

// ---------- the trash ----------

// Moves a note to the trash, with what is inside it; returns the ids that left the lists.
export function trashNote(id) {
  const n = getNote(id);
  if (!n) return [];
  const ids = [id, ...descendantsOf(id).map(d => d.id)];
  n.trashed = Date.now();
  changed(ids);
  return ids;
}

// The notes moved to the trash (each one deleted on its own: not the ones inside them), of the given
// spaces, the last deleted first.
export const trashOf = spaces => all.filter(n => n.trashed && spaces.includes(n.space)).sort((a, b) => b.trashed - a.trashed);

// A note in the trash (or inside one that is), or null.
export const trashedNote = id => (getNote(id) ? null : lookup(id));

// Puts a note of the trash back where it was, with what is inside it; when the note it was in is gone
// (or still in the trash), at the top of its space. Returns the ids that came back.
export function restoreNote(id) {
  const n = lookup(id);
  if (!n?.trashed) return [];
  delete n.trashed;
  const parent = n.parent && getNote(n.parent);
  if (n.parent && (!parent || parent.space !== n.space)) {
    const top = childrenOf(n.space, null);
    n.parent = null;
    n.order = top.length ? top[top.length - 1].order + 1 : 0;
  }
  sift();
  const ids = [id, ...descendantsOf(id).map(d => d.id)];
  changed(ids);
  return ids;
}

// Deletes a note for good, with what is inside it (in the trash or not); returns their ids.
export function deleteForever(id) {
  if (!lookup(id)) return [];
  const ids = [id, ...descendantsOf(id, { trash: true }).map(n => n.id)];
  all = all.filter(n => !ids.includes(n.id));
  for (const x of ids) {
    delete collections[x];
    contents.delete(x);
    clearTimeout(pending.get(x)?.timer);
    pending.delete(x);
    if (mode === 'local') {
      invoke('remove_file', { path: file(`${x}.json`) }).catch(() => {});
      invoke('remove_data_dir', { path: file(`files/${x}`) }).catch(() => {});
    }
  }
  if (mode === 'account') dropDocs(ids);
  changed(ids);
  return ids;
}

// Moves every note of a space to another one (when a project is deleted, its notes go home, the
// ones in the trash too). The properties of its top-level notes join the other space's.
export function moveSpace(from, to) {
  const moved = all.filter(n => n.space === from);
  const old = collections[`space:${from}`];
  delete collections[`space:${from}`];
  if (old?.schema.length) {
    const target = getCollection(`space:${to}`);
    for (const p of old.schema) if (!target.schema.some(q => q.id === p.id)) target.schema.push(p);
  }
  if (!moved.length) return changed();
  const base = childrenOf(to).length;
  moved.forEach(n => {
    n.space = to;
    if (!n.parent) n.order += base;
  });
  changed(moved.map(n => n.id));
}

// ---------- collections: properties and views ----------

export const OPTION_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const hasOptions = type => type === 'select' || type === 'multi';

export const isDatabase = id => getNote(id)?.kind === 'database';

// The collection of a database is keyed by its id (a space's top level has none of its own).
export const collectionKey = (space, parent = null) => parent ?? `space:${space}`;

// The database a note is an item of, or null (only items have properties).
export const collectionOf = id => { const p = getNote(id)?.parent; return p && isDatabase(p) ? p : null; };

// The databases nested in a page.
export const databasesOf = id => notes.filter(n => n.parent === id && n.kind === 'database');

// A collection starts with only the list view.
export function getCollection(key) {
  return (collections[key] ||= { schema: [], views: [{ id: newId(), type: 'list', name: 'List' }], active: null });
}

// (the items in the trash keep up with their database too, for when they come back)
const membersOf = key => all.filter(n => collectionKey(n.space, n.parent ?? null) === key);
const findProp = (key, id) => getCollection(key).schema.find(p => p.id === id) || null;

export function addProperty(key, { name, type }) {
  const p = { id: newId(), name, type };
  if (hasOptions(type)) p.options = [];
  getCollection(key).schema.push(p);
  changed();
  return p;
}

// Moves a property before another one (null for the end): the order every item shows them in.
export function moveProperty(key, id, before = null) {
  const c = getCollection(key), p = c.schema.find(x => x.id === id);
  if (!p || id === before) return;
  c.schema = c.schema.filter(x => x !== p);
  const i = before ? c.schema.findIndex(x => x.id === before) : -1;
  c.schema.splice(i < 0 ? c.schema.length : i, 0, p);
  changed();
}

export function renameProperty(key, id, name) {
  const p = findProp(key, id);
  if (!p || !name.trim()) return;
  p.name = name.trim();
  changed();
}

// Changing the type keeps what can be kept: text becomes options, options become text, and so on.
export function setPropertyType(key, id, type) {
  const p = findProp(key, id);
  if (!p || p.type === type) return;
  const label = v => (p.type === 'select' ? p.options.find(o => o.id === v)?.name
    : p.type === 'multi' ? (v || []).map(x => p.options.find(o => o.id === x)?.name).filter(Boolean).join(', ')
    : p.type === 'branch' ? v?.name ?? ''
    : p.type === 'checkbox' ? (v ? 'Yes' : '') : v == null ? '' : String(v));
  const old = p.type;
  if (hasOptions(type) && !hasOptions(old)) p.options = [];
  for (const n of membersOf(key)) {
    const v = n.props?.[id];
    if (v == null) continue;
    let next = null;
    if (hasOptions(old) && hasOptions(type)) next = type === 'multi' ? [].concat(v) : [].concat(v)[0] ?? null;
    else if (type === 'branch') next = null; // a name alone doesn't say which repository
    else {
      const text = label(v);
      if (type === 'text' || type === 'url') next = text || null;
      else if (type === 'number') next = Number.isFinite(parseFloat(text)) ? parseFloat(text) : null;
      else if (type === 'checkbox') next = !!text && text !== '0' ? true : null;
      else if (type === 'date') next = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
      else if (hasOptions(type)) {
        const ids = text.split(',').map(s => s.trim()).filter(Boolean).map(name => optionFor(p, name).id);
        next = type === 'multi' ? ids : ids[0] ?? null;
      }
    }
    if (next == null || (Array.isArray(next) && !next.length)) delete n.props[id];
    else n.props[id] = next;
  }
  p.type = type;
  if (!hasOptions(type)) delete p.options;
  changed();
}

export function deleteProperty(key, id) {
  const c = getCollection(key);
  c.schema = c.schema.filter(p => p.id !== id);
  for (const v of c.views) {
    if (v.sort?.prop === id) delete v.sort;
    if (v.groupBy === id) delete v.groupBy;
    if (v.hidden) v.hidden = v.hidden.filter(x => x !== id);
  }
  for (const n of membersOf(key)) if (n.props) delete n.props[id];
  changed();
}

function optionFor(p, name) {
  let o = p.options.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!o) {
    o = { id: newId(), name, color: OPTION_COLORS[p.options.length % OPTION_COLORS.length] };
    p.options.push(o);
  }
  return o;
}

export function addOption(key, propId, name, color = null) {
  const p = findProp(key, propId);
  if (!p?.options || !name.trim()) return null;
  const o = optionFor(p, name.trim());
  if (color) o.color = color;
  changed();
  return o;
}

export function updateOption(key, propId, optionId, changes) {
  const o = findProp(key, propId)?.options?.find(x => x.id === optionId);
  if (!o) return;
  if (changes.name?.trim()) o.name = changes.name.trim();
  if (changes.color) o.color = changes.color;
  changed();
}

// Moves an option before another one (null for the end). The options' order is also the order of
// a board's columns.
export function moveOption(key, propId, optionId, before = null) {
  const p = findProp(key, propId);
  const o = p?.options?.find(x => x.id === optionId);
  if (!o || optionId === before) return;
  p.options = p.options.filter(x => x !== o);
  const i = before ? p.options.findIndex(x => x.id === before) : -1;
  p.options.splice(i < 0 ? p.options.length : i, 0, o);
  changed();
}

// Notes that had the option lose it.
export function deleteOption(key, propId, optionId) {
  const p = findProp(key, propId);
  if (!p?.options) return;
  p.options = p.options.filter(o => o.id !== optionId);
  for (const n of membersOf(key)) {
    const v = n.props?.[propId];
    if (v === optionId) delete n.props[propId];
    else if (Array.isArray(v)) {
      n.props[propId] = v.filter(x => x !== optionId);
      if (!n.props[propId].length) delete n.props[propId];
    }
  }
  changed();
}

// Sets a note's value of a property; an empty value removes it.
export function setProp(id, propId, value) {
  const n = getNote(id);
  if (!n) return;
  n.props ||= {};
  const empty = value == null || value === '' || value === false || (Array.isArray(value) && !value.length);
  if (empty) delete n.props[propId];
  else n.props[propId] = value;
  n.updated = Date.now();
  changed([id]);
}

export function addView(key, type, name) {
  const c = getCollection(key);
  const v = { id: newId(), type, name };
  c.views.push(v);
  c.active = v.id;
  changed();
  return v;
}

export function updateView(key, id, changes) {
  const v = getCollection(key).views.find(x => x.id === id);
  if (!v) return;
  Object.assign(v, changes);
  for (const k of Object.keys(changes)) if (changes[k] == null) delete v[k];
  changed();
}

// A collection always has a view: deleting the last one brings back the list.
export function deleteView(key, id) {
  const c = getCollection(key);
  c.views = c.views.filter(v => v.id !== id);
  if (!c.views.length) c.views = [{ id: newId(), type: 'list', name: 'List' }];
  if (!c.views.some(v => v.id === c.active)) c.active = c.views[0].id;
  changed();
}

// Forgets a collection's properties and views, and its notes' values of them.
export function resetCollection(key) {
  for (const n of membersOf(key)) delete n.props;
  delete collections[key];
  const page = getNote(key);
  if (page) delete page.wideViews;
  changed();
}

// Whether a page shows its databases across its whole width (its text keeps its column): what the
// page says, or else yes when one of them has a table or a board. A database's own page always does.
export function wideViewsOf(id) {
  const n = getNote(id);
  if (!n) return false;
  if (n.kind === 'database') return true;
  return n.wideViews ?? databasesOf(id).some(d => (collections[d.id]?.views || []).some(v => v.type !== 'list'));
}

export function setWideViews(id, on) {
  const n = getNote(id);
  if (!n) return;
  n.wideViews = on;
  changed([id]);
}

// Where the notes inside a note open from its views and lists (`openIn`: 'side', 'center' or 'tab'),
// when it chose it; without a choice it opens them like its parent does. This is the note whose
// choice counts for the notes inside `id`: itself or its nearest parent that has one (null: none
// does, so the top of the space decides).
export function openInSource(id) {
  for (let n = getNote(id); n; n = getNote(n.parent)) if (n.openIn) return n.id;
  return null;
}

// `mode` null: like its parent.
export function setOpenIn(id, mode) {
  const n = getNote(id);
  if (!n || (n.openIn ?? null) === mode) return;
  if (mode) n.openIn = mode;
  else delete n.openIn;
  changed([id]);
}

export function setActiveView(key, id) {
  const c = getCollection(key);
  if (c.active === id) return;
  c.active = id;
  changed();
}

// ---------- content ----------
//
// On this computer, a note's content is a ProseMirror document (JSON) in its file. In the account,
// it is a Yjs document, so what is typed in two places at once merges without losing anything: it
// is kept as the updates made to it, rows of `note_updates` ({ note_id, data: a Yjs update in
// base64 }) that are only ever added, so no device can overwrite what another one wrote. An open
// editor edits the document directly (the Collaboration extension); its changes are sent a few at
// a time (and kept on this device until they are, so nothing typed offline is lost), and the ones
// made elsewhere come in live. When a note has many rows, they are folded into one (the whole
// document as a single update) and the rows it covers are deleted.

// The note's content (JSON), or null when it is empty.
export async function loadContent(id) {
  if (mode === 'account') {
    const d = await docOf(id);
    const json = yDocToProsemirrorJSON(d.ydoc, FIELD);
    return json.content?.length ? json : null;
  }
  if (contents.has(id)) return contents.get(id);
  const text = await invoke('read_file', { repo: dir, path: `${id}.json` }).catch(() => null);
  let doc = null;
  try {
    doc = text ? JSON.parse(text) : null;
  } catch {
    doc = null;
  }
  if (!contents.has(id)) contents.set(id, doc);
  return contents.get(id);
}

// Replaces the note's content (JSON). In the account, only what differs is changed in its document,
// so what is being typed elsewhere stays.
export function saveContent(id, doc) {
  const n = lookup(id);
  if (!n) return;
  n.updated = Date.now();
  if (mode === 'account') {
    docOf(id).then(d => d.ydoc.transact(() => fill(d, doc))).catch(e => console.error('Saving a note failed', e));
    persist();
    return;
  }
  contents.set(id, doc);
  schedule(id, () => invoke('write_text', { path: file(`${id}.json`), content: JSON.stringify(doc) }));
  saveIndex();
}

const fill = (d, json) => updateYFragment(d.ydoc, d.ydoc.getXmlFragment(FIELD), noteSchema().nodeFromJSON(fitToSchema(json)), { mapping: new Map(), isOMark: new Map() });

// A document whose text doesn't fit the editor (pictures loose among blocks, copied or imported
// before fitToSchema) is fixed when it is read, and the fix is sent like any change.
function repair(d) {
  const json = yDocToProsemirrorJSON(d.ydoc, FIELD);
  if (JSON.stringify(fitToSchema(json)) !== JSON.stringify(json)) d.ydoc.transact(() => fill(d, json));
}

// What an editor of the note edits: its content (JSON, on this computer: its changes go to
// saveContent), or its Yjs document (in the account: it saves itself).
export async function openContent(id) {
  if (mode === 'account') return { ydoc: (await docOf(id)).ydoc };
  return { content: await loadContent(id) };
}

// An editor of the note was closed: what it changed is sent, and its rows folded when there are many.
export function closeContent(id) {
  flushNotes();
  const d = docs.get(id);
  if (d && d.rows.size > FOLD_AT) d.ready.then(() => fold(d));
}

const FIELD = 'default';         // the Yjs fragment the editor keeps the text in
const FOLD_AT = 40;              // rows of a note that are folded into one
const SEND_AFTER = 120;          // ms: what is typed meanwhile goes in the same row
const REMOTE = { remote: true }; // the origin of the changes that came from the account

const docs = new Map();          // note id -> { id, ydoc, ready, rows (ids applied), queue (updates to send), timer, sending, retry }
let docsChannel = null;
let docsUser = null;
let failures = 0;

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

function docStatus() {
  const busy = [...docs.values()].some(d => d.queue.length || d.sending);
  reportStatus('text', mode !== 'account' ? null : failures ? 'offline' : busy ? 'syncing' : 'synced');
}

// What was typed and not sent yet is kept on this device (per user), so it survives going offline
// or closing the app.
const keptKey = () => `roru.notes-unsent.${docsUser?.id}`;
function keepUnsent() {
  if (!docsUser) return;
  const out = {};
  for (const d of docs.values()) if (d.queue.length) out[d.id] = d.queue.map(b64);
  try { localStorage.setItem(keptKey(), JSON.stringify(out)); } catch {}
}
function keptUnsent() {
  try { return JSON.parse(localStorage.getItem(keptKey())) || {}; } catch { return {}; }
}

function blankDoc(id) {
  const d = { id, ydoc: new Y.Doc(), rows: new Set(), queue: [], timer: null, sending: null, retry: 0, folding: false };
  docs.set(id, d);
  return d;
}
const listen = d => d.ydoc.on('update', (u, origin) => { if (origin !== REMOTE) queue(d, u); });

// A new note's document: there is nothing to read.
function newDoc(id) {
  const d = blankDoc(id);
  listen(d);
  d.ready = Promise.resolve(d);
  return d;
}

// The note's document, read from the account the first time.
function docOf(id) {
  const known = docs.get(id);
  if (known) return known.ready;
  const d = blankDoc(id);
  d.ready = (async () => {
    await pull(d);
    // what was typed here and not sent yet
    for (const u of keptUnsent()[id] || []) {
      const bytes = unb64(u);
      Y.applyUpdate(d.ydoc, bytes, REMOTE);
      d.queue.push(bytes);
    }
    listen(d);
    repair(d);
    if (d.queue.length) send(d);
    else if (d.rows.size > FOLD_AT) fold(d);
    return d;
  })();
  d.ready.catch(() => { if (docs.get(id) === d) docs.delete(id); });
  return d.ready;
}

// Reads the rows of the note's document that this device doesn't have yet.
async function pull(d) {
  const after = d.rows.size ? Math.max(...d.rows) : 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('note_updates').select('id, data').eq('note_id', d.id).gt('id', after).order('id').range(from, from + 999);
    if (error) throw error;
    for (const r of data) apply(d, r);
    if (data.length < 1000) break;
  }
}

function apply(d, r) {
  if (d.rows.has(r.id)) return;
  d.rows.add(r.id);
  Y.applyUpdate(d.ydoc, unb64(r.data), REMOTE);
}

function queue(d, update) {
  d.queue.push(update);
  keepUnsent();
  docStatus();
  // a note's `updated` follows its text, at most once a minute (it is a write of its row)
  const n = getNote(d.id);
  if (n && Date.now() - (n.updated || 0) > 60_000) { n.updated = Date.now(); persist(); }
  if (!d.timer && !d.sending) d.timer = setTimeout(() => send(d), SEND_AFTER);
}

// Sends what was typed as one row.
function send(d) {
  clearTimeout(d.timer);
  d.timer = null;
  if (d.sending || !d.queue.length || !docsUser) return d.sending;
  const user = docsUser, batch = d.queue.splice(0);
  d.sending = (async () => {
    const { data, error } = await db.from('note_updates').insert({ note_id: d.id, data: b64(Y.mergeUpdates(batch)) }).select('id').single();
    if (docsUser !== user) return;
    if (error) {
      console.warn('Could not send the text of a note', error);
      d.queue.unshift(...batch);
      failures++;
      d.retry = Math.min(60000, d.retry ? d.retry * 2 : 2000);
      d.timer = setTimeout(() => send(d), d.retry);
      return;
    }
    d.rows.add(data.id);
    if (d.retry) failures = Math.max(0, failures - 1);
    d.retry = 0;
    keepUnsent();
  })().finally(() => {
    d.sending = null;
    if (d.queue.length && !d.timer) d.timer = setTimeout(() => send(d), SEND_AFTER);
    docStatus();
  });
  docStatus();
  return d.sending;
}

// Folds the note's rows into one: the whole document, as one update, then the rows it covers go.
// Two devices folding at once leave two rows, which is fine (applying one twice changes nothing).
async function fold(d) {
  if (d.folding || d.queue.length || d.sending) return;
  d.folding = true;
  const covered = [...d.rows];
  try {
    const { data, error } = await db.from('note_updates').insert({ note_id: d.id, data: b64(Y.encodeStateAsUpdate(d.ydoc)) }).select('id').single();
    if (error) throw error;
    d.rows.add(data.id);
    for (let i = 0; i < covered.length; i += 100) {
      const part = covered.slice(i, i + 100);
      const r = await db.from('note_updates').delete().in('id', part);
      if (r.error) throw r.error;
      part.forEach(x => d.rows.delete(x));
    }
  } catch (e) {
    console.warn('Could not fold the rows of a note', e);
  } finally {
    d.folding = false;
  }
}

// The text changed elsewhere comes in live, for the notes this device has read.
function openDocsChannel(user) {
  docsUser = user;
  failures = 0;
  docsChannel = db.channel(`note-text:${user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'note_updates' }, ({ new: r }) => {
      const d = docs.get(r.note_id);
      if (!d || d.rows.has(r.id)) return;
      // (a row too big to come in the message is read)
      d.ready.then(() => (r.data ? apply(d, r) : pull(d))).catch(() => {});
    })
    .subscribe(s => {
      // (re)connected: what was missed meanwhile is read, and what was typed here is sent
      if (s !== 'SUBSCRIBED') return;
      for (const d of docs.values()) d.ready.then(() => pull(d)).then(() => send(d)).catch(() => {});
    });
  docStatus();
}

function closeDocs() {
  if (docsChannel) { db.removeChannel(docsChannel); docsChannel = null; }
  for (const d of docs.values()) { clearTimeout(d.timer); d.ydoc.destroy(); }
  docs.clear();
  signed.clear();
  docsUser = null;
  failures = 0;
  docStatus();
}

// The notes with text typed and not sent last time are read, which sends it.
function resendKept() {
  for (const id of Object.keys(keptUnsent())) docOf(id).catch(() => {});
}

// Deleted notes take their text and files with them.
function dropDocs(ids) {
  for (const id of ids) {
    const d = docs.get(id);
    if (d) { clearTimeout(d.timer); d.queue = []; d.ydoc.destroy(); docs.delete(id); }
  }
  keepUnsent();
  const uid = mirror.user.id;
  db.from('note_updates').delete().in('note_id', ids).then(r => r.error && console.warn('Could not delete the text of the notes', r.error));
  for (const id of ids) {
    db.storage.from(BUCKET).list(`${uid}/files/${id}`).then(({ data }) => {
      if (data?.length) db.storage.from(BUCKET).remove(data.map(f => `${uid}/files/${id}/${f.name}`));
    });
  }
}

addEventListener('online', () => { for (const d of docs.values()) send(d); });

// ---------- the account ----------

// A note as a row: its metadata, and a database's collection (properties and views).
function rowsOf() {
  return {
    notes: new Map(all.map(n => {
      const { id, ...data } = n;
      if (n.kind === 'database' && collections[id]) data.collection = collections[id];
      return [id, { id, data: clone(data) }];
    })),
  };
}

// The notes from the rows. The note objects are kept (updated in place), so the ones the UI holds
// stay current; the collections of what isn't a database (only looked at) stay as they are.
let binnedElsewhere = []; // the notes moved to the trash elsewhere, told with the ones deleted
function build(rows) {
  const old = new Map(all.map(n => [n.id, n])), shown = notes.map(n => n.id);
  for (const key of Object.keys(collections)) if (rows.notes.has(key)) delete collections[key];
  all = [...rows.notes.values()].map(r => {
    const { collection, ...data } = clone(r.data);
    if (collection) collections[r.id] = collection;
    const n = old.get(r.id) || {};
    for (const k of Object.keys(n)) delete n[k];
    return Object.assign(n, data, { id: r.id });
  });
  sift();
  binnedElsewhere.push(...shown.filter(id => !getNote(id) && lookup(id)));
}

const mirror = createMirror({
  name: 'notes',
  tables: { notes: 'id, data' },
  rowsOf,
  build,
  changed: ({ removed }) => {
    const gone = removed.notes || [];
    for (const id of gone) {
      const d = docs.get(id);
      if (d) { clearTimeout(d.timer); d.ydoc.destroy(); docs.delete(id); }
    }
    const binned = binnedElsewhere.splice(0);
    if (mode === 'account') tellAll(notes.map(n => n.id), [...gone, ...binned]);
  },
});

// ---------- the notes of this computer, copied to the account ----------

async function readLocalIndex() {
  const text = await invoke('read_file', { repo: dir, path: 'index.json' }).catch(() => null);
  try {
    const data = text ? JSON.parse(text) : {};
    return { notes: data.notes || [], collections: data.collections || {} };
  } catch {
    return { notes: [], collections: {} };
  }
}

// The notes of this computer that the account doesn't have (signed in on the desktop app).
export async function localOnlyNotes() {
  if (!desktop || mode !== 'account') return [];
  return (await readLocalIndex()).notes.filter(n => !lookup(n.id));
}

// Copies the notes of this computer that the account doesn't have, with their text, databases and
// images, and the same ids (so mentions and tabs keep pointing at them). Nothing on this computer
// changes. `onProgress(done, total)`. Returns how many were copied.
export async function copyLocalNotes(onProgress = () => {}) {
  if (!desktop || mode !== 'account') return 0;
  const index = await readLocalIndex();
  const fresh = index.notes.filter(n => !lookup(n.id));
  if (!fresh.length) return 0;
  await batch(() => {
    for (const n of fresh) {
      all.push(clone(n));
      if (index.collections[n.id]) collections[n.id] = clone(index.collections[n.id]);
      newDoc(n.id);
    }
    batched.push(...fresh.map(n => n.id));
  });
  let done = 0;
  for (const n of fresh) {
    const text = await invoke('read_file', { repo: dir, path: `${n.id}.json` }).catch(() => null);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const d = docs.get(n.id);
    if (d && json?.content?.length) d.ydoc.transact(() => fill(d, json));
    const files = await invoke('list_dir', { repo: dir, path: `files/${n.id}` }).catch(() => []);
    for (const f of files.filter(f => !f.dir)) {
      const bytes = await invoke('read_bytes', { path: file(`files/${n.id}/${f.name}`) });
      await saveFile(n.id, f.name, new Uint8Array(bytes));
    }
    onProgress(++done, fresh.length);
  }
  flushNotes();
  await Promise.all([...docs.values()].map(d => d.sending));
  return fresh.length;
}
