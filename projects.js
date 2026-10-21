// Projects group folders (Git repositories or not). Each project is also a space with its own tabs
// (see app.js) and a dashboard (see dashboard.js). This module owns how projects are stored, so the
// UI doesn't depend on it: signed out, they are kept on this device; signed in (see account.js),
// they are kept in the account, where every change is written right away and the changes made
// elsewhere (the web page, another computer) come in live (see "Account" below). The ones kept on
// this device are never changed by the account: they go there only as copies (importProjects).
// Folders are local paths like "C:/Projects/api" ({ path }), the same keys the tabs use.
import { store } from './util.js?v=69a6653';
import { db } from './account.js?v=69a6653';
import { createMirror, clone } from './mirror.js?v=69a6653';

export const COLORS = ['#7aa2f7', '#9ece6a', '#f7768e', '#e0af68', '#bb9af7', '#2ac3de', '#ff9e64', '#73daca'];

// The projects kept on this device (shown signed out).
export const localProjects = () => (store('projects') || []).filter(p => p?.id);

let projects = localProjects();
const save = () => (mirror.active ? mirror.write() : store('projects', projects));

const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

// Archived projects (`archived`: when) are kept with everything they had, but left out of the rail
// and of everything else: only archivedProjects() and the functions that restore or delete them see
// them. getProject() is null for them, like for a project that isn't there.
const find = id => projects.find(p => p.id === id) || null;
export const listProjects = () => projects.filter(p => !p.archived);
export const getProject = id => { const p = find(id); return p && !p.archived ? p : null; };
export const hasProject = id => !!find(id);
export const allProjects = () => projects;

// Most recently archived first.
export const archivedProjects = () => projects.filter(p => p.archived).sort((a, b) => b.archived - a.archived);

export function archiveProject(id) {
  const p = getProject(id);
  if (!p) return;
  p.archived = Date.now();
  save();
}

export function restoreProject(id) {
  const p = find(id);
  if (!p?.archived) return;
  delete p.archived;
  save();
}

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
  const fresh = list.filter(p => !find(p.id));
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
// project_id. mirror.js keeps them live; every function above just calls save().

const listeners = new Set();

// `fn({ removed })` runs after the projects changed elsewhere, or were read again from the account
// (signing in or out); `removed` has the ids of the projects that were deleted in the account.
export const onProjectsChange = fn => listeners.add(fn);

const byPosition = (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1);

function rowsOf(list) {
  const out = { projects: new Map(), links: new Map() };
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
function build(rows) {
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

const mirror = createMirror({
  name: 'account', label: 'projects',
  tables: { projects: 'id, position, data', links: 'id, project_id, position, data' },
  rowsOf: () => rowsOf(projects),
  build,
  changed: ({ removed }) => listeners.forEach(fn => fn({ removed: removed.projects || [] })),
});

// Shows the projects of the account of `user` (signed in), or the ones kept on this device (null).
export function useAccount(user) {
  // (the objects of this device's projects are not reused for the account's)
  projects = user && db ? [] : localProjects();
  mirror.use(user);
}
