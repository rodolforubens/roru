// Imports a Notion export ("Markdown & CSV", a .zip) into a space's notes.
// - Pages keep their tree: "Title <id>.md" holds a page and the folder "Title/" its sub-pages and files.
// - A database ("Name <id>_all.csv" with its rows in "Name/") becomes a note whose sub-pages are the
//   rows, with the database's columns as properties (types guessed from the values) and a table
//   view; the CSV of another view of it (e.g. "Kanban <id>.csv") becomes a board view.
// - Images are copied into the notes' files; links between exported pages become mentions.
import * as S from './notes-store.js?v=8382e84';
import { readZip } from './zip.js?v=8382e84';
import { parseMarkdown } from './editor.js?v=8382e84';

const utf8 = new TextDecoder('utf-8');
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

// `buffer`: the .zip (ArrayBuffer). `parent`: the note to import into (null for the top of the space).
// `onProgress(done, total)`. Returns { roots: [note ids], pages, images, missing (images not found) }.
export async function importNotion(buffer, { space, parent = null, onProgress = () => {} }) {
  const files = await collect(buffer);
  const { pages, dbs } = scan(files);
  if (!pages.length && !dbs.length) throw new Error('No Notion pages found: export as "Markdown & CSV" and choose the .zip');
  const result = { roots: [], pages: 0, images: 0, missing: 0 };
  const ids = new Map();   // Notion id -> note id, for links between pages
  const todo = [];         // pages whose content is converted once every note exists

  // Pages and databases live in the folder named after their owner (key + "/").
  const owners = new Map();
  for (const it of [...dbs, ...pages]) if (!owners.has(it.key + '/')) owners.set(it.key + '/', it);
  const ownerOf = dir => { for (let d = dir; d; d = d.slice(0, d.slice(0, -1).lastIndexOf('/') + 1)) if (owners.has(d)) return owners.get(d); return null; };
  const children = new Map(); // item -> [items], null for the top
  for (const it of [...dbs, ...pages]) {
    const owner = ownerOf(it.dir);
    if (!children.has(owner)) children.set(owner, []);
    children.get(owner).push(it);
  }
  // A CSV with no pages of its own that shares rows with a database is another view of it
  // (e.g. a Kanban); the database is the one it shares the most rows with.
  for (const d of dbs) {
    const rows = parseCsv(utf8.decode(await d.file.read()));
    d.header = rows[0] || [];
    d.rows = rows.slice(1);
    d.titles = new Set(d.rows.map(r => (r[0] || '').trim()));
  }
  const real = dbs.filter(d => children.get(d)?.length);
  const views = [];
  for (const d of dbs.filter(x => !real.includes(x))) {
    const shared = db => [...d.titles].filter(t => db.titles.has(t)).length;
    const target = real.reduce((best, db) => (shared(db) > (best ? shared(best) : 0) ? db : best), null);
    if (target) { d.target = target; views.push(d); }
  }
  const total = pages.length + [...files.keys()].filter(p => IMAGE.test(p)).length;
  let done = 0;
  const tick = () => onProgress(++done, total);

  await S.batch(async () => {
    const create = async (it, parentId, props = null) => {
      if (it.csv) return createDatabase(it, parentId);
      const md = it.md ?? utf8.decode(await it.file.read());
      const { title, body, propLines } = splitPage(md, it.base, it.columns);
      const n = S.createNote({ space, parent: parentId, title, props: props ?? it.propsFrom?.(propLines) ?? null });
      if (it.notionId) ids.set(it.notionId, n.id);
      todo.push({ it, id: n.id, body });
      result.pages++;
      tick();
      for (const child of sortItems(children.get(it) || [])) await create(child, n.id);
      return n;
    };

    const createDatabase = async (db, parentId) => {
      const n = S.createNote({ space, parent: parentId, title: db.name, kind: 'database' });
      if (db.notionId) ids.set(db.notionId, n.id);
      result.pages++;
      const header = db.header, data = db.rows;
      const schema = buildSchema(n.id, header.slice(1), data.map(r => r.slice(1)));
      const list = S.getCollection(n.id).views[0];
      const table = S.addView(n.id, 'table', 'Table');
      S.deleteView(n.id, list.id); // the table takes the place of the list a collection starts with
      // the other views of this database
      for (const v of views.filter(x => x.target === db)) {
        const vh = v.header.slice(1);
        const kind = /kanban|board|quadro/i.test(v.name) ? 'board' : 'table';
        const view = S.addView(n.id, kind, v.name);
        const groupBy = kind === 'board' ? (schema.find(p => p.type === 'select' && /status|estado|stage|fase/i.test(p.name)) || schema.find(p => p.type === 'select')) : null;
        const hidden = schema.filter(p => p !== groupBy && !vh.includes(p.name)).map(p => p.id);
        S.updateView(n.id, view.id, { groupBy: groupBy?.id ?? null, hidden: hidden.length ? hidden : null });
      }
      S.setActiveView(n.id, table.id);
      // rows: in the CSV's order, each with its page (matched by title); pages without a row go last
      const rowPages = sortItems(children.get(db) || []);
      const used = new Set();
      const valuesOf = row => Object.fromEntries(schema.map((p, i) => [p.id, convert(n.id, p, row[i + 1] ?? '')]).filter(([, v]) => v != null));
      for (const row of data) {
        // a title of several lines: its page's title is the first one
        const [title, ...more] = (row[0] || '').trim().split('\n');
        const first = title.trim();
        const page = rowPages.find(p => !used.has(p) && p.title === first)
          || rowPages.find(p => !used.has(p) && p.base.trim() && first.startsWith(p.base.trim()));
        if (page) {
          used.add(page);
          page.columns = header;
          await create(page, n.id, valuesOf(row));
        } else {
          const note = S.createNote({ space, parent: n.id, title: first, props: valuesOf(row) });
          if (more.join('').trim()) todo.push({ it: { dir: db.key + '/' }, id: note.id, body: more.join('\n').trim() });
          result.pages++;
        }
      }
      for (const page of rowPages.filter(p => !used.has(p))) {
        page.columns = header;
        page.propsFrom = lines => Object.fromEntries(schema.map(p => [p.id, convert(n.id, p, lines[p.name] ?? '')]).filter(([, v]) => v != null));
        await create(page, n.id);
      }
      return n;
    };

    // titles first (the first line of each page is its full title; file names are cut)
    for (const p of pages) { p.md = utf8.decode(await p.file.read()); p.title = titleOf(p.md, p.base); }

    for (const it of sortItems((children.get(null) || []).filter(it => !views.includes(it)))) {
      result.roots.push((await create(it, parent)).id);
    }

    // contents: Markdown to the editor's document, with images copied and links made mentions
    for (const { it, id, body } of todo) {
      let doc;
      try {
        doc = parseMarkdown(prepare(body));
      } catch {
        doc = { type: 'doc', content: body.split(/\n{2,}/).filter(Boolean).map(t => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) };
      }
      linkMentions(doc, ids);
      databaseBlocks(doc);
      await copyImages(doc, it.dir, id, files, result, tick);
      if (doc.content?.length) S.saveContent(id, doc);
    }
  });
  S.flushNotes();
  return result;
}

// ---------- the archive ----------

// Every file of the export by path; archives inside it (big exports come in parts) are opened too.
async function collect(buffer, files = new Map()) {
  const zip = readZip(buffer);
  for (const e of zip.entries) {
    if (/\.zip$/i.test(e.name)) await collect((await zip.read(e)).slice().buffer, files);
    else files.set(e.name, { read: () => zip.read(e) });
  }
  return files;
}

function scan(files) {
  const pages = [], byKey = new Map();
  for (const [path, file] of files) {
    const cut = path.lastIndexOf('/') + 1, dir = path.slice(0, cut), name = path.slice(cut);
    let m = name.match(/^(.*?)(?:\s([0-9a-f]{32}))?\.md$/i);
    if (m) {
      pages.push({ path, dir, base: m[1], key: dir + m[1], notionId: m[2]?.toLowerCase() || null, file });
      continue;
    }
    m = name.match(/^(.*?)(?:\s([0-9a-f]{32}))?(_all)?\.csv$/i);
    if (m) {
      // a database's "_all" CSV has every row; the other one only its default view's
      const key = dir + m[1], cur = byKey.get(key);
      if (!cur || m[3]) byKey.set(key, { csv: true, dir, base: m[1], name: m[1], key, notionId: m[2]?.toLowerCase() || null, file });
    }
  }
  return { pages, dbs: [...byKey.values()] };
}

const sortItems = items => [...items].sort((a, b) => (a.title || a.base).localeCompare(b.title || b.base, undefined, { numeric: true, sensitivity: 'base' }));

// ---------- pages ----------

const titleOf = (md, fallback) => md.replace(/^﻿/, '').match(/^#\s+(.+)\s*$/m)?.[1]?.trim() || fallback;

// The title line, the database properties ("Status: Done") and the rest. The properties come right
// below the title, or below the rest of a title that has several lines (which stays in the text).
function splitPage(md, fallback, columns = null) {
  const lines = md.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  let i = 0, title = fallback;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = lines[i]?.match(/^#\s+(.+)$/);
  if (m) { title = m[1].trim(); i++; }
  while (i < lines.length && !lines[i].trim()) i++;
  const propLines = {};
  let start = i, end = i;
  if (columns) {
    const prop = l => { const p = l.match(/^([^:\n]{1,100}):\s?(.*)$/); return p && columns.includes(p[1]) ? p : null; };
    for (let k = i; k < Math.min(lines.length, i + 40); k++) {
      if (!prop(lines[k]) || (k > i && lines[k - 1].trim())) continue;
      for (end = k; end < lines.length && prop(lines[end]); end++) { const p = prop(lines[end]); propLines[p[1]] = p[2]; }
      start = k;
      break;
    }
  }
  return { title, propLines, body: [...lines.slice(i, start), ...lines.slice(end)].join('\n').trim() };
}

// Notion's HTML bits that Markdown has no block for: callouts become quotes, toggles bold lines.
function prepare(md) {
  return md
    .replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_, inner) => inner.split('\n').map(l => '> ' + l).join('\n'))
    .replace(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g, (_, s, inner) => `**${s.trim()}**\n\n${inner.trim()}`);
}

// The last Notion id in a link (https://app.notion.com/p/Title-<id>?pvs=21, or "Title%20<id>.md").
const notionIdOf = href => {
  try { href = decodeURIComponent(href); } catch { /* keep it */ }
  return [...href.matchAll(/([0-9a-f]{32})(?![0-9a-f])/gi)].pop()?.[1].toLowerCase() || null;
};

// A paragraph holding only a mention of a database (Notion's link to it) becomes its block.
function databaseBlocks(doc) {
  doc.content = (doc.content || []).map(b => {
    const only = b.type === 'paragraph' && b.content?.filter(c => !(c.type === 'text' && !c.text.trim()));
    const m = only?.length === 1 && only[0].type === 'mention' && only[0].attrs;
    return m && S.isDatabase(m.id) ? { type: 'database', attrs: { id: m.id } } : b;
  });
}

// Links to imported pages become mentions of their notes.
function linkMentions(node, ids) {
  if (!node.content) return;
  let last = null;
  node.content = node.content.flatMap(child => {
    const link = child.type === 'text' && child.marks?.find(m => m.type === 'link');
    const target = link && ids.get(notionIdOf(link.attrs?.href || ''));
    if (target) {
      // one mention for the pieces of the same link (e.g. part of it in bold)
      if (last === link.attrs.href) return [];
      last = link.attrs.href;
      return [{ type: 'mention', attrs: { id: target, kind: 'note', label: '' } }];
    }
    last = null;
    linkMentions(child, ids);
    return [child];
  });
}

// Images of the export are copied into the note's files; their path is relative to the page.
async function copyImages(doc, dir, id, files, result, tick) {
  const images = [];
  const walk = n => { if (n.type === 'image') images.push(n); n.content?.forEach(walk); };
  walk(doc);
  const names = new Set();
  for (const img of images) {
    const src = img.attrs?.src || '';
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
    let path;
    try { path = resolvePath(dir, decodeURIComponent(src)); } catch { path = resolvePath(dir, src); }
    const file = files.get(path);
    if (!file) { result.missing++; continue; }
    let name = path.slice(path.lastIndexOf('/') + 1).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-'), k = 2;
    const dot = name.lastIndexOf('.');
    while (names.has(name.toLowerCase())) name = `${path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'))} (${k++})${dot > 0 ? name.slice(dot) : ''}`;
    names.add(name.toLowerCase());
    img.attrs.src = await S.saveFile(id, name, await file.read());
    result.images++;
    tick();
  }
}

function resolvePath(dir, rel) {
  const out = dir.split('/').filter(Boolean);
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

// ---------- databases ----------

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// Relations come as "Title (link)": only the titles are kept.
const stripLinks = v => v.replace(/\s*\((?:https?:\/\/[^)]*|[^()]*\.(?:md|csv))\)/gi, '').trim();

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

// "October 17, 2026", "17 de outubro de 2026", "2026/10/17", "10/17/2026" (a range keeps its start).
function parseDate(v) {
  const s = v.split('→')[0].trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return ymd(m[1], +m[2], +m[3]);
  m = s.match(/^([A-Za-zÀ-ú]+)\.? (\d{1,2}),? (\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return ymd(m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/^(\d{1,2}) de ([A-Za-zÀ-ú]+)\.? de (\d{4})/i);
  if (m && MONTHS[m[2].toLowerCase()]) return ymd(m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return ymd(m[3], +m[1], +m[2]);
  return null;
}

const toNumber = v => {
  const s = v.replace(/[\s%$€£R]/g, '');
  return /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) ? Number(s.replace(/,/g, '')) : null;
};

// The type of a column, from its values.
function guessType(values) {
  const vals = values.map(v => v.trim()).filter(Boolean);
  if (!vals.length) return 'text';
  if (vals.every(v => /^(yes|no|sim|não|nao|true|false)$/i.test(v))) return 'checkbox';
  if (vals.every(v => toNumber(v) != null)) return 'number';
  if (vals.every(v => parseDate(v))) return 'date';
  if (vals.every(v => /^https?:\/\/\S+$/.test(v))) return 'url';
  if (vals.some(v => stripLinks(v) !== v)) return 'text'; // relations
  const short = vals.every(v => v.length <= 60 && !v.includes('\n'));
  const distinct = list => new Set(list).size;
  if (short && distinct(vals) <= Math.max(12, vals.length * 0.3)) {
    const parts = vals.flatMap(v => v.split(/,\s*/));
    return vals.some(v => v.includes(', ')) && distinct(parts) < distinct(vals) ? 'multi' : 'select';
  }
  return 'text';
}

// Status-like options get Notion's usual order and colors.
const STAGES = [/not started|to ?do|backlog|a fazer|n[ãa]o iniciad/i, /next|planned|planejad|future|futur/i, /progress|doing|andamento|fazendo/i,
  /review|test|revis/i, /done|complete|conclu|feito|pronto/i, /archiv|arquiv|cancel/i];
const STAGE_COLORS = ['gray', 'yellow', 'blue', 'purple', 'green', 'brown'];
const stageOf = name => STAGES.findIndex(r => r.test(name));

function buildSchema(key, columns, rows) {
  return columns.map((name, i) => {
    const values = rows.map(r => r[i] ?? '');
    const type = guessType(values);
    const p = S.addProperty(key, { name, type });
    if (type === 'select' || type === 'multi') {
      const seen = [];
      for (const v of values) for (const part of (type === 'multi' ? v.split(/,\s*/) : [v])) if (part.trim() && !seen.includes(part.trim())) seen.push(part.trim());
      const staged = /status|estado|stage|fase/i.test(name) && seen.some(s => stageOf(s) >= 0);
      if (staged) seen.sort((a, b) => (stageOf(a) + 1 || 99) - (stageOf(b) + 1 || 99));
      for (const o of seen) S.addOption(key, p.id, o, stageOf(o) >= 0 ? STAGE_COLORS[stageOf(o)] : null);
    }
    return S.getCollection(key).schema.find(x => x.id === p.id);
  });
}

function convert(key, p, raw) {
  const v = String(raw).trim();
  if (!v) return null;
  switch (p.type) {
    case 'checkbox': return /^(yes|sim|true)$/i.test(v) || null;
    case 'number': return toNumber(v);
    case 'date': return parseDate(v);
    case 'url': return v;
    case 'select': return p.options.find(o => o.name === v)?.id ?? S.addOption(key, p.id, v)?.id ?? null;
    case 'multi': return v.split(/,\s*/).map(s => s.trim()).filter(Boolean).map(s => p.options.find(o => o.name === s)?.id ?? S.addOption(key, p.id, s)?.id).filter(Boolean);
    default: return stripLinks(v) || null;
  }
}
