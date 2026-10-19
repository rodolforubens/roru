// Storage of the notes: pages with a title and rich text content (a ProseMirror document as JSON),
// in a tree per space (a project id, or 'home'). The UI only goes through this module, so the
// storage can change without touching it: notes are local-first, and syncing them (Supabase, merged
// with Yjs) is planned behind this same interface. For now they are files in the app data folder:
//   notes/index.json   every note's metadata: { id, space, parent, title, order, created, updated,
//                      props, wideViews, openIn }, and the collections (see below)
//   notes/<id>.json    its content
//   notes/files/<id>/  its files (images), referred to in the content as "files/<id>/<name>"
//
// A note is a page (`kind` 'page', the default: rich text, with its nested pages as children) or a
// database (`kind` 'database': no text, its children are its items). Like in Notion, a database
// is shown in a page's text as a block (or opened on its own), and as a single item in the tree.
// A database's collection, keyed by its id, defines custom properties ({ id, name, type, options }),
// which its items fill in (`props`: property id -> value), and views ({ id, type: 'list' | 'table' |
// 'board', name, sort, hidden, groupBy, pinned }) to show them.
// Values by type: text and url a string, number a number, select an option id, multi a list of
// option ids, date "YYYY-MM-DD", checkbox true, branch { repo (folder path), name }.
import { invoke, convertFileSrc } from './platform.js';

const SAVE_DELAY = 300; // ms after the last edit

let dir = null;
let notes = [];
let collections = {};
const contents = new Map();  // id -> content, once loaded or edited (open editors share it)
const pending = new Map();   // id -> timer of a content write ('index' for the index)
const listeners = new Set();
let batching = 0;            // inside batch(): changes are told once, at its end
let batched = [];

const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
const file = name => `${dir}/${name}`;

export async function initNotes() {
  dir = (await invoke('app_data_dir')).replace(/\\/g, '/') + '/notes';
  const text = await invoke('read_file', { repo: dir, path: 'index.json' }).catch(() => null);
  let version = 3;
  try {
    const data = text ? JSON.parse(text) : {};
    notes = data.notes || [];
    collections = data.collections || {};
    version = data.version || 1;
  } catch {
    notes = [];
    collections = {};
  }
  if (version < 3) await migrate();
  // the webview loads the notes' images straight from their files
  await invoke('allow_assets', { repo: dir }).catch(() => {});
  addEventListener('blur', flushNotes);
  document.addEventListener('visibilitychange', flushNotes);
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

// The address the webview loads a file of the notes from ("files/<id>/<name>"), or a web address as is.
export const fileUrl = src => (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) ? src : convertFileSrc(`${dir}/${src}`));

// Saves a file of a note; returns how its content refers to it.
export async function saveFile(id, name, bytes) {
  const src = `files/${id}/${name}`;
  await invoke('write_bytes', bytes, { headers: { path: encodeURIComponent(`${dir}/${src}`) } });
  return src;
}

// `fn({ ids })` runs after notes are created, renamed, moved, deleted or get new property values,
// and after collections change (with no ids).
export function onNotesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Collections of notes that are not databases (only looked at) are not saved.
const saveIndex = () => schedule('index', () => {
  const used = Object.fromEntries(Object.entries(collections).filter(([key]) => isDatabase(key)));
  return invoke('write_text', { path: file('index.json'), content: JSON.stringify({ version: 3, notes, collections: used }) });
});

// Before databases were notes of their own, any note's sub-pages (or a space's top-level notes)
// had properties and views. Those become databases: a note with no text turns into one; a note
// with text gets a new database, shown at the end of its text, holding the sub-pages its text
// doesn't link to (the linked ones stay nested pages); a space's top-level notes that had values
// move into a new top-level database.
async function migrate() {
  // the index as it was stays next to it, in case something has to be looked up later
  if (notes.length) await invoke('write_text', { path: file('index-before-databases.json'), content: JSON.stringify({ version: 2, notes, collections }) });
  const used = c => c && (c.schema?.length || c.views?.some(v => v.type !== 'list'));
  const raw = (space, parent, title) => {
    const now = Date.now();
    const n = { id: newId(), space, parent, title, kind: 'database', order: -1, created: now, updated: now };
    notes.push(n);
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
    for (const n of notes) if (n.space === space && !n.parent && n !== db && n.props && Object.keys(n.props).length) n.parent = db.id;
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
    for (const n of notes) if (n.parent === page.id && n !== db && !keep.has(n.id)) n.parent = db.id;
    const next = { type: 'doc', content: [...(doc?.content || []), { type: 'database', attrs: { id: db.id } }] };
    contents.set(key, next);
    await invoke('write_text', { path: file(`${key}.json`), content: JSON.stringify(next) });
  }
  // orders count from 0 again under every parent
  const groups = new Map();
  for (const n of notes) {
    const k = `${n.space}\n${n.parent ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  for (const list of groups.values()) list.sort((a, b) => a.order - b.order).forEach((n, i) => (n.order = i));
  saveIndex();
}

function changed(ids = []) {
  saveIndex();
  if (batching) { batched.push(...ids); return; }
  for (const fn of listeners) fn({ ids });
}

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
}

// ---------- the tree ----------

export const getNote = id => notes.find(n => n.id === id) || null;
export const notesOf = space => notes.filter(n => n.space === space);
export const childrenOf = (space, parent = null) =>
  notes.filter(n => n.space === space && (n.parent ?? null) === parent).sort((a, b) => a.order - b.order);

// The note's ancestors, from the top of the tree.
export function pathOf(id) {
  const out = [];
  for (let n = getNote(getNote(id)?.parent); n; n = getNote(n.parent)) out.unshift(n);
  return out;
}

export function descendantsOf(id) {
  const out = [];
  const walk = parent => notes.filter(n => n.parent === parent).forEach(n => { out.push(n); walk(n.id); });
  walk(id);
  return out;
}

// `kind`: 'page' or 'database' (see the top of this file).
export function createNote({ space, parent = null, title = '', props = null, kind = 'page' }) {
  const siblings = childrenOf(space, parent);
  const now = Date.now();
  const note = { id: newId(), space, parent, title, order: siblings.length ? siblings[siblings.length - 1].order + 1 : 0, created: now, updated: now };
  if (kind === 'database') note.kind = 'database';
  if (props && Object.keys(props).length) note.props = { ...props };
  notes.push(note);
  contents.set(note.id, null);
  changed([note.id]);
  return note;
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

// Moves a note, with everything inside it, to the top of another space; returns the moved ids.
// Its values of its old database's properties stay behind.
export function moveToSpace(id, space) {
  const n = getNote(id);
  if (!n || n.space === space) return [];
  const moved = [n, ...descendantsOf(id)];
  const top = childrenOf(space, null);
  if (n.parent && isDatabase(n.parent)) delete n.props;
  n.parent = null;
  n.order = top.length ? top[top.length - 1].order + 1 : 0;
  for (const m of moved) m.space = space;
  changed(moved.map(m => m.id));
  return moved.map(m => m.id);
}

// Deletes a note and its sub-pages; returns their ids.
export function deleteNote(id) {
  const ids = [id, ...descendantsOf(id).map(n => n.id)];
  notes = notes.filter(n => !ids.includes(n.id));
  for (const x of ids) {
    delete collections[x];
    contents.delete(x);
    clearTimeout(pending.get(x)?.timer);
    pending.delete(x);
    invoke('remove_file', { path: file(`${x}.json`) }).catch(() => {});
    invoke('remove_data_dir', { path: file(`files/${x}`) }).catch(() => {});
  }
  changed(ids);
  return ids;
}

// Moves every note of a space to another one (when a project is deleted, its notes go home).
// The properties of its top-level notes join the other space's.
export function moveSpace(from, to) {
  const moved = notesOf(from);
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

const membersOf = key => notes.filter(n => collectionKey(n.space, n.parent ?? null) === key);
const findProp = (key, id) => getCollection(key).schema.find(p => p.id === id) || null;

export function addProperty(key, { name, type }) {
  const p = { id: newId(), name, type };
  if (hasOptions(type)) p.options = [];
  getCollection(key).schema.push(p);
  changed();
  return p;
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

// The note's content, or null when it is empty.
export async function loadContent(id) {
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

export function saveContent(id, doc) {
  const n = getNote(id);
  if (!n) return;
  contents.set(id, doc);
  n.updated = Date.now();
  schedule(id, () => invoke('write_text', { path: file(`${id}.json`), content: JSON.stringify(doc) }));
  saveIndex();
}
