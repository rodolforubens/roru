// The images of a note seen bigger, over the whole window: fit to it at first, zoomed with the
// wheel, a touchpad pinch or two fingers (around where they point), +/−/0 or the buttons (gliding
// from one zoom to the next, but for fingers and touchpads, which it follows), moved by
// dragging, and the note's other images one arrow away (← → on the keyboard). Ctrl+C, the copy
// button or the context menu copies the image. Escape, the close button or a click outside the
// image closes it.
import { icon, glider } from './util.js?v=9255558';

const MAX = 16;

// `list`: [{ url, alt }], `index`: the one shown first.
export function openImageViewer(list, index = 0) {
  if (!list.length) return;
  document.querySelector('.iv')?.remove();
  const before = document.activeElement;
  const el = document.createElement('div');
  el.className = 'iv';
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="iv-bar">
      <span class="iv-name"></span>
      <span class="iv-count"></span>
      <span class="iv-tools">
        <button class="iv-btn" data-iv="out" title="Zoom out (−)">${icon('minus')}</button>
        <button class="iv-btn iv-zoom" data-iv="actual" title="Actual size (1)"></button>
        <button class="iv-btn" data-iv="in" title="Zoom in (+)">${icon('plus')}</button>
        <button class="iv-btn" data-iv="copy" title="Copy image (Ctrl+C)">${icon('copy')}</button>
        <button class="iv-btn" data-iv="fit" title="Fit to the window (0)">${icon('expand')}</button>
        <button class="iv-btn" data-iv="close" title="Close (Esc)">${icon('close')}</button>
      </span>
    </div>
    <div class="iv-note" hidden></div>
    <div class="iv-stage"><img class="iv-img" alt="" draggable="false"></div>
    ${list.length > 1 ? `<button class="iv-nav prev" data-iv="prev" title="Previous (←)">${icon('back')}</button>
    <button class="iv-nav next" data-iv="next" title="Next (→)">${icon('forward')}</button>` : ''}`;
  document.body.append(el);
  const stage = el.querySelector('.iv-stage'), img = el.querySelector('.iv-img');
  const zoomLabel = el.querySelector('.iv-zoom');

  // the image is drawn at `scale` with its top left corner at (x, y) of the stage
  let i = index, scale = 1, x = 0, y = 0, w = 0, h = 0, fitted = true;
  const fit = () => (w && h ? Math.min(1, stage.clientWidth / w, stage.clientHeight / h) : 1);
  const minScale = () => Math.min(fit(), 1) / 2;

  // where the image at `s` stays in view: centered along a side it doesn't fill, else with no gap
  // at its edges
  const held = (s, px, py) => {
    const sw = stage.clientWidth, sh = stage.clientHeight, iw = w * s, ih = h * s;
    return {
      x: iw <= sw ? (sw - iw) / 2 : Math.min(0, Math.max(sw - iw, px)),
      y: ih <= sh ? (sh - ih) / 2 : Math.min(0, Math.max(sh - ih, py)),
    };
  };
  // (a glide goes between two places in view, so its frames aren't held)
  const paint = (hold = true) => {
    if (hold) ({ x, y } = held(scale, x, y));
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    el.classList.toggle('iv-pannable', w * scale > stage.clientWidth + 1 || h * scale > stage.clientHeight + 1);
  };
  const glide = glider(() => ({ scale, x, y }), (v, last) => { ({ scale, x, y } = v); paint(last); });
  const goTo = (s, gx, gy, smooth) => {
    const at = held(s, gx, gy);
    if (smooth) return glide.to({ scale: s, ...at });
    glide.stop();
    scale = s;
    ({ x, y } = at);
    paint();
  };
  // the zoom it is going to (while it glides)
  const target = () => glide.goal?.scale ?? scale;
  const toFit = (smooth = false) => {
    fitted = true;
    goTo(fit(), 0, 0, smooth);
  };
  // zooms to `next`, keeping the point (px, py) of the stage where it is
  const zoomTo = (next, px = stage.clientWidth / 2, py = stage.clientHeight / 2, smooth = true) => {
    next = Math.max(minScale(), Math.min(MAX, next));
    fitted = false;
    goTo(next, px - (px - x) * (next / scale), py - (py - y) * (next / scale), smooth);
  };
  const show = n => {
    i = (n + list.length) % list.length;
    const it = list[i];
    el.querySelector('.iv-name').textContent = it.alt || '';
    el.querySelector('.iv-count').textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    w = h = 0;
    img.classList.add('loading');
    img.onload = () => {
      w = img.naturalWidth || 1;
      h = img.naturalHeight || 1;
      img.classList.remove('loading');
      toFit();
    };
    img.src = it.url;
    img.alt = it.alt || '';
  };

  // a short message over the image ("Image copied")
  const note = el.querySelector('.iv-note');
  let noteTimer;
  const say = text => {
    note.textContent = text;
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note.hidden = true), 1800);
  };
  const copy = async () => {
    try {
      await copyImage(list[i].url);
      say('Image copied');
    } catch (e) {
      say(`Could not copy the image — ${e.message || e}`);
    }
  };

  const close = () => {
    el.remove();
    removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onResize);
    before?.focus?.({ preventScroll: true });
  };
  const act = what => {
    if (what === 'close') close();
    else if (what === 'prev') show(i - 1);
    else if (what === 'next') show(i + 1);
    else if (what === 'in') zoomTo(target() * 1.5);
    else if (what === 'out') zoomTo(target() / 1.5);
    else if (what === 'fit') toFit(true);
    else if (what === 'copy') copy();
    else if (what === 'actual') zoomTo(1);
  };

  // the keys are the viewer's while it is open (the note under it gets none)
  const onKey = e => {
    const keys = { Escape: 'close', ArrowLeft: 'prev', ArrowRight: 'next', '+': 'in', '=': 'in', '-': 'out', _: 'out', 0: 'fit', 1: 'actual' };
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
      e.stopPropagation();
      e.preventDefault();
      return copy();
    }
    if ((e.ctrlKey || e.metaKey) && !['Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return; // Ctrl+=/−/0 still zoom the UI
    e.stopPropagation();
    const what = keys[e.key];
    if (!what || (list.length < 2 && (what === 'prev' || what === 'next'))) return;
    e.preventDefault();
    act(what);
  };
  const onResize = () => (fitted ? toFit() : paint());
  addEventListener('keydown', onKey, true);
  addEventListener('resize', onResize);

  el.addEventListener('click', e => {
    const b = e.target.closest('[data-iv]');
    if (b) return act(b.dataset.iv);
    if (e.target.closest('.iv-stage') && !moved && !onImage) close();
  });
  // the context menu of the image is a single choice: copying it
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    if (e.target !== img) return;
    menu = document.createElement('div');
    menu.className = 'iv-menu';
    menu.innerHTML = `<div class="mi">Copy image</div>`;
    el.append(menu);
    menu.style.left = `${Math.min(e.clientX, innerWidth - menu.offsetWidth - 6)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - menu.offsetHeight - 6)}px`;
    menu.onclick = ev => { ev.stopPropagation(); closeMenu(); copy(); };
  });
  el.addEventListener('pointerdown', e => { if (!e.target.closest('.iv-menu')) closeMenu(); }, true);

  // the wheel (and a touchpad pinch, which comes as Ctrl + wheel) zooms the image, not the UI
  el.addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!w || e.target.closest('.iv-bar')) return;
    const r = stage.getBoundingClientRect();
    const step = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    // a mouse wheel's notches glide; a touchpad (small steps, many of them) is followed
    const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40;
    zoomTo((notch ? target() : scale) * step, e.clientX - r.left, e.clientY - r.top, notch);
  }, { passive: false });

  img.addEventListener('dblclick', e => {
    const r = stage.getBoundingClientRect();
    if (fitted || scale <= fit() + 0.001) zoomTo(Math.max(1, fit() * 2), e.clientX - r.left, e.clientY - r.top);
    else toFit(true);
  });

  // dragging moves the image; two fingers zoom it (and move it with them)
  const pointers = new Map();
  let moved = false, onImage = false, pinch = null;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    glide.stop();
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    onImage = e.target === img;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  });
  stage.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const r = stage.getBoundingClientRect();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      x += mx - pinch.mx;
      y += my - pinch.my;
      pinch.mx = mx;
      pinch.my = my;
      zoomTo(pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), mx - r.left, my - r.top, false);
    } else if (pointers.size === 1) {
      x += dx;
      y += dy;
      fitted = false;
      paint();
    }
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    // (a click right after a drag doesn't close the viewer)
    if (moved) setTimeout(() => (moved = false), 0);
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  show(i);
  el.focus({ preventScroll: true });
}

// Puts the image at `url` on the clipboard, as a PNG (the one image type every browser takes).
export async function copyImage(url) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('the clipboard takes no images here');
  const png = (async () => {
    const blob = await (await fetch(url)).blob();
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const canvas = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    return new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error('could not read the image'))), 'image/png'));
  })();
  // (the promise goes in as it is: Safari only allows writing while the click is still being handled)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
