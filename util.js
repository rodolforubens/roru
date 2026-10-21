import { invoke } from './platform.js?v=7fcf47a';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

const dateFmt = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

export function fmtDate(unix) {
  return dateFmt.format(new Date(unix * 1000));
}

export function fmtRelative(unix) {
  const diff = unix - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(unix);
}

export function fmtSize(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let n = +bytes, u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return u ? `${n.toFixed(n < 10 ? 1 : 0)} ${units[u]}` : `${n} bytes`;
}

// "C:\a\b\" -> "C:/a/b", like the paths git gives (a drive root keeps its slash).
export function normPath(p) {
  p = p.replace(/\\/g, '/');
  return /^[A-Za-z]:\/$/.test(p) ? p : p.replace(/\/+$/, '');
}

export const folderName = path => path.split('/').filter(Boolean).pop() || path;

export const plural = (n, word, words = word + 's') => `${n} ${n === 1 ? word : words}`;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('roru.' + key));
    localStorage.setItem('roru.' + key, JSON.stringify(value));
  } catch { return null; }
}

export const icons = {
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.7-1.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  fetch: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  pull: '<path d="M12 3v14M6 11l6 6 6-6"/><circle cx="12" cy="20.5" r="0.5"/>',
  push: '<path d="M12 21V7M6 13l6-6 6 6"/><path d="M5 3h14"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/>',
  stash: '<path d="M4 7h16v4H4zM6 11v8h12v-8M10 15h4"/>',
  pop: '<path d="M4 13h16v6H4zM12 3v7M9 7l3 3 3-3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  changes: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  history: '<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
  home: '<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.5-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M11 8v6M8 11h6"/>',
  merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 7c0 4 5 5 10 5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  submodule: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  lfs: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  text: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  h1: '<path d="M4 6v12M12 6v12M4 12h8M17 10l3-2v10"/>',
  h2: '<path d="M4 6v12M12 6v12M4 12h8M16 10a2.5 2.5 0 0 1 5 .5c0 2-5 4-5 7.5h5"/>',
  h3: '<path d="M4 6v12M12 6v12M4 12h8M16 8.5a2.5 2.5 0 1 1 2.5 3.5 2.5 2.5 0 1 1-2.5 3.5"/>',
  olist: '<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 14.5a1.5 1.5 0 0 1 3 0c0 1-3 2-3 3.5h3"/>',
  todo: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="13" width="7" height="7" rx="1.5"/><path d="M4.8 7.6l1.5 1.5 2.4-2.6M13 7.5h8M13 16.5h8"/>',
  quote: '<path d="M5 6v12M9 8h11M9 12h11M9 16h7"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  peekSide: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M13 4v16"/>',
  peekCenter: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="7.5" y="8" width="9" height="8" rx="1"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  pin: '<path d="M9 4h6M10 4v5l-3 4h10l-3-4V4M12 13v7"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/>',
  board: '<rect x="3" y="4" width="5" height="14" rx="1.5"/><rect x="10" y="4" width="5" height="9" rx="1.5"/><rect x="17" y="4" width="4" height="11" rx="1.5"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>',
  select: '<circle cx="12" cy="12" r="9"/><path d="M8.5 10.5l3.5 3.5 3.5-3.5"/>',
  tags: '<path d="M3 11V4h7l9 9-7 7z"/><circle cx="7" cy="8" r="1.2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  checkbox: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 9"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/>',
  indent: '<path d="M4 5h16M11 10h9M11 14h9M4 19h16M4 9l3 3-3 3"/>',
  outdent: '<path d="M4 5h16M11 10h9M11 14h9M4 19h16M7 9l-3 3 3 3"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
};

export function icon(name, cls = '') {
  // an emoji (the icon of a note or a view) is drawn in the same box, so it takes the size of the
  // icons around it wherever it is
  if (name && !icons[name] && !/^[\w-]+$/.test(name)) {
    return `<svg class="ic ic-emoji ${cls}" viewBox="0 0 24 24"><text x="12" y="13" text-anchor="middle" dominant-baseline="central" font-size="20">${esc(name)}</text></svg>`;
  }
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg>`;
}

// System file icons (Windows shell), fetched once per extension and cached as data URLs.
const iconCache = new Map();

function iconKey(path, dir) {
  if (dir) return 'dir:';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? 'file:' + name.slice(dot).toLowerCase() : 'file:';
}

function loadIcon(key) {
  if (!iconCache.has(key)) {
    const [kind, ext] = key.split(':');
    const p = invoke('file_icon', { name: 'file' + ext, dir: kind === 'dir' })
      .then(({ size, rgba }) => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
        return c.toDataURL();
      })
      .catch(() => '');
    iconCache.set(key, p);
  }
  return iconCache.get(key);
}

// Placeholder for a file's system icon; filled in by the observer below once the icon is loaded.
export function fileIcon(path, dir = false) {
  return `<img class="ficon" data-icon="${esc(iconKey(path, dir))}" alt="">`;
}

function fillIcons(root) {
  const imgs = root.matches?.('img.ficon:not([src])') ? [root] : root.querySelectorAll?.('img.ficon:not([src])') ?? [];
  for (const img of imgs) loadIcon(img.dataset.icon).then(url => { if (url) img.src = url; });
}

new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) fillIcons(n);
}).observe(document.documentElement, { childList: true, subtree: true });

// Groups items into a folder tree by their '/'-separated path: { dirs: Map(name -> node), items: [] }.
export function pathTree(items, pathOf) {
  const root = { dirs: new Map(), items: [] };
  for (const it of items) {
    let node = root;
    for (const part of pathOf(it).split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), items: [] });
      node = node.dirs.get(part);
    }
    node.items.push(it);
  }
  return root;
}

// Renders a path tree: folders first (sorted), then items in their given order. Folders with a single
// subfolder and no items are compacted into one row ("a/b/c"). `dir(name, path, depth, children)` gets
// a function that renders the folder's contents, so collapsed folders can skip it.
export function renderTree(node, render, depth = 0, prefix = '') {
  let html = '';
  for (let [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    while (!child.items.length && child.dirs.size === 1) {
      const [[sub, next]] = child.dirs;
      name += '/' + sub;
      child = next;
    }
    const path = prefix + name;
    html += render.dir(name, path, depth, () => renderTree(child, render, depth + 1, path + '/'));
  }
  for (const it of node.items) html += render.item(it, depth);
  return html;
}

// Orders paths like a folder tree: at each level folders come before files, then by name.
export function treeCompare(a, b) {
  const pa = a.split('/'), pb = b.split('/');
  for (let i = 0; ; i++) {
    const lastA = i === pa.length - 1, lastB = i === pb.length - 1;
    if (lastA !== lastB) return lastA ? 1 : -1;
    const c = pa[i].localeCompare(pb[i]);
    if (c || lastA) return c;
  }
}

// Big photos are made smaller before they are kept (at most `max` pixels on their longest side, as
// JPEG or WebP); GIFs, SVGs and pictures under 1 MB stay as they are. Returns { bytes, ext }.
export async function shrinkImage(file, max = 2560) {
  const ext = ((file.name.match(/\.([a-z0-9]+)$/i)?.[1] || file.type.split('/')[1] || 'png').toLowerCase()).replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const original = async () => ({ bytes: new Uint8Array(await file.arrayBuffer()), ext });
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_000_000) return original();
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return original(); }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise(done => canvas.toBlob(done, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', 0.85));
  if (!blob || blob.size >= file.size) return original();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png' };
}
