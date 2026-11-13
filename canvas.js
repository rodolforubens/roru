// The Canvas view of a database: an endless space, moved and zoomed, where its items are cards put
// anywhere. An item can be on it several times (copies: they all point at the same item, so renaming
// one renames them all), each copy with a look of its own: a picture in a thin frame (the item's
// first picture), a sticky note, a rectangle with the name in the middle, an ellipse, a diamond or
// plain text. Arrows link the cards, and texts and shapes can live on the canvas only (no note behind
// them); they are converted to items and back.
//
// It is all kept in the view ({ type: 'canvas', look, nodes, edges, off }: see notes-store.js), so it
// is written with the database like the other views. Items come onto the canvas by themselves (in a
// free spot below what is there) unless they were hidden from it (`off`); removing an item's last
// copy hides it. Where the canvas is looked at (moved and zoomed) is kept on this device only.
import * as S from './notes-store.js?v=e5ab480';
import { esc, icon, store, glider } from './util.js?v=e5ab480';

const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
const clone = v => JSON.parse(JSON.stringify(v ?? null));

export const SHAPES = {
  box: 'Rectangle', sticky: 'Sticky note', image: 'Image', ellipse: 'Ellipse', diamond: 'Diamond', text: 'Text',
};
// the looks the items that come by themselves can have
export const LOOKS = ['box', 'sticky', 'image'];
const SIZES = { box: [200, 80], sticky: [180, 180], image: [220, 180], ellipse: [180, 100], diamond: [180, 120], text: [220, 36] };
const COLORS = { gray: 'Gray', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red' };
const MIN_Z = 0.1, MAX_Z = 4, GRID = 24;
const clampZ = z => Math.min(MAX_Z, Math.max(MIN_Z, z));
const sizeOf = n => [n.w || SIZES[n.shape]?.[0] || 200, n.h || SIZES[n.shape]?.[1] || 80];
const titleOf = (n, item) => (item ? item.title || 'Untitled' : n.text || '');

// A hue from the title, for pictures that aren't there (like the notes' cards).
const hueOf = text => [...(text || 'x')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

// The pictures and the start of the text of the items (from host.preview), the addresses of the
// pictures once known, so drawing the canvas again doesn't make them blink, and their shapes.
const previews = new Map(); // item id -> { updated, cover, text }
const urls = new Map();     // "files/…" -> address
const ratios = new Map();   // "files/…" -> width / height

// An image node `w` wide whose picture is `ratio` (width / height): its height. Around the picture
// are the node's border and padding (6px on each side, 6px on top), and below it the caption
// (28px) or, with no title, 6px more.
const IMAGE_CHROME = { x: 12, titled: 35, untitled: 12 };
const imageHeight = (w, ratio, titled) => Math.round((w - IMAGE_CHROME.x) / ratio + (titled ? IMAGE_CHROME.titled : IMAGE_CHROME.untitled));

// The shape of a picture of the notes (or of a pasted file), or null.
async function ratioOfSrc(src) {
  if (!src) return null;
  if (ratios.has(src)) return ratios.get(src);
  try {
    const url = urls.get(src) || (await S.fileUrl(src));
    if (!url) return null;
    urls.set(src, url);
    const img = new Image();
    img.src = url;
    await img.decode();
    const r = img.naturalWidth / (img.naturalHeight || 1) || null;
    if (r) ratios.set(src, r);
    return r;
  } catch {
    return null;
  }
}
async function ratioOfFile(file) {
  try {
    const bmp = await createImageBitmap(file);
    const r = bmp.width / (bmp.height || 1);
    bmp.close();
    return r || 1;
  } catch {
    return 4 / 3;
  }
}

// Where each canvas was looked at, on this device.
const camOf = id => store('canvasCamera')?.[id] || null;
const saveCams = new Map();
function saveCam(id, cam) {
  clearTimeout(saveCams.get(id));
  saveCams.set(id, setTimeout(() => store('canvasCamera', { ...store('canvasCamera'), [id]: cam }), 400));
}

// A canvas in a page's text takes the wheel (and two fingers) only once it was clicked; a click
// elsewhere lets it go again.
let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  addEventListener('pointerdown', e => {
    for (const r of document.querySelectorAll('.cvs.active')) {
      if (r.contains(e.target)) continue;
      r.classList.remove('active');
      if (r._cv) r._cv.active = false;
    }
  }, true);
  addEventListener('keyup', e => {
    if (e.key !== ' ') return;
    for (const r of document.querySelectorAll('.cvs.panning')) { r.classList.remove('panning'); if (r._cv) r._cv.space = false; }
  });
  addEventListener('blur', () => {
    for (const r of document.querySelectorAll('.cvs.panning')) { r.classList.remove('panning'); if (r._cv) r._cv.space = false; }
  });
}

function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

// The canvas's state while it is shown (kept by the collection, `c.canvas`, across drawings).
function stateOf(c, view) {
  if (c.canvas?.view !== view.id) {
    c.canvas?.ro?.disconnect();
    c.canvas?.glide?.stop();
    c.canvas = { view: view.id, cam: camOf(view.id), sel: new Set(), edge: null, undo: [], redo: [], busy: false, active: false, tap: null, cycle: {}, trayQ: '', fresh: null, drop: 0 };
  }
  return c.canvas;
}

// The canvas's view menu entries (see viewMenu in views.js).
export function canvasMenuItems(c, key, view, host) {
  const api = c.canvas?.view === view.id ? c.canvas.api : null;
  const look = view.look || 'box';
  return [
    { label: 'New items look like…', run: r => host.showMenu(r.right + 2, r.top, LOOKS.map(s => ({ label: `${SHAPES[s]}${look === s ? '  ✓' : ''}`, run: () => S.updateView(key, view.id, { look: s }) }))) },
    { label: `Snap to the grid${view.snap ? '  ✓' : ''}`, run: () => S.updateView(key, view.id, { snap: view.snap ? null : true }) },
    ...(api ? [
      { label: 'Fit to content', run: () => api.fit({ smooth: true }) },
      { label: store('canvasTray') ? 'Hide the items tray' : 'Show the items tray', run: () => api.toggleTray() },
    ] : []),
  ];
}

// The "New" of the view's bar: an item in the middle of the canvas.
export const canvasNew = c => c.canvas?.api?.newItem();

// `opts`: { key (the database), view, items (the database's items, in order), host, repaint(), focus }.
export function mountCanvas(body, c, { key, view, items, host, repaint, focus = false }) {
  bindOnce();
  const cv = stateOf(c, view);
  const viewId = view.id;
  const V = () => S.getCollection(key).views.find(v => v.id === viewId) || view;
  const allNodes = () => V().nodes || [];
  const allEdges = () => V().edges || [];
  const offList = () => V().off || [];

  // what is drawn: the copies of the items that are in the database now (the others wait, for when
  // an item comes back from the trash), and the canvas's own elements
  const byId = new Map(items.map(n => [n.id, n]));
  const nodes = allNodes().filter(n => !n.note || byId.has(n.note));
  const copies = new Map();
  for (const n of nodes) if (n.note) copies.set(n.note, (copies.get(n.note) || 0) + 1);
  const drawn = new Set(nodes.map(n => n.id));
  const edges = allEdges().filter(e => drawn.has(e.from) && drawn.has(e.to));
  cv.sel = new Set([...cv.sel].filter(id => drawn.has(id)));
  if (cv.edge && !edges.some(e => e.id === cv.edge)) cv.edge = null;
  const off = new Set(offList());
  const missing = items.filter(n => !copies.has(n.id) && !off.has(n.id));
  const hidden = items.filter(n => !copies.has(n.id)).length - missing.length;
  const tray = !!store('canvasTray');
  // with the grid on, nodes go to its lines (positions and sizes)
  const snapOn = () => !!V().snap;
  const snap = v => (snapOn() ? Math.round(v / GRID) * GRID : Math.round(v));
  const snapSize = v => (snapOn() ? Math.max(GRID, Math.round(v / GRID) * GRID) : Math.round(v));

  body.innerHTML = `<div class="cvs cvs-${c.ctx === 'page' ? 'page' : 'inline'} ${cv.active ? 'active' : ''} ${tray ? 'tray-open' : ''}" tabindex="0">
    <div class="cvs-world">
      <svg class="cvs-edges" xmlns="http://www.w3.org/2000/svg"></svg>
      ${nodes.map(n => nodeHtml(n, n.note ? byId.get(n.note) : null, copies.get(n.note))).join('')}
      <div class="cvs-labels"></div>
    </div>
    <svg class="cvs-over" xmlns="http://www.w3.org/2000/svg"></svg>
    <div class="cvs-tools">
      <button class="cvs-tb" data-cvs="new-item" title="New item of the database (or double-click the canvas)">${icon('plus')}<span>Item</span></button>
      <button class="cvs-tb" data-cvs="new-sticky" title="Sticky note (canvas only)">${icon('sticky')}</button>
      <button class="cvs-tb" data-cvs="new-shape" title="Shape (canvas only)">${icon('shape')}</button>
      <button class="cvs-tb" data-cvs="new-text" title="Text (canvas only)">${icon('text')}</button>
      <span class="cvs-sep"></span>
      <button class="cvs-tb ${view.snap ? 'on' : ''}" data-cvs="snap" title="Snap to the grid: cards move and resize along its dots">${icon('magnet')}</button>
      <button class="cvs-tb ${tray ? 'on' : ''}" data-cvs="tray" title="The items: show or hide them, or drag one to add a copy">${icon('list')}<span>Items</span>${hidden ? `<b>${hidden} hidden</b>` : ''}</button>
    </div>
    <div class="cvs-zoom">
      <button class="cvs-tb" data-cvs="zoom-out" title="Zoom out">${icon('minus')}</button>
      <button class="cvs-tb cvs-zv" data-cvs="zoom-reset" title="Back to 100%">100%</button>
      <button class="cvs-tb" data-cvs="zoom-in" title="Zoom in">${icon('plus')}</button>
      <button class="cvs-tb" data-cvs="fit" title="Fit to content">${icon('fit')}</button>
    </div>
    ${tray ? trayHtml() : ''}
  </div>`;

  const root = body.querySelector('.cvs');
  root._cv = cv;
  const world = root.querySelector('.cvs-world');
  const svg = root.querySelector('.cvs-edges');
  const labels = root.querySelector('.cvs-labels');
  const over = root.querySelector('.cvs-over');
  const nodeEl = id => root.querySelector(`.cvs-node[data-node="${CSS.escape(id)}"]`);

  // the size of each node, measured (texts and pictures can be taller than they were made)
  const geo = new Map();
  for (const n of nodes) {
    const el = nodeEl(n.id);
    geo.set(n.id, { x: n.x, y: n.y, w: el.offsetWidth, h: el.offsetHeight, shape: n.shape });
  }

  // ---------- the camera ----------

  const rect = () => root.getBoundingClientRect();
  const toWorld = (cx, cy) => { const r = rect(); return { x: (cx - r.left - cv.cam.x) / cv.cam.z, y: (cy - r.top - cv.cam.y) / cv.cam.z }; };
  const center = () => { const r = rect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };

  function applyCam() {
    const { x, y, z } = cv.cam;
    world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    root.style.setProperty('--iz', String(Math.min(2.5, 1 / z)));
    root.style.backgroundSize = `${GRID * z}px ${GRID * z}px`;
    root.style.backgroundPosition = `${x}px ${y}px`;
    const zv = root.querySelector('.cvs-zv');
    if (zv) zv.textContent = `${Math.round(z * 100)}%`;
    saveCam(viewId, cv.cam);
  }

  // The camera glides to where the zoom buttons, the wheel's notches, Fit or the tray send it
  // (the glide lives on in the canvas's state, drawn by its latest mount); fingers and drags move it
  // at once.
  cv.drawCam = applyCam;
  cv.glide ||= glider(() => cv.cam, cam => { cv.cam = cam; cv.drawCam(); });
  const moveCam = (cam, smooth) => {
    if (smooth) return cv.glide.to(cam);
    cv.glide.stop();
    cv.cam = cam;
    applyCam();
  };
  const panBy = (dx, dy) => {
    cv.cam.x += dx;
    cv.cam.y += dy;
    cv.glide.nudge({ x: dx, y: dy });
    applyCam();
  };
  // the zoom it is going to (while it glides)
  const zoomGoal = () => (cv.glide.goal || cv.cam).z;

  // zooms to `z` keeping the point (sx, sy) of the canvas where it is
  function zoomAt(z, sx, sy, { smooth = false } = {}) {
    z = clampZ(z);
    const wx = (sx - cv.cam.x) / cv.cam.z, wy = (sy - cv.cam.y) / cv.cam.z;
    moveCam({ z, x: sx - wx * z, y: sy - wy * z }, smooth);
  }
  const zoomBy = f => { const r = rect(); zoomAt(zoomGoal() * f, r.width / 2, r.height / 2, { smooth: true }); };

  function bounds(rects, pad = 0) {
    if (!rects.length) return null;
    const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
    const r = Math.max(...rects.map(q => q.x + q.w)), b = Math.max(...rects.map(q => q.y + q.h));
    return { x: x - pad, y: y - pad, w: r - x + pad * 2, h: b - y + pad * 2 };
  }

  // everything in view (at most at 100%), below the tools
  function fit({ smooth = false } = {}) {
    const r = rect();
    if (r.width < 10) return (cv.needFit = true);
    cv.needFit = false;
    const b = bounds([...geo.values()]);
    if (!b) return moveCam({ x: 40, y: 64, z: 1 }, smooth);
    const z = clampZ(Math.min(1, (r.width - 80) / b.w, (r.height - 120) / b.h));
    moveCam({ z, x: (r.width - b.w * z) / 2 - b.x * z, y: 52 + (r.height - 52 - b.h * z) / 2 - b.y * z }, smooth);
  }

  // centers a node, keeping the zoom
  function reveal(id) {
    const g = geo.get(id), r = rect(), z = zoomGoal();
    if (g) moveCam({ z, x: r.width / 2 - (g.x + g.w / 2) * z, y: r.height / 2 - (g.y + g.h / 2) * z }, true);
  }

  // ---------- arrows ----------

  // How far from its center (as a part of dx, dy) a line going that way leaves the node.
  function reach(g, dx, dy) {
    const hw = g.w / 2, hh = g.h / 2, ax = Math.abs(dx) || 1e-9, ay = Math.abs(dy) || 1e-9;
    if (g.shape === 'ellipse') return 1 / Math.hypot(dx / hw, dy / hh);
    if (g.shape === 'diamond') return 1 / (ax / hw + ay / hh);
    return Math.min(hw / ax, hh / ay);
  }

  // The arrow's line, from the border of one node to the border of the other (none when they overlap).
  function line(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ta = reach(a, dx, dy), tb = reach(b, -dx, -dy), gap = 4 / len;
    if (ta + tb + gap * 2 >= 1) return null;
    return { x1: ax + dx * (ta + gap), y1: ay + dy * (ta + gap), x2: bx - dx * (tb + gap), y2: by - dy * (tb + gap), ux: dx / len, uy: dy / len };
  }

  const head = (x, y, ux, uy) => `M${x} ${y}L${x - ux * 11 - uy * 5.5} ${y - uy * 11 + ux * 5.5}L${x - ux * 11 + uy * 5.5} ${y - uy * 11 - ux * 5.5}Z`;

  function drawEdges() {
    const b = bounds([...geo.values()], 200);
    if (!b || !edges.length) { svg.innerHTML = ''; labels.innerHTML = ''; return; }
    Object.assign(svg.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
    svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
    let paths = '', tags = '';
    for (const e of edges) {
      const l = line(geo.get(e.from), geo.get(e.to));
      if (!l) continue;
      const ends = e.ends || 'end', d = `M${l.x1} ${l.y1}L${l.x2} ${l.y2}`;
      paths += `<g class="cvs-edge ${cv.edge === e.id ? 'sel' : ''}" data-edge="${e.id}"><path class="cvs-hit" d="${d}"/><path class="cvs-line" d="${d}"/>`
        + (ends !== 'none' ? `<path class="cvs-head" d="${head(l.x2, l.y2, l.ux, l.uy)}"/>` : '')
        + (ends === 'both' ? `<path class="cvs-head" d="${head(l.x1, l.y1, -l.ux, -l.uy)}"/>` : '') + '</g>';
      if (e.label) tags += `<div class="cvs-elabel ${cv.edge === e.id ? 'sel' : ''}" data-edge="${e.id}" style="left:${(l.x1 + l.x2) / 2}px;top:${(l.y1 + l.y2) / 2}px">${esc(e.label)}</div>`;
    }
    svg.innerHTML = paths;
    labels.innerHTML = tags;
  }

  // ---------- selection ----------

  function paintSel() {
    for (const el of root.querySelectorAll('.cvs-node')) el.classList.toggle('sel', cv.sel.has(el.dataset.node));
    for (const el of root.querySelectorAll('[data-edge]')) el.classList.toggle('sel', cv.edge === el.dataset.edge);
    root.classList.toggle('one', cv.sel.size === 1);
  }
  const select = (ids, edge = null) => { cv.sel = new Set(ids); cv.edge = edge; paintSel(); };

  // ---------- changes ----------

  // Writes the canvas (`next`: { nodes, edges, off }, the ones that change).
  function write(next) {
    const changes = {};
    if (next.nodes) changes.nodes = next.nodes;
    if (next.edges) changes.edges = next.edges.length ? next.edges : null;
    if (next.off) changes.off = next.off.length ? next.off : null;
    S.updateView(key, viewId, changes);
  }
  const snapshot = () => ({ nodes: clone(allNodes()), edges: clone(allEdges()), off: clone(offList()) });

  // A change that Ctrl+Z takes back (`undo`/`redo`: what else it does, like an item it created).
  function commit(next, { undo = null, redo = null } = {}) {
    cv.undo.push({ state: snapshot(), undo, redo });
    if (cv.undo.length > 100) cv.undo.shift();
    cv.redo = [];
    write(next);
  }
  function undoRedo(from, to, how) {
    const h = from.pop();
    if (!h) return;
    to.push({ state: snapshot(), undo: h.undo, redo: h.redo });
    S.batch(() => { h[how]?.(); write(h.state); });
  }

  const withoutNodes = ids => {
    const gone = new Set(ids);
    return { nodes: allNodes().filter(n => !gone.has(n.id)), edges: allEdges().filter(e => !gone.has(e.from) && !gone.has(e.to)) };
  };

  // Takes copies off the canvas (never the items): an item whose last copy goes is hidden.
  function removeNodes(ids) {
    if (!ids.length) return;
    const next = withoutNodes(ids);
    const left = new Set(next.nodes.map(n => n.note).filter(Boolean));
    const gone = allNodes().filter(n => ids.includes(n.id) && n.note && !left.has(n.note)).map(n => n.note);
    cv.sel = new Set();
    commit({ ...next, off: [...new Set([...offList(), ...gone])] });
  }

  function hideItem(itemId) {
    const ids = allNodes().filter(n => n.note === itemId).map(n => n.id);
    cv.sel = new Set([...cv.sel].filter(id => !ids.includes(id)));
    commit({ ...withoutNodes(ids), off: [...new Set([...offList(), itemId])] });
  }

  // Another copy of an item, at `at` (the middle of the canvas by default).
  function addCopy(itemId, at = null) {
    const look = V().look || 'box', [w, h] = SIZES[look];
    const p = at || nextSpot();
    const node = { id: newId(), note: itemId, shape: look, x: snap(p.x - w / 2), y: snap(p.y - h / 2), w, h };
    cv.sel = new Set([node.id]);
    cv.edge = null;
    commit({ nodes: [...allNodes(), node], off: offList().filter(id => id !== itemId) });
    if (look === 'image') fitImages([node.id]);
    return node;
  }

  // Copies of the nodes, a little further (an item's copy points at the same item); the arrows
  // between them come along.
  function duplicate(ids, dx = GRID, dy = GRID) {
    const map = new Map();
    const add = allNodes().filter(n => ids.includes(n.id)).map(n => {
      const id = newId();
      map.set(n.id, id);
      return { ...clone(n), id, x: n.x + dx, y: n.y + dy };
    });
    if (!add.length) return;
    const links = allEdges().filter(e => map.has(e.from) && map.has(e.to)).map(e => ({ ...clone(e), id: newId(), from: map.get(e.from), to: map.get(e.to) }));
    cv.sel = new Set(map.values());
    commit({ nodes: [...allNodes(), ...add], edges: [...allEdges(), ...links] });
  }

  const patchNodes = (ids, fn) => commit({ nodes: allNodes().map(n => (ids.includes(n.id) ? fn({ ...n }) : n)) });

  function setShape(ids, shape) {
    const was = new Map(allNodes().map(n => [n.id, n.shape]));
    patchNodes(ids, n => {
      if (shape === 'image' && !n.note) return n;
      // a node that kept its look's size gets the size of the new one
      const [w0, h0] = SIZES[n.shape] || [], [w, h] = SIZES[shape];
      if ((!n.w || n.w === w0) && (!n.h || n.h === h0)) Object.assign(n, { w, h });
      if (shape === 'sticky' && !n.color && n.shape !== 'sticky') n.color = 'yellow';
      n.shape = shape;
      return n;
    });
    // an item shown as an image takes the shape of its picture
    if (shape === 'image') fitImages(ids.filter(id => was.get(id) !== 'image'));
  }

  // The item's picture and the start of its text.
  async function previewFor(item) {
    const hit = previews.get(item.id);
    if (hit && hit.updated === item.updated) return hit;
    const p = await host.preview(item.id).catch(() => null);
    if (p) previews.set(item.id, p);
    return p;
  }

  // Image nodes take the shape of their picture, keeping their width (`undo`: a change of its own
  // for Ctrl+Z, else part of the change that made them images).
  async function fitImages(ids, { undo = false } = {}) {
    const heights = new Map();
    for (const id of ids) {
      const n = allNodes().find(x => x.id === id), item = n?.note && S.getNote(n.note);
      if (!item || n.shape !== 'image') continue;
      const r = await ratioOfSrc((await previewFor(item))?.cover);
      if (r) heights.set(id, imageHeight(n.w || SIZES.image[0], r, !!item.title));
    }
    if (!heights.size) return;
    const next = { nodes: allNodes().map(n => (heights.has(n.id) ? { ...n, h: heights.get(n.id) } : n)) };
    if (undo) commit(next);
    else write(next);
  }

  // A double click on the resize handle: the node takes the shape of what it shows (an image the
  // shape of its picture, a text the height of its text, the others the shape of their look).
  function fitContent(id) {
    const n = allNodes().find(x => x.id === id);
    if (!n) return;
    if (n.shape === 'image' && n.note) return fitImages([id], { undo: true });
    const [dw, dh] = SIZES[n.shape] || SIZES.box, w = n.w || dw;
    patchNodes([id], x => ({ ...x, h: n.shape === 'text' ? 24 : Math.round((w * dh) / dw) }));
  }

  // Pictures pasted or dropped on the canvas: each one an item of the database with the picture in
  // its page, shown as an image of its shape, side by side from `p`.
  async function addPictures(files, p = nextSpot()) {
    let x = p.x;
    const made = [];
    for (const file of files) {
      const ratio = await ratioOfFile(file);
      const base = (file.name || '').replace(/\.[^.]+$/, '').trim();
      const title = /^(image|img|screenshot|pasted.*|\d*)$/i.test(base) ? '' : base;
      const w = 260, h = imageHeight(w, ratio, !!title);
      const node = { id: newId(), shape: 'image', x: snap(x), y: snap(p.y - h / 2), w, h };
      x += w + GRID;
      let item = null;
      await S.batch(() => {
        item = S.createNote({ space: c.space, parent: c.parent, title });
        node.note = item.id;
        commit({ nodes: [...allNodes(), node] }, { undo: () => S.trashNote(item.id), redo: () => S.restoreNote(item.id) });
      });
      made.push(node.id);
      try {
        const src = await host.addImage(item.id, file);
        ratios.set(src, ratio);
        const p2 = { updated: S.getNote(item.id)?.updated, cover: src, text: '' };
        previews.set(item.id, p2);
        c.canvas?.api?.fill(item.id, p2);
      } catch (e) {
        host.toast('Could not add the image', 'error', String(e.message || e));
      }
    }
    if (made.length) { cv.sel = new Set(made); c.canvas?.api?.paintSel(); }
  }
  const setColor = (ids, color) => patchNodes(ids, n => { if (color) n.color = color; else delete n.color; return n; });

  function toFront(ids, front) {
    const moving = allNodes().filter(n => ids.includes(n.id)), rest = allNodes().filter(n => !ids.includes(n.id));
    commit({ nodes: front ? [...rest, ...moving] : [...moving, ...rest] });
  }

  function addEdge(from, to) {
    if (allEdges().some(e => e.from === from && e.to === to)) return;
    const e = { id: newId(), from, to };
    commit({ edges: [...allEdges(), e] });
    select([], e.id);
  }
  const patchEdge = (id, fn) => commit({ edges: allEdges().map(e => (e.id === id ? fn({ ...e }) : e)) });

  async function editLabel(id) {
    const e = allEdges().find(x => x.id === id);
    if (!e) return;
    const r = await host.modal({ title: 'Arrow label', input: e.label || '', placeholder: 'A few words on the arrow', allowEmpty: true, ok: 'Save' });
    if (r) patchEdge(id, x => { if (r.value) x.label = r.value; else delete x.label; return x; });
  }

  // A free spot near the middle of the canvas, a little further each time.
  function nextSpot() {
    const p = center(), k = cv.drop++ % 6;
    return { x: p.x + k * GRID, y: p.y + k * GRID };
  }

  // A new item of the database at `p`, its title typed right there; `from`: a node it is linked from.
  function newItemAt(p = nextSpot(), { shape = null, from = null } = {}) {
    const look = shape || V().look || 'box', [w, h] = SIZES[look];
    const node = { id: newId(), shape: look, x: snap(p.x - w / 2), y: snap(p.y - h / 2), w, h };
    if (look === 'sticky') node.color = 'yellow';
    let item = null;
    cv.sel = new Set([node.id]);
    cv.edge = null;
    S.batch(() => {
      item = S.createNote({ space: c.space, parent: c.parent });
      node.note = item.id;
      commit({ nodes: [...allNodes(), node], ...(from ? { edges: [...allEdges(), { id: newId(), from, to: node.id }] } : {}) },
        { undo: () => S.trashNote(item.id), redo: () => S.restoreNote(item.id) });
    }).then(() => editLater(node.id));
  }

  // A text or a shape that lives only on the canvas, its text typed right there.
  function newFreeAt(shape, p = nextSpot(), from = null) {
    const [w, h] = SIZES[shape];
    const node = { id: newId(), shape, text: '', x: snap(p.x - w / 2), y: snap(p.y - h / 2), w, h };
    if (shape === 'sticky') node.color = 'yellow';
    cv.sel = new Set([node.id]);
    cv.edge = null;
    cv.fresh = node.id;
    commit({ nodes: [...allNodes(), node], ...(from ? { edges: [...allEdges(), { id: newId(), from, to: node.id }] } : {}) });
    // (drawn again already: what is typed right away goes in it)
    if (!c.canvas?.api?.edit(node.id)) editLater(node.id);
  }

  // (the canvas was drawn again meanwhile: the node is found in the new one)
  const editLater = id => setTimeout(() => c.canvas?.api?.edit(id));

  // A canvas-only element becomes an item of the database, titled with its text.
  function toItem(id) {
    const n = allNodes().find(x => x.id === id);
    if (!n || n.note) return;
    let item = null;
    S.batch(() => {
      item = S.createNote({ space: c.space, parent: c.parent, title: (n.text || '').replace(/\s+/g, ' ').trim() });
      commit({ nodes: allNodes().map(x => (x.id === id ? (({ text, ...rest }) => ({ ...rest, note: item.id }))(x) : x)) },
        { undo: () => S.trashNote(item.id), redo: () => S.restoreNote(item.id) });
    });
    host.toast('It is now an item of the database', 'ok');
  }

  // An item becomes canvas-only (its copies keep their places, with its title as their text); the
  // item goes to the trash, with its properties and its page.
  async function toFree(id) {
    const n = allNodes().find(x => x.id === id), item = n?.note && S.getNote(n.note);
    if (!item) return;
    const others = allNodes().filter(x => x.note === item.id).length - 1;
    const inside = S.descendantsOf(item.id).length;
    const title = item.title || 'Untitled';
    const ok = await host.confirmBox('Convert to a canvas-only element',
      `"${title}" will stay on this canvas as a shape with its title, and the item goes to the trash: its properties`
      + ` and the text of its page${inside ? `, and the ${inside === 1 ? 'page' : `${inside} pages`} inside it` : ''} leave the database.`
      + (others ? ` Its ${others === 1 ? 'other copy' : `${others} other copies`} on the canvas become canvas-only too.` : ''), 'Convert');
    if (!ok) return;
    S.batch(() => {
      commit({ nodes: allNodes().map(x => (x.note === item.id ? (({ note, ...rest }) => ({ ...rest, text: item.title || '' }))(x) : x)), off: offList().filter(x => x !== item.id) },
        { undo: () => S.restoreNote(item.id), redo: () => S.trashNote(item.id) });
      S.trashNote(item.id);
    });
    host.toast(`"${title}" is canvas-only now, and the item is in the trash`, 'ok', '', { label: 'Undo', run: () => c.canvas?.api?.undo() });
  }

  // ---------- typing a title or a text in place ----------

  function edit(id) {
    const el = nodeEl(id), n = allNodes().find(x => x.id === id);
    if (!el || !n) return;
    const item = n.note ? S.getNote(n.note) : null;
    const target = el.querySelector('.cvs-lb, .cvs-st, .cvs-cap');
    if (!target) return;
    const before = item ? item.title : n.text || '';
    const ta = Object.assign(document.createElement('textarea'), { className: 'cvs-edit', value: before, rows: 1, spellcheck: false, placeholder: item ? 'Untitled' : 'Type something' });
    target.replaceWith(ta);
    el.classList.add('editing');
    const fresh = cv.fresh === id;
    cv.fresh = null;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    let done = false;
    // `keys`: it ended with Enter or Escape, so the canvas keeps the keys (not with a click elsewhere)
    const finish = (save, keys = false) => {
      if (done) return;
      done = true;
      const v = item ? ta.value.replace(/\s+/g, ' ').trim() : ta.value.replace(/\s+$/, '');
      ta.blur(); // (drawings wait while it has the focus)
      // a new text left empty goes away
      if (fresh && !v.trim()) {
        cv.undo.pop();
        write(withoutNodes([id]));
      } else if (save && item && v !== before) S.renameNote(item.id, v);
      else if (save && !item && v !== before) patchNodes([id], x => ({ ...x, text: v }));
      else repaint();
      if (keys) c.el.querySelector('.cvs')?.focus({ preventScroll: true });
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (item || !e.shiftKey)) { e.preventDefault(); finish(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
    });
    ta.addEventListener('blur', () => finish(true));
    for (const ev of ['pointerdown', 'click', 'dblclick', 'contextmenu']) ta.addEventListener(ev, e => e.stopPropagation());
    grow();
    ta.focus({ preventScroll: true });
    ta.select();
    return true;
  }

  // ---------- opening ----------

  function openNode(id, e) {
    const n = allNodes().find(x => x.id === id);
    if (n?.note) c.open(n.note, e, 'canvas');
    else edit(id);
  }

  // Two clicks (or taps) on the same thing in a short time.
  function double(what) {
    const now = Date.now(), d = cv.tap && cv.tap.what === what && now - cv.tap.at < 400;
    cv.tap = d ? null : { what, at: now };
    return d;
  }

  // ---------- pointer gestures ----------

  // Follows a press until it ends; `move(ev, dx, dy, tx, ty)` once it moved (drawings wait meanwhile),
  // `up(ev, moved, cancelled)` at the end.
  function track(e, { move = () => {}, up = () => {}, threshold = 3 }) {
    const id = e.pointerId, x0 = e.clientX, y0 = e.clientY;
    let lx = x0, ly = y0, moved = false, over = false;
    const mv = ev => {
      if (ev.pointerId !== id) return;
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return;
      if (!moved) { moved = true; cv.busy = true; }
      move(ev, ev.clientX - lx, ev.clientY - ly, ev.clientX - x0, ev.clientY - y0);
      lx = ev.clientX;
      ly = ev.clientY;
    };
    const end = ev => {
      if (ev.pointerId !== id || over) return;
      over = true;
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      if (cv.gesture?.end === end) cv.gesture = null;
      cv.busy = false;
      up(ev, moved, ev.type === 'pointercancel');
      if (c.dirty) repaint();
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    cv.gesture = { end, cancel: () => end({ pointerId: id, type: 'pointercancel', clientX: lx, clientY: ly }) };
  }

  // Fingers on the canvas (two of them zoom it).
  const touches = cv.touches ||= new Map();
  function trackTouch(e) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size > 1) return;
    const mv = ev => { if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); };
    const up = ev => {
      touches.delete(ev.pointerId);
      if (touches.size) return;
      removeEventListener('pointermove', mv, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
    };
    addEventListener('pointermove', mv, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  }

  function pinch() {
    // (what the first finger was doing stops, and is put back)
    cv.gesture?.cancel();
    cv.busy = true;
    const two = () => [...touches.values()].slice(0, 2);
    let [a, b] = two();
    const d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1, z0 = cv.cam.z;
    let mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const mv = () => {
      if (touches.size < 2) return;
      [a, b] = two();
      const r = rect(), nx = (a.x + b.x) / 2, ny = (a.y + b.y) / 2;
      cv.glide.stop();
      cv.cam.x += nx - mx;
      cv.cam.y += ny - my;
      mx = nx;
      my = ny;
      zoomAt(z0 * (Math.hypot(a.x - b.x, a.y - b.y) / d0), nx - r.left, ny - r.top);
    };
    const up = () => {
      if (touches.size >= 2) return;
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      cv.busy = false;
      if (c.dirty) repaint();
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function pan(e, { tap = false } = {}) {
    root.classList.add('grabbing');
    track(e, {
      move: (ev, dx, dy) => panBy(dx, dy),
      up: (ev, moved, cancelled) => {
        root.classList.remove('grabbing');
        if (moved || cancelled || !tap) return;
        // a tap on an empty spot: the selection goes, two make an item
        select([]);
        if (double('empty')) newItemAt(toWorld(ev.clientX, ev.clientY));
      },
    });
  }

  function pressNode(e, id) {
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (add) {
      if (cv.sel.has(id)) cv.sel.delete(id);
      else cv.sel.add(id);
      cv.edge = null;
      paintSel();
      if (!cv.sel.has(id)) return;
    } else if (!cv.sel.has(id)) select([id]);
    const ids = [...cv.sel];
    const start = new Map(ids.map(i => [i, { x: geo.get(i).x, y: geo.get(i).y }]));
    // with Alt, the copies move and the originals stay
    let moving = null;
    track(e, {
      move: (ev, dx, dy, tx, ty) => {
        if (!moving) {
          moving = new Map();
          for (const i of ids) {
            if (!e.altKey) { moving.set(i, i); continue; }
            const copy = nodeEl(i).cloneNode(true), cid = newId();
            copy.dataset.node = cid;
            copy.classList.add('sel');
            nodeEl(i).classList.remove('sel');
            world.insertBefore(copy, labels);
            geo.set(cid, { ...geo.get(i) });
            moving.set(i, cid);
          }
        }
        // (with the grid on, the node held goes along its lines, and the others with it)
        const main = start.get(id);
        let ox = tx / cv.cam.z, oy = ty / cv.cam.z;
        if (snapOn()) { ox = snap(main.x + ox) - main.x; oy = snap(main.y + oy) - main.y; }
        for (const [i, m] of moving) {
          const g = geo.get(m), s = start.get(i);
          g.x = s.x + ox;
          g.y = s.y + oy;
          const el = nodeEl(m);
          el.style.left = g.x + 'px';
          el.style.top = g.y + 'px';
        }
        drawEdges();
      },
      up: (ev, moved, cancelled) => {
        if (cancelled) return repaint();
        if (!moved) {
          // a click on one of several selected nodes keeps only it
          if (!add && cv.sel.size > 1) select([id]);
          if (!add && double(`node:${id}`)) openNode(id, ev);
          return;
        }
        const at = i => ({ x: Math.round(geo.get(moving.get(i)).x), y: Math.round(geo.get(moving.get(i)).y) });
        if (!e.altKey) return commit({ nodes: allNodes().map(n => (moving.has(n.id) ? { ...n, ...at(n.id) } : n)) });
        const map = new Map([...moving].map(([i]) => [i, newId()]));
        const add2 = allNodes().filter(n => map.has(n.id)).map(n => ({ ...clone(n), id: map.get(n.id), ...at(n.id) }));
        const links = allEdges().filter(x => map.has(x.from) && map.has(x.to)).map(x => ({ ...clone(x), id: newId(), from: map.get(x.from), to: map.get(x.to) }));
        cv.sel = new Set(map.values());
        commit({ nodes: [...allNodes(), ...add2], edges: [...allEdges(), ...links] });
      },
    });
  }

  // The handle at the corner resizes the node keeping its shape (Shift: freely; a text only gets
  // wider or narrower); a double click on it fits the node to what it shows.
  function resize(e, id) {
    const g = geo.get(id), el = nodeEl(id), w0 = g.w, h0 = g.h, text = g.shape === 'text';
    const minW = 40, minH = text ? 24 : 30;
    // (an image keeps the shape of its picture: its caption and border stay the same size)
    const frame = el.querySelector('.cvs-frame');
    const cx = frame ? w0 - frame.offsetWidth : 0, cy = frame ? h0 - frame.offsetHeight : 0;
    track(e, {
      threshold: 1,
      move: (ev, dx, dy, tx, ty) => {
        let w = w0 + tx / cv.cam.z, h = h0 + ty / cv.cam.z;
        if (!ev.shiftKey && !text) {
          // the corner follows the pointer along the diagonal, so the shape stays
          const k = Math.max((w - cx) / (w0 - cx), (h - cy) / (h0 - cy), (minW - cx) / (w0 - cx), (minH - cy) / (h0 - cy));
          w = snapOn() ? snapSize(cx + (w0 - cx) * k) : cx + (w0 - cx) * k;
          h = cy + ((w - cx) / (w0 - cx)) * (h0 - cy);
        } else {
          w = snapOn() ? snapSize(w) : w;
          h = snapOn() && !text ? snapSize(h) : h;
        }
        g.w = Math.max(minW, w);
        g.h = Math.max(minH, h);
        el.style.width = g.w + 'px';
        el.style[text ? 'minHeight' : 'height'] = g.h + 'px';
        if (text) el.style.height = '';
        g.h = Math.max(g.h, el.offsetHeight);
        drawEdges();
      },
      up: (ev, moved, cancelled) => {
        if (cancelled) return repaint();
        if (moved) return patchNodes([id], n => ({ ...n, w: Math.round(g.w), h: Math.round(g.h) }));
        if (double(`rs:${id}`)) fitContent(id);
      },
    });
  }

  // Dragged from a node's dot to another node: an arrow. Let go on an empty spot: a new node there,
  // linked from it.
  function connect(e, from) {
    const target = ev => {
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cvs-node');
      return t && root.contains(t) && t.dataset.node !== from ? t : null;
    };
    let lit = null;
    track(e, {
      threshold: 2,
      move: ev => {
        const r = rect(), g = geo.get(from);
        const sx = cv.cam.x + (g.x + g.w / 2) * cv.cam.z, sy = cv.cam.y + (g.y + g.h / 2) * cv.cam.z;
        over.innerHTML = `<path class="cvs-link" d="M${sx} ${sy}L${ev.clientX - r.left} ${ev.clientY - r.top}"/>`;
        const t = target(ev);
        if (t !== lit) { lit?.classList.remove('target'); lit = t; lit?.classList.add('target'); }
      },
      up: (ev, moved) => {
        over.innerHTML = '';
        lit?.classList.remove('target');
        if (!moved) return;
        const t = target(ev);
        if (t) return addEdge(from, t.dataset.node);
        if (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cvs') !== root) return;
        const p = toWorld(ev.clientX, ev.clientY);
        host.showMenu(ev.clientX, ev.clientY, createItems(p, from));
      },
    });
  }

  function boxSelect(e) {
    const add = e.shiftKey || e.ctrlKey || e.metaKey, base = add ? [...cv.sel] : [];
    if (!add) select([]);
    const box = document.createElement('div');
    box.className = 'sel-box';
    track(e, {
      move: ev => {
        if (!box.isConnected) document.body.append(box);
        const l = Math.min(e.clientX, ev.clientX), t = Math.min(e.clientY, ev.clientY), r = Math.max(e.clientX, ev.clientX), b = Math.max(e.clientY, ev.clientY);
        Object.assign(box.style, { left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' });
        const p = toWorld(l, t), q = toWorld(r, b);
        const hit = [...geo].filter(([, g]) => g.x < q.x && g.x + g.w > p.x && g.y < q.y && g.y + g.h > p.y).map(([id]) => id);
        cv.sel = new Set([...base, ...hit]);
        paintSel();
      },
      up: (ev, moved) => {
        box.remove();
        if (!moved && !add && double('empty')) newItemAt(toWorld(ev.clientX, ev.clientY));
      },
    });
  }

  // An item dragged from the tray onto the canvas: another copy of it there.
  function dragFromTray(e, itemId) {
    const ghost = document.createElement('div');
    ghost.className = 'cvs-ghost';
    ghost.textContent = byId.get(itemId)?.title || 'Untitled';
    track(e, {
      move: ev => {
        if (!ghost.isConnected) document.body.append(ghost);
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
      },
      up: (ev, moved) => {
        ghost.remove();
        if (!moved) return;
        const at = document.elementFromPoint(ev.clientX, ev.clientY);
        if (at?.closest('.cvs') !== root || at.closest('.cvs-tray, .cvs-tools, .cvs-zoom')) return;
        addCopy(itemId, toWorld(ev.clientX, ev.clientY));
      },
    });
  }

  root.addEventListener('pointerdown', e => {
    if (e.target.closest('.cvs-tools, .cvs-zoom, textarea, input')) return;
    cv.active = true;
    root.classList.add('active');
    if (e.target.closest('.cvs-tray')) {
      const row = e.target.closest('.cvs-ti');
      if (row && e.button === 0 && e.pointerType === 'mouse' && !e.target.closest('button')) dragFromTray(e, row.dataset.item);
      return;
    }
    root.focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      trackTouch(e);
      if (touches.size === 2) return pinch();
      if (touches.size > 2) return;
    }
    if (e.button === 1 || (e.button === 0 && cv.space)) { e.preventDefault(); return pan(e); }
    if (e.button !== 0) return;
    const dot = e.target.closest('.cvs-dot');
    if (dot) return connect(e, dot.closest('.cvs-node').dataset.node);
    const rs = e.target.closest('.cvs-rs');
    if (rs) return resize(e, rs.closest('.cvs-node').dataset.node);
    const n = e.target.closest('.cvs-node');
    if (n) return pressNode(e, n.dataset.node);
    const edge = e.target.closest('[data-edge]');
    if (edge) {
      select([], edge.dataset.edge);
      if (double(`edge:${edge.dataset.edge}`)) editLabel(edge.dataset.edge);
      return;
    }
    if (e.pointerType === 'touch') return pan(e, { tap: true });
    e.preventDefault();
    boxSelect(e);
  });

  // The wheel moves the canvas (Shift: sideways), Ctrl + wheel and a touchpad pinch zoom it, not the UI.
  // Pictures pasted (where the pointer is, or else in the middle) or dropped become items.
  root.addEventListener('pointermove', e => { cv.pointer = { x: e.clientX, y: e.clientY }; });
  root.addEventListener('pointerleave', () => { cv.pointer = null; });
  const pictures = list => [...(list || [])].filter(f => f.type.startsWith('image/'));
  root.addEventListener('paste', e => {
    if (e.target.closest('textarea, input')) return;
    const files = pictures(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    addPictures(files, cv.pointer ? toWorld(cv.pointer.x, cv.pointer.y) : undefined);
  });
  root.addEventListener('dragover', e => {
    if (![...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/'))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  root.addEventListener('drop', e => {
    const files = pictures(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    addPictures(files, toWorld(e.clientX, e.clientY));
  });

  root.addEventListener('wheel', e => {
    if (c.ctx !== 'page' && !cv.active) return; // (the page scrolls)
    if (e.target.closest('.cvs-tray')) return;
    e.preventDefault();
    e.stopPropagation();
    const r = rect();
    if (e.ctrlKey || e.metaKey) {
      // a mouse wheel's notches glide; a touchpad's pinch (small steps, many of them) follows the fingers
      const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40;
      const f = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01);
      return zoomAt((notch ? zoomGoal() : cv.cam.z) * f, e.clientX - r.left, e.clientY - r.top, { smooth: notch });
    }
    const k = e.deltaMode === 1 ? 16 : 1;
    panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
  }, { passive: false });

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-cvs]');
    const row = e.target.closest('.cvs-ti');
    if (!b) {
      if (row) focusItem(row.dataset.item);
      return;
    }
    const r = b.getBoundingClientRect();
    switch (b.dataset.cvs) {
      case 'new-item': return newItemAt();
      case 'new-sticky': return newFreeAt('sticky');
      case 'new-text': return newFreeAt('text');
      case 'new-shape': return host.showMenu(r.left, r.bottom + 4, ['box', 'ellipse', 'diamond'].map(s => ({ label: SHAPES[s], run: () => newFreeAt(s) })));
      case 'tray': return toggleTray();
      case 'zoom-in': return zoomBy(1.25);
      case 'zoom-out': return zoomBy(0.8);
      case 'zoom-reset': { const rr = rect(); return zoomAt(1, rr.width / 2, rr.height / 2, { smooth: true }); }
      case 'fit': return fit({ smooth: true });
      case 'snap': return S.updateView(key, viewId, { snap: V().snap ? null : true });
      case 'toggle': {
        const id = row.dataset.item;
        return copies.has(id) ? hideItem(id) : addCopy(id);
      }
    }
  });

  // ---------- menus ----------

  // What can be made at `p` (from the canvas's menu, or at the end of an arrow from `from`).
  const createItems = (p, from = null) => [
    { label: from ? 'New item' : 'New item here', run: () => newItemAt(p, { from }) },
    { label: 'Sticky note', run: () => newFreeAt('sticky', p, from) },
    { label: 'Rectangle', run: () => newFreeAt('box', p, from) },
    { label: 'Ellipse', run: () => newFreeAt('ellipse', p, from) },
    { label: 'Diamond', run: () => newFreeAt('diamond', p, from) },
    { label: 'Text', run: () => newFreeAt('text', p, from) },
  ];

  const lookItems = ids => {
    const sel = allNodes().filter(n => ids.includes(n.id)), items = sel.every(n => n.note);
    return Object.entries(SHAPES).filter(([s]) => s !== 'image' || items)
      .map(([s, name]) => ({ label: `${name}${sel.every(n => n.shape === s) ? '  ✓' : ''}`, run: () => setShape(ids, s) }));
  };
  const colorItems = ids => {
    const sel = allNodes().filter(n => ids.includes(n.id));
    return [{ label: `Default${sel.every(n => !n.color) ? '  ✓' : ''}`, run: () => setColor(ids, null) },
      ...Object.entries(COLORS).map(([k, name]) => ({ label: `${name}${sel.every(n => n.color === k) ? '  ✓' : ''}`, run: () => setColor(ids, k) }))];
  };

  function nodeMenu(x, y, id) {
    if (!cv.sel.has(id)) select([id]);
    const ids = [...cv.sel];
    const sub = items => r => host.showMenu(r.right + 2, r.top, items);
    const common = [
      { label: 'Look…', run: sub(lookItems(ids)) },
      { label: 'Color…', run: sub(colorItems(ids)) },
      { label: 'Duplicate  (Ctrl+D)', run: () => duplicate(ids) },
      { label: 'Bring to front', run: () => toFront(ids, true) },
      { label: 'Send to back', run: () => toFront(ids, false) },
    ];
    if (ids.length > 1) {
      return host.showMenu(x, y, [
        { label: `${ids.length} selected`, disabled: true, run: () => {} },
        '-', ...common, '-',
        { label: 'Remove from the canvas', run: () => removeNodes(ids) },
      ]);
    }
    const n = allNodes().find(q => q.id === id), item = n?.note ? S.getNote(n.note) : null;
    if (!n) return;
    const count = item ? copies.get(item.id) || 0 : 0;
    host.showMenu(x, y, [
      { label: item ? `Database item${count > 1 ? ` · on the canvas ${count} times` : ''}` : 'Canvas only', disabled: true, run: () => {} },
      '-',
      ...(item ? [{ label: 'Open', run: r => c.open(item.id, { clientX: r.left, clientY: r.top }, 'canvas') }] : []),
      { label: item ? 'Rename' : 'Edit text', run: () => edit(id) },
      '-', ...common, '-',
      item ? { label: 'Convert to a canvas-only element…', run: () => toFree(id) } : { label: 'Convert to a database item', run: () => toItem(id) },
      '-',
      ...(item ? [
        ...(count > 1 ? [{ label: 'Remove this copy', run: () => removeNodes([id]) }] : []),
        { label: count > 1 ? 'Hide from the canvas (all copies)' : 'Hide from the canvas', run: () => hideItem(item.id) },
        { label: 'Delete item…', danger: true, run: () => host.deleteNotes([item.id]) },
      ] : [{ label: 'Delete', danger: true, run: () => removeNodes([id]) }]),
    ]);
  }

  function edgeMenu(x, y, id) {
    select([], id);
    const e = allEdges().find(q => q.id === id);
    if (!e) return;
    const ends = e.ends || 'end';
    const setEnds = v => patchEdge(id, q => { if (v === 'end') delete q.ends; else q.ends = v; return q; });
    host.showMenu(x, y, [
      { label: e.label ? 'Edit label…' : 'Add a label…', run: () => editLabel(id) },
      { label: 'Reverse', run: () => patchEdge(id, q => ({ ...q, from: q.to, to: q.from })) },
      '-',
      { label: `Arrow at the end${ends === 'end' ? '  ✓' : ''}`, run: () => setEnds('end') },
      { label: `Arrows at both ends${ends === 'both' ? '  ✓' : ''}`, run: () => setEnds('both') },
      { label: `No arrows${ends === 'none' ? '  ✓' : ''}`, run: () => setEnds('none') },
      '-',
      { label: 'Delete arrow', danger: true, run: () => { cv.edge = null; commit({ edges: allEdges().filter(q => q.id !== id) }); } },
    ]);
  }

  function trayMenu(x, y, itemId) {
    const count = copies.get(itemId) || 0;
    host.showMenu(x, y, [
      { label: 'Add a copy to the canvas', run: () => addCopy(itemId) },
      count ? { label: 'Hide from the canvas', run: () => hideItem(itemId) } : { label: 'Show on the canvas', run: () => addCopy(itemId) },
      { label: 'Open', run: r => c.open(itemId, { clientX: r.left, clientY: r.top }, 'canvas') },
    ]);
  }

  root.addEventListener('contextmenu', e => {
    if (e.target.closest('textarea, input, .cvs-tools, .cvs-zoom')) return;
    e.preventDefault();
    const row = e.target.closest('.cvs-ti');
    if (row) return trayMenu(e.clientX, e.clientY, row.dataset.item);
    if (e.target.closest('.cvs-tray')) return;
    const n = e.target.closest('.cvs-node');
    if (n) return nodeMenu(e.clientX, e.clientY, n.dataset.node);
    const edge = e.target.closest('[data-edge]');
    if (edge) return edgeMenu(e.clientX, e.clientY, edge.dataset.edge);
    const p = toWorld(e.clientX, e.clientY);
    host.showMenu(e.clientX, e.clientY, [
      ...createItems(p),
      '-',
      { label: 'Select all', run: () => select([...geo.keys()]) },
      { label: 'Fit to content', run: fit },
      { label: tray ? 'Hide the items tray' : 'Show the items tray', run: toggleTray },
    ]);
  });

  // ---------- keys ----------

  root.addEventListener('keydown', e => {
    if (e.target.closest('textarea, input')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), ids = [...cv.sel];
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey && k === 'z') { take(); return e.shiftKey ? undoRedo(cv.redo, cv.undo, 'redo') : undoRedo(cv.undo, cv.redo, 'undo'); }
    if (mod && !e.altKey && k === 'y') { take(); return undoRedo(cv.redo, cv.undo, 'redo'); }
    if (mod && k === 'a') { take(); return select([...geo.keys()]); }
    if (mod && k === 'd') { take(); return duplicate(ids); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (cv.edge) { take(); const id = cv.edge; cv.edge = null; return commit({ edges: allEdges().filter(q => q.id !== id) }); }
      if (ids.length) { take(); return removeNodes(ids); }
      return;
    }
    if (e.key === 'Escape' && (ids.length || cv.edge)) { take(); return select([]); }
    if ((e.key === 'Enter' || e.key === 'F2') && ids.length === 1) { take(); return edit(ids[0]); }
    if (e.key === ' ' && !cv.space) { take(); cv.space = true; root.classList.add('panning'); return; }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow && ids.length) {
      take();
      // (a grid step with Shift, or when the grid is on: then along its lines)
      const step = e.shiftKey || snapOn() ? GRID : 1;
      return patchNodes(ids, n => ({ ...n, x: snap(n.x + arrow[0] * step), y: snap(n.y + arrow[1] * step) }));
    }
  });

  // ---------- the tray ----------

  function trayHtml() {
    return `<div class="cvs-tray">
      <div class="cvs-tray-head"><b>Items</b><span class="cvs-tray-n">${items.length}</span><span class="spacer"></span>
        <button class="cv-btn" data-cvs="tray" title="Close">${icon('close')}</button></div>
      <input class="cvs-tq" placeholder="Search the items" spellcheck="false" value="${esc(cv.trayQ)}">
      <div class="cvs-tl">${items.map(n => {
        const k = copies.get(n.id) || 0;
        return `<div class="cvs-ti ${k ? '' : 'off'}" data-item="${n.id}" title="${k ? `On the canvas ${k === 1 ? 'once' : `${k} times`}: click to find it, drag it to add a copy` : 'Hidden from the canvas: drag it to put it there'}">
          ${icon(n.icon || (n.kind === 'database' ? 'table' : 'note'))}<span class="cvs-tt ${n.title ? '' : 'untitled'}">${esc(n.title || 'Untitled')}</span>
          <span class="cvs-tc">${k ? `${k}×` : 'Hidden'}</span>
          <button class="cv-btn" data-cvs="toggle" title="${k ? 'Hide from the canvas' : 'Show on the canvas'}">${icon(k ? 'eye' : 'eyeOff')}</button></div>`;
      }).join('') || '<div class="cvs-tray-empty">No items yet</div>'}</div>
      <div class="cvs-tray-foot">An item can be on the canvas several times: drag it to add a copy.</div>
    </div>`;
  }

  function filterTray() {
    const q = cv.trayQ.trim().toLowerCase();
    for (const row of root.querySelectorAll('.cvs-ti')) row.hidden = !!q && !row.querySelector('.cvs-tt').textContent.toLowerCase().includes(q);
  }

  function toggleTray() {
    store('canvasTray', !store('canvasTray'));
    repaint();
  }

  // A click on an item in the tray shows its copies one after the other.
  function focusItem(itemId) {
    const list = nodes.filter(n => n.note === itemId);
    if (!list.length) return;
    const i = ((cv.cycle[itemId] ?? -1) + 1) % list.length;
    cv.cycle[itemId] = i;
    select([list[i].id]);
    reveal(list[i].id);
  }

  const tq = root.querySelector('.cvs-tq');
  if (tq) {
    tq.addEventListener('input', () => { cv.trayQ = tq.value; filterTray(); });
    tq.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); tq.value = cv.trayQ = ''; filterTray(); tq.blur(); } });
    filterTray();
  }

  // ---------- pictures and texts of the items ----------

  function fill(itemId, p) {
    for (const el of c.el.querySelectorAll(`.cvs-node[data-item="${CSS.escape(itemId)}"]`)) {
      const sx = el.querySelector('.cvs-sx');
      if (sx) sx.textContent = p.text || '';
      const frame = el.querySelector('.cvs-frame');
      if (!frame || !p.cover || frame.querySelector('img')) continue;
      const img = Object.assign(document.createElement('img'), { alt: '', draggable: false });
      img.onerror = () => img.remove();
      img.onload = () => ratios.set(p.cover, img.naturalWidth / (img.naturalHeight || 1));
      const known = urls.get(p.cover);
      if (known) img.src = known;
      else {
        const url = S.fileUrl(p.cover);
        Promise.resolve(url).then(u => { if (!u) return img.remove(); urls.set(p.cover, u); img.src = u; });
      }
      frame.append(img);
    }
  }
  for (const id of new Set(nodes.filter(n => n.note && (n.shape === 'image' || n.shape === 'sticky')).map(n => n.note))) {
    const item = byId.get(id), hit = previews.get(id);
    if (hit && hit.updated === item.updated) fill(id, hit);
    else host.preview(id).then(p => { previews.set(id, p); fill(id, p); }, () => {});
  }

  // ---------- the node's html ----------

  function nodeHtml(n, item, count) {
    const shape = SHAPES[n.shape] ? n.shape : 'box';
    const [w, h] = sizeOf(n);
    const title = titleOf(n, item);
    const empty = item ? !item.title : !n.text;
    const shown = esc(empty ? (item ? 'Untitled' : 'Type something') : title);
    let inner;
    if (shape === 'image') {
      inner = `<div class="cvs-frame" style="--h: ${hueOf(title)}">${item?.icon ? icon(item.icon, 'cvs-fi') : icon('image', 'cvs-fi')}</div><div class="cvs-cap">${shown}</div>`;
    } else if (shape === 'sticky') {
      inner = `<div class="cvs-st">${shown}</div>${item ? '<div class="cvs-sx"></div>' : ''}`;
    } else if (shape === 'diamond') {
      inner = `<svg class="cvs-dia" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,1 99,50 50,99 1,50" vector-effect="non-scaling-stroke"/></svg><div class="cvs-lb">${shown}</div>`;
    } else inner = `<div class="cvs-lb">${shown}</div>`;
    const badge = item ? `<span class="cvs-badge" title="An item of the database${count > 1 ? `, on the canvas ${count} times` : ''}">${icon(item.icon || (item.kind === 'database' ? 'table' : 'note'))}${count > 1 ? `<b>${count}×</b>` : ''}</span>` : '';
    const size = `width:${w}px;${shape === 'text' ? 'min-' : ''}height:${h}px`;
    return `<div class="cvs-node s-${shape} ${n.color ? `k-${n.color} colored` : ''} ${item ? 'is-item' : 'is-free'} ${cv.sel.has(n.id) ? 'sel' : ''} ${empty ? 'empty' : ''}"
      data-node="${n.id}" ${item ? `data-item="${item.id}"` : ''} style="left:${n.x}px;top:${n.y}px;${size}">${inner}${badge}
      <span class="cvs-dot" data-side="t"></span><span class="cvs-dot" data-side="r"></span><span class="cvs-dot" data-side="b"></span><span class="cvs-dot" data-side="l"></span>
      <span class="cvs-rs" title="Drag to resize (Shift: freely), double-click to fit what it shows"></span></div>`;
  }

  // ---------- items that come by themselves ----------

  // The items with no copy that weren't hidden get one, in free spots of a grid below what is there.
  function placeMissing() {
    const v = V();
    if (!v || v.type !== 'canvas') return;
    const have = new Set((v.nodes || []).map(n => n.note).filter(Boolean)), hid = new Set(v.off || []);
    const list = S.childrenOf(c.space, c.parent).filter(n => !have.has(n.id) && !hid.has(n.id));
    if (!list.length) return;
    const look = v.look || 'box', [w, h] = SIZES[look];
    const taken = (v.nodes || []).filter(n => !n.note || byId.has(n.note)).map(n => { const [nw, nh] = sizeOf(n); return { x: n.x, y: n.y, w: nw, h: nh }; });
    const b = bounds(taken) || { x: 0, y: 0, w: 0, h: 0 };
    const gap = 32, cw = w + gap, ch = h + gap, cols = Math.max(4, Math.round((b.w + gap) / cw));
    const free = r => !taken.some(t => r.x < t.x + t.w + gap / 2 && r.x + r.w + gap / 2 > t.x && r.y < t.y + t.h + gap / 2 && r.y + r.h + gap / 2 > t.y);
    const add = [];
    for (let i = 0; add.length < list.length && i < 20000; i++) {
      const r = { x: b.x + (i % cols) * cw, y: b.y + Math.floor(i / cols) * ch, w, h };
      if (!free(r)) continue;
      taken.push(r);
      add.push({ id: newId(), note: list[add.length].id, shape: look, x: snap(r.x), y: snap(r.y), w, h, ...(look === 'sticky' ? { color: 'yellow' } : {}) });
    }
    write({ nodes: [...(v.nodes || []), ...add] });
    if (look === 'image') fitImages(add.map(n => n.id));
  }

  // ---------- ready ----------

  // A database opened on its own: the canvas goes down to the bottom of what shows the page.
  const scroller = c.ctx === 'page' ? scrollParent(root) : null;
  const height = () => {
    if (!scroller) return;
    const top = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    root.style.height = `${Math.max(360, Math.round(scroller.clientHeight - top - 16))}px`;
  };
  height();

  cv.api = { fit, toggleTray, edit, fill, paintSel, undo: () => undoRedo(cv.undo, cv.redo, 'undo'), newItem: () => newItemAt() };
  cv.ro?.disconnect();
  cv.ro = new ResizeObserver(() => {
    if (!root.isConnected) return;
    height();
    if (cv.needFit) fit();
  });
  cv.ro.observe(root);
  if (scroller) cv.ro.observe(scroller);
  paintSel();
  if (cv.cam) applyCam();
  else if (!missing.length) fit();
  else cv.cam = { x: 40, y: 64, z: 1 }; // (fitted once the items are placed)
  drawEdges();
  if (missing.length && !cv.busy) {
    const first = !camOf(viewId);
    queueMicrotask(() => {
      placeMissing();
      if (first) c.canvas?.api?.fit();
    });
  }
  if (focus) root.focus({ preventScroll: true });
}
