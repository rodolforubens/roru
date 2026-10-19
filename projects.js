// Projects group folders (Git repositories or not). Each project is also a space with its own tabs
// (see app.js) and a dashboard (see dashboard.js). This module owns how projects are stored, so the
// UI doesn't depend on it: signed out, they are kept on this device; signed in (see account.js),
// they are kept in the account, where every change is written right away and the changes made
// elsewhere (the web page, another computer) come in live (see "Account" below). The ones kept on
// this device are never changed by the account: they go there only as copies (importProjects).
// Folders are local paths like "C:/Projects/api" ({ path }), the same keys the tabs use.
import { store } from './util.js';
import { db } from './account.js';

export const COLORS = ['#7aa2f7', '#9ece6a', '#f7768e', '#e0af68', '#bb9af7', '#2ac3de', '#ff9e64', '#73daca'];

// The projects kept on this device (shown signed out).
export const localProjects = () => (store('projects') || []).filter(p => p?.id);

let projects = localProjects();
const save = () => (account ? write() : store('projects', projects));

const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

export const listProjects = () => projects;
export const getProject = id => projects.find(p => p.id === id) || null;

// The color used the least so far, so a new project stands apart from the others.
function nextColor() {
  const uses = c => projects.filter(p => p.color === c).length;
  return COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
}

export function createProject(name) {
  const p = { id: newId(), name: name.trim(), color: nextColor(), folders: [] };
  projects.push(p);
  save();
  return p;
}

export function renameProject(id, name) {
  const p = getProject(id);
  if (!p || !name.trim()) return;
  p.name = name.trim();
  save();
}

export function deleteProject(id) {
  projects = projects.filter(p => p.id !== id);
  save();
}

// Moves a project before (or after) another one, as dragged in the rail.
export function moveProject(id, targetId, after = false) {
  const p = getProject(id);
  if (!p || id === targetId) return;
  projects = projects.filter(x => x !== p);
  const i = projects.findIndex(x => x.id === targetId);
  projects.splice(i < 0 ? projects.length : i + (after ? 1 : 0), 0, p);
  save();
}

// Adds folders, skipping the ones the project already has. Returns how many were added.
export function addFolders(id, paths) {
  const p = getProject(id);
  if (!p) return 0;
  const fresh = [...new Set(paths)].filter(path => !p.folders.some(f => f.path === path));
  p.folders.push(...fresh.map(path => ({ path })));
  save();
  return fresh.length;
}

export function removeFolder(id, path) {
  const p = getProject(id);
  if (!p) return;
  p.folders = p.folders.filter(f => f.path !== path);
  save();
}

// Points a folder that was moved (or renamed) to where it is now.
export function replaceFolder(id, path, next) {
  const p = getProject(id);
  const f = p?.folders.find(x => x.path === path);
  if (!f) return;
  if (p.folders.some(x => x.path === next)) p.folders = p.folders.filter(x => x !== f);
  else f.path = next;
  save();
}

export const hasFolder = (p, path) => p.folders.some(f => f.path === path);

// "Roru Dashboard" -> "RD", "roru-git" -> "RG", "api" -> "A".
export function initials(name) {
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  return words.slice(0, 2).map(w => [...w][0]).join('').toUpperCase() || '?';
}

// =====================================================================
// Links: cards on the dashboard, with the preview of the page they point to
// ({ id, url, title, description, image, icon, site, fetched }; the preview fields are filled in later)
// =====================================================================

export const links = p => p?.links || [];

export function addLink(id, url) {
  const p = getProject(id);
  if (!p) return null;
  const link = { id: newId(), url };
  (p.links ||= []).push(link);
  save();
  return link;
}

export function updateLink(id, linkId, fields) {
  const link = links(getProject(id)).find(l => l.id === linkId);
  if (!link) return;
  Object.assign(link, fields);
  save();
}

export function removeLink(id, linkId) {
  const p = getProject(id);
  if (!p) return;
  p.links = links(p).filter(l => l.id !== linkId);
  save();
}

// Moves a link before (or after) another one, as dragged in the grid.
export function moveLink(id, linkId, targetId, after = false) {
  const p = getProject(id), list = links(p), link = list.find(l => l.id === linkId);
  if (!link || linkId === targetId) return;
  p.links = list.filter(l => l !== link);
  const i = p.links.findIndex(l => l.id === targetId);
  p.links.splice(i < 0 ? p.links.length : i + (after ? 1 : 0), 0, link);
  save();
}

// =====================================================================
// Sections of the dashboard: their order (stacked vertically) and whether it is locked
// =====================================================================

export const SECTIONS = ['folders', 'links', 'notes'];

export function sections(p) {
  const order = (p?.sections || []).filter(s => SECTIONS.includes(s));
  return [...new Set([...order, ...SECTIONS])];
}

export function moveSection(id, sec, target, after = false) {
  const p = getProject(id);
  if (!p || sec === target) return;
  const order = sections(p).filter(s => s !== sec);
  const i = order.indexOf(target);
  order.splice(i < 0 ? order.length : i + (after ? 1 : 0), 0, sec);
  p.sections = order;
  save();
}

export function setSectionsLocked(id, locked) {
  const p = getProject(id);
  if (!p) return;
  p.sectionsLocked = locked;
  save();
}

// =====================================================================
// Export and import (a file with the projects, or the ones kept on this device)
// =====================================================================

export const projectsFile = (list = projects) => ({
  app: 'roru-dashboard', kind: 'projects', version: 1, exported: new Date().toISOString(), projects: JSON.parse(JSON.stringify(list)),
});

// The projects in a file made by projectsFile (or a plain list of them); null when it isn't one.
export function readProjectsFile(text) {
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data?.projects;
    return Array.isArray(list) ? list.filter(p => p?.id && typeof p.name === 'string') : null;
  } catch {
    return null;
  }
}

// Adds copies of `list` to the projects shown (the account's when signed in), with the same ids, so
// their notes and tabs on this computer follow them; the ones already there are left as they are.
// Nothing is removed from where they came from. Returns how many were added.
export function importProjects(list) {
  const fresh = list.filter(p => !getProject(p.id));
  projects.push(...fresh.map(p => {
    const c = JSON.parse(JSON.stringify(p));
    return { ...c, color: c.color || nextColor(), folders: Array.isArray(c.folders) ? c.folders.filter(f => f?.path) : [], links: Array.isArray(c.links) ? c.links.filter(l => l?.id && l.url) : [] };
  }));
  if (fresh.length) save();
  return fresh.length;
}

// =====================================================================
// Account: the projects kept in the user's account (Supabase)
// =====================================================================
//
// Each project is a row of the `projects` table and each link a row of `links` (see
// supabase/schema.sql): { id, position (its order), data (its other fields) }, links also with their
// project_id. `rows` has them as they are known here: the account's, plus the changes made here.
// A change is found by comparing the projects with `rows` (so every function above just calls
// save()), and is written right away; until it is, it waits in `outbox`, kept on this device with
// the rows, so the changes made offline are written when the network comes back. Changes made
// elsewhere come in live (Realtime) and the projects are built again from the rows; a change made
// here and not written yet wins over them. Everything is read again whenever the live channel
// (re)connects, which brings in what was missed while offline.

const TABLES = ['projects', 'links'];

let account = null;          // the signed-in user whose projects these are, or null
let rows = emptyRows();
let outbox = new Map();      // "table:id" -> { table, id, row } (row null: deleted)
let channel = null;
let status = null;           // null (signed out), 'syncing', 'synced' or 'offline'
let flushing = null, retry = null, delay = 0;
const echoes = new Map();    // "table:id" -> rows written from here lately (their echo is ignored)
const listeners = new Set();
const statusListeners = new Set();

function emptyRows() { return { projects: new Map(), links: new Map() }; }

// JSON with the keys of every object sorted, to compare rows (the database reorders their keys).
const canon = v => JSON.stringify(v ?? null, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const clone = v => JSON.parse(JSON.stringify(v ?? {}));
const byPosition = (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1);

// `fn({ removed })` runs after the projects changed elsewhere, or were read again from the account
// (signing in or out); `removed` has the ids of the projects that were deleted in the account.
export const onProjectsChange = fn => listeners.add(fn);
export const syncStatus = () => status;
export const onSyncStatus = fn => statusListeners.add(fn);

function setStatus(s) {
  if (s === status) return;
  status = s;
  statusListeners.forEach(fn => fn(s));
}

let told = null; // projects deleted elsewhere, told at once when a burst of changes is over
function tell(removed = []) {
  if (!told) {
    told = new Set();
    setTimeout(() => {
      const ids = [...told];
      told = null;
      listeners.forEach(fn => fn({ removed: ids }));
    }, 30);
  }
  removed.forEach(id => told.add(id));
}

function rowsOf(list) {
  const out = emptyRows();
  list.forEach((p, i) => {
    const { id, links = [], ...data } = p;
    out.projects.set(id, { id, position: i, data: clone(data) });
    links.forEach((l, j) => {
      const { id: lid, ...ld } = l;
      out.links.set(lid, { id: lid, project_id: id, position: j, data: clone(ld) });
    });
  });
  return out;
}

// The projects from the rows. The project objects are kept (updated in place), so the ones the UI
// holds stay current. Links whose project is gone are left out (and deleted by the next write).
function build() {
  const old = new Map(projects.map(p => [p.id, p]));
  const linksOf = new Map();
  for (const l of [...rows.links.values()].sort(byPosition)) {
    if (!linksOf.has(l.project_id)) linksOf.set(l.project_id, []);
    linksOf.get(l.project_id).push({ ...clone(l.data), id: l.id });
  }
  projects = [...rows.projects.values()].sort(byPosition).map(r => {
    const p = old.get(r.id) || {};
    for (const k of Object.keys(p)) delete p[k];
    return Object.assign(p, { name: '', color: COLORS[0], folders: [] }, clone(r.data), { id: r.id, links: linksOf.get(r.id) || [] });
  });
}

const fromDb = (table, r) => ({
  id: r.id, position: r.position, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data || {},
  ...(table === 'links' ? { project_id: r.project_id } : {}),
});

// Kept on this device, so the projects show up at once next time, and offline.
function keep() {
  if (!account) return;
  store(`account.${account.id}`, {
    rows: Object.fromEntries(TABLES.map(t => [t, [...rows[t].values()]])),
    outbox: [...outbox.values()],
  });
}

// A change made here: what differs from the rows goes to the outbox, and is written.
function write() {
  const next = rowsOf(projects);
  for (const t of TABLES) {
    for (const [id, row] of next[t]) if (canon(row) !== canon(rows[t].get(id))) outbox.set(`${t}:${id}`, { table: t, id, row });
    for (const id of rows[t].keys()) if (!next[t].has(id)) outbox.set(`${t}:${id}`, { table: t, id, row: null });
  }
  rows = next;
  keep();
  flush();
}

function echo(key, row) {
  if (!echoes.has(key)) echoes.set(key, new Set());
  const c = canon(row);
  echoes.get(key).add(c);
  setTimeout(() => { echoes.get(key)?.delete(c); if (!echoes.get(key)?.size) echoes.delete(key); }, 15000);
}

const check = r => { if (r.error) throw r.error; };

// Writes the outbox: one request per table for the rows written, one for the ones deleted.
function flush() {
  if (flushing || !account || !outbox.size) return flushing;
  const user = account;
  flushing = (async () => {
    const batch = [...outbox.entries()];
    const of = (t, written) => batch.map(([, o]) => o).filter(o => o.table === t && !!o.row === written);
    setStatus('syncing');
    try {
      for (const t of TABLES) {
        const up = of(t, true).map(o => o.row);
        if (up.length) check(await db.from(t).upsert(up));
      }
      for (const t of [...TABLES].reverse()) {
        const ids = of(t, false).map(o => o.id);
        if (ids.length) check(await db.from(t).delete().in('id', ids));
      }
    } catch (e) {
      // offline, or the account refused it: tried again a little later, or when the network is back
      console.warn('Could not write the projects to the account', e);
      if (account !== user) return;
      delay = Math.min(60000, delay ? delay * 2 : 2000);
      clearTimeout(retry);
      retry = setTimeout(flush, delay);
      setStatus('offline');
      return;
    } finally {
      flushing = null;
    }
    if (account !== user) return;
    for (const [key, o] of batch) {
      if (o.row) echo(key, o.row);
      if (outbox.get(key) === o) outbox.delete(key);
    }
    delay = 0;
    keep();
    if (outbox.size) flush();
    else setStatus('synced');
  })();
  return flushing;
}

// A change that came from elsewhere (or the echo of one made here).
function remote(table, { eventType, new: row, old }) {
  const id = (eventType === 'DELETE' ? old : row)?.id;
  if (!account || !id) return;
  const key = `${table}:${id}`;
  if (outbox.has(key)) return; // changed here too: this device's change is on its way, and wins
  if (eventType === 'DELETE') {
    if (!rows[table].delete(id)) return;
  } else {
    const r = fromDb(table, row), c = canon(r);
    if (c === canon(rows[table].get(id)) || echoes.get(key)?.has(c)) return;
    rows[table].set(id, r);
  }
  build();
  keep();
  tell(table === 'projects' && eventType === 'DELETE' ? [id] : []);
}

// Reads every row of the account again; the changes not written yet stay on top of them.
async function resync() {
  const user = account;
  if (!user) return;
  setStatus('syncing');
  const [ps, ls] = await Promise.all([
    db.from('projects').select('id, position, data'),
    db.from('links').select('id, project_id, position, data'),
  ]).catch(e => [{ error: e }, {}]);
  if (account !== user) return;
  if (ps.error || ls.error) {
    console.warn('Could not read the projects of the account', ps.error || ls.error);
    return setStatus('offline');
  }
  const next = emptyRows();
  ps.data.forEach(r => next.projects.set(r.id, fromDb('projects', r)));
  ls.data.forEach(r => next.links.set(r.id, fromDb('links', r)));
  for (const o of outbox.values()) {
    if (o.row) next[o.table].set(o.id, o.row);
    else next[o.table].delete(o.id);
  }
  const removed = [...rows.projects.keys()].filter(id => !next.projects.has(id));
  const same = TABLES.every(t => rows[t].size === next[t].size && [...next[t]].every(([id, r]) => canon(r) === canon(rows[t].get(id))));
  rows = next;
  if (!same) build();
  keep();
  if (!same) tell(removed);
  if (outbox.size) flush();
  else setStatus('synced');
}

// Shows the projects of the account of `user` (signed in), or the ones kept on this device (null).
export function useAccount(user) {
  if (channel) { db.removeChannel(channel); channel = null; }
  clearTimeout(retry);
  account = user && db ? user : null;
  outbox = new Map();
  rows = emptyRows();
  echoes.clear();
  delay = 0;
  if (!account) {
    projects = localProjects();
    setStatus(null);
    tell();
    return;
  }
  const cache = store(`account.${account.id}`) || {};
  for (const t of TABLES) (cache.rows?.[t] || []).forEach(r => rows[t].set(r.id, r));
  (cache.outbox || []).forEach(o => outbox.set(`${o.table}:${o.id}`, o));
  projects = []; // (the objects of this device's projects are not reused for the account's)
  build();
  tell();
  setStatus('syncing');
  channel = db.channel(`projects:${account.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, p => remote('projects', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'links' }, p => remote('links', p))
    .subscribe(s => {
      // (re)connected: what changed meanwhile is read, and what changed here is written
      if (s === 'SUBSCRIBED') resync();
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
    });
}

addEventListener('online', () => { if (account) { delay = 0; flush(); resync(); } });
