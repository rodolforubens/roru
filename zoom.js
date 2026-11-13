// Whole-UI zoom, Notion/Claude style:
//   Ctrl + =  /  Ctrl + -  /  Ctrl + 0  and  Ctrl + mouse wheel (or touchpad pinch).
// Uses the native WebView zoom (like Electron's setZoomFactor), falling back to CSS zoom, and
// glides from one level to the next instead of jumping.
import { store, glider } from './util.js?v=9255558';

export const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

let level = clamp(store('zoom') ?? 1);
const listeners = new Set();
let hideTimer;

function clamp(z) {
  return Math.min(STEPS[STEPS.length - 1], Math.max(STEPS[0], +z || 1));
}

async function apply(z) {
  try {
    await window.__TAURI__.webview.getCurrentWebview().setZoom(z);
  } catch {
    document.documentElement.style.zoom = String(z);
  }
}

// The zoom drawn now (between two levels while it glides). The webview's zoom is set through the
// backend, so a frame waits for the one before it to be set, and the last one is always set.
let shown = level, sending = null, waiting = null;
function send(z) {
  if (sending) return void (waiting = z);
  sending = apply(z).finally(() => {
    sending = null;
    if (waiting != null) { const next = waiting; waiting = null; send(next); }
  });
}
const glide = glider(() => ({ z: shown }), ({ z }) => { shown = z; send(z); });

export function getZoom() { return level; }

export function setZoom(z, { toast = true } = {}) {
  level = clamp(Math.round(z * 100) / 100);
  store('zoom', level);
  glide.to({ z: level });
  listeners.forEach(fn => fn(level));
  if (toast) showToast();
}

export const zoomIn = () => setZoom(STEPS.find(s => s > level + 0.001) ?? level);
export const zoomOut = () => setZoom([...STEPS].reverse().find(s => s < level - 0.001) ?? level);
export const resetZoom = () => setZoom(1);
export const onZoom = fn => listeners.add(fn);

function showToast() {
  const el = document.getElementById('zoom-toast');
  if (!el) return;
  el.querySelector('.zt-value').textContent = Math.round(level * 100) + '%';
  el.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

export function initZoom() {
  apply(level);

  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key, c = e.code;
    if (k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd') { e.preventDefault(); zoomIn(); }
    else if (k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract') { e.preventDefault(); zoomOut(); }
    else if (k === '0' || c === 'Digit0' || c === 'Numpad0') { e.preventDefault(); resetZoom(); }
  }, true);

  // Ctrl + wheel: accumulate the delta so that touchpad pinch (small deltas)
  // and the mouse wheel (~100 per notch) both move one step at a time.
  let acc = 0, accTimer;
  window.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    acc += e.deltaY;
    clearTimeout(accTimer);
    accTimer = setTimeout(() => (acc = 0), 250);
    if (acc <= -40) { acc = 0; zoomIn(); }
    else if (acc >= 40) { acc = 0; zoomOut(); }
  }, { passive: false });

  const el = document.getElementById('zoom-toast');
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  el.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => el.classList.remove('show'), 900); });
  el.querySelector('[data-z="in"]').onclick = zoomIn;
  el.querySelector('[data-z="out"]').onclick = zoomOut;
  el.querySelector('[data-z="reset"]').onclick = resetZoom;
}
