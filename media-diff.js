// Before/after previews of images, videos, audio, PDFs and fonts in diffs. The diff of such a file
// only names the content of each side ("index <old>..<new>", or its Git LFS pointers), so the
// versions are read from git (`git_bytes`) or from the LFS objects, and the working copy through
// the asset protocol. Two versions of an image can also be compared by swiping between them or
// fading one into the other.
import * as G from './git.js?v=870b4f7';
import { esc, fmtSize, fmtDuration, store, IMAGE, VIDEO, AUDIO, FONT, extOf } from './util.js?v=870b4f7';
import { invoke, convertFileSrc } from './platform.js?v=870b4f7';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif', apng: 'image/apng',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm', pdf: 'application/pdf',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
const NOUN = { image: 'image', video: 'video', audio: 'audio', font: 'font', pdf: 'document' };
const MAX_BYTES = 256 * 1024 * 1024;   // bigger versions are not read into memory
const CACHED = 16;                     // versions read from git kept as object URLs

const extOfPath = path => extOf(path.slice(path.lastIndexOf('/') + 1));

export function mediaKind(path) {
  const ext = extOfPath(path);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (FONT.has(ext)) return 'font';
  return ext === 'pdf' ? 'pdf' : null;
}

export const mediaLabel = m => `${extOfPath(m.path).toUpperCase()} ${NOUN[m.kind]}`;

// What each side of the diff of a media file is: "blob:<id>", "lfs:<oid>:<size>" or null (no file
// on that side). `lfs` is the change of Git LFS pointers the diff is about, if any. Null when the
// file is not media, or when the diff names no content (only its mode or its name changed).
export function mediaChange(text, path, lfs) {
  const kind = mediaKind(path);
  if (!kind) return null;
  let sides;
  if (lfs) {
    const side = p => p && `lfs:${p.oid.replace(/^sha256:/, '')}:${p.size}`;
    sides = [side(lfs.old), side(lfs.new)];
  } else {
    const m = text.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m);
    if (!m) return null;
    sides = [m[1], m[2]].map(id => (/^0+$/.test(id) ? null : `blob:${id}`));
  }
  return sides[0] || sides[1] ? { kind, path, old: sides[0], new: sides[1] } : null;
}

// Filled in by loadMedia once the diff is in the page.
export const mediaBody = m => `<div class="diff-scroll media-diff" data-kind="${m.kind}" data-path="${esc(m.path)}"${
  m.old ? ` data-old="${m.old}"` : ''}${m.new ? ` data-new="${m.new}"` : ''}><div class="placeholder">Loading…</div></div>`;

// Shows the versions of the media diff in `pane`, if it has one. With `work`, the new side is the
// file in the working copy (the diff of unstaged changes).
export async function loadMedia(pane, repo, work) {
  const box = pane.querySelector(':scope > .media-diff');
  if (!box) return;
  const { kind, path } = box.dataset, ext = extOfPath(path);
  const side = async (spec, which) => {
    if (!spec) return null;
    const [type, id, size] = spec.split(':');
    const v = which === 'new' && work ? await fromFile(repo, path, id)
      : await cached(`${repo}\n${ext}\n${spec}`, () => (type === 'lfs' ? fromLfs(repo, id, +size, MIME[ext]) : fromBlob(repo, id, MIME[ext])));
    return { ...v, side: which };
  };
  const [a, b] = await Promise.all([side(box.dataset.old, 'old'), side(box.dataset.new, 'new')]);
  if (box.isConnected) paint(box, kind, a, b);
}

// ---------- reading the versions ----------

// key -> promise of { url, size } or { error, size }. Errors are not kept, so they are tried again.
const cache = new Map();
function cached(key, make) {
  let p = cache.get(key);
  if (p) {
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = make().catch(e => ({ error: String(e?.message || e) }));
  cache.set(key, p);
  p.then(v => { if (v.error && cache.get(key) === p) cache.delete(key); });
  while (cache.size > CACHED) {
    const [k, old] = cache.entries().next().value;
    cache.delete(k);
    old.then(v => v.url && URL.revokeObjectURL(v.url));
  }
  return p;
}

const tooBig = size => ({ size, error: `Too big to preview here (${fmtSize(size)}).` });

async function fromBlob(repo, id, mime) {
  const r = await G.gitRaw(repo, ['cat-file', '-s', id]);
  if (r.code !== 0) return { error: 'This version is not in this copy of the repository.' };
  const size = +r.stdout.trim();
  if (size > MAX_BYTES) return tooBig(size);
  const bytes = await invoke('git_bytes', { repo, args: ['cat-file', 'blob', id] });
  return { size, url: URL.createObjectURL(new Blob([bytes], { type: mime })) };
}

const lfsDirs = new Map();   // repo -> promise of the folder of its Git LFS objects
async function fromLfs(repo, oid, size, mime) {
  if (size > MAX_BYTES) return tooBig(size);
  if (!lfsDirs.has(repo)) {
    lfsDirs.set(repo, G.git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(d => `${d.trim()}/lfs/objects`));
  }
  const path = `${await lfsDirs.get(repo)}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  let bytes;
  try {
    bytes = await invoke('read_bytes', { path });
  } catch {
    return { size, error: 'Not downloaded — fetch the Git LFS files to see it.' };
  }
  return { size, url: URL.createObjectURL(new Blob([bytes], { type: mime })) };
}

// `version` (the content's id) makes the address change with the file, past the webview's cache.
const allowed = new Map();   // repo -> promise of the webview being allowed to load its files
async function fromFile(repo, path, version) {
  if (!allowed.has(repo)) allowed.set(repo, invoke('allow_assets', { repo }).catch(() => {}));
  await allowed.get(repo);
  const entry = await invoke('stat_path', { repo, path }).catch(() => null);
  const full = repo.endsWith('/') ? repo + path : `${repo}/${path}`;
  return { url: `${convertFileSrc(full)}?v=${version}`, size: entry?.size };
}

// ---------- showing them ----------

const info = s => [s.w && `${s.w} × ${s.h}`, isFinite(s.duration) && fmtDuration(s.duration), s.size != null && fmtSize(s.size)]
  .filter(Boolean).join(' · ');

// Natural size of an image, or null when it can't be decoded or has none (an SVG without one).
const dims = url => new Promise(resolve => {
  const img = new Image();
  img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : null);
  img.onerror = () => resolve(null);
  img.src = url;
});

const MODES = [['sides', 'Side by side'], ['swipe', 'Swipe'], ['onion', 'Onion skin']];

async function paint(box, kind, a, b) {
  const turn = box._turn = (box._turn || 0) + 1;
  const label = { old: b ? 'Before' : 'Deleted', new: a ? 'After' : 'Added' };
  const caption = s => `<span class="md-label ${s.side}">${label[s.side]}</span><span class="md-info">${esc(info(s))}</span>`;
  const compare = kind === 'image' && a?.url && b?.url;
  let mode = compare && MODES.some(([m]) => m === store('mediaMode')) ? store('mediaMode') : 'sides';
  const bar = () => (compare ? `<div class="md-bar"><div class="diff-mode" title="How to compare the versions">${MODES.map(([m, l]) =>
    `<button data-md-mode="${m}" class="${m === mode ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : '');
  const bind = () => box.querySelectorAll('[data-md-mode]').forEach(btn => btn.onclick = () => {
    store('mediaMode', btn.dataset.mdMode);
    paint(box, kind, a, b);
  });

  if (mode !== 'sides') {
    const [da, db] = await Promise.all([dims(a.url), dims(b.url)]);
    if (turn !== box._turn || !box.isConnected) return;
    if (da && db) {
      [a.w, a.h] = da;
      [b.w, b.h] = db;
      const W = Math.max(da[0], db[0]), H = Math.max(da[1], db[1]);
      const place = ([w, h]) => `left: ${(W - w) / 2 / W * 100}%; top: ${(H - h) / 2 / H * 100}%; width: ${w / W * 100}%; height: ${h / H * 100}%`;
      box.innerHTML = `${bar()}<div class="md-compare">
        <div class="md-stage ${mode}" style="width: min(100%, ${W}px, ${(65 * W / H).toFixed(2)}vh); aspect-ratio: ${W} / ${H}">
          <div class="md-layer"><img class="checker" src="${esc(a.url)}" style="${place(da)}" alt="" draggable="false"></div>
          <div class="md-layer new"><img class="checker" src="${esc(b.url)}" style="${place(db)}" alt="" draggable="false"></div>
          ${mode === 'swipe' ? '<div class="md-handle"></div>' : ''}
        </div>
        ${mode === 'onion' ? '<input class="md-fade" type="range" min="0" max="100" value="50" title="Fade from the version before to the one after">' : ''}
        <div class="md-legend"><span>${caption(a)}</span><span>${caption(b)}</span></div>
      </div>`;
      bind();
      const stage = box.querySelector('.md-stage'), fade = box.querySelector('.md-fade');
      if (mode === 'swipe') {
        const move = e => {
          const r = stage.getBoundingClientRect();
          stage.style.setProperty('--x', `${Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100))}%`);
        };
        stage.onpointerdown = e => {
          if (e.button) return;
          stage.setPointerCapture(e.pointerId);
          move(e);
          stage.onpointermove = move;
        };
        stage.onpointerup = stage.onpointercancel = () => (stage.onpointermove = null);
      }
      if (fade) fade.oninput = () => stage.style.setProperty('--o', fade.value / 100);
      return;
    }
    mode = 'sides';   // an image that can't be decoded: show each side with its message
  }

  const media = s => (s.error ? `<div class="md-error">${esc(s.error)}</div>` : {
    image: `<img class="checker" src="${esc(s.url)}" alt="">`,
    video: `<video src="${esc(s.url)}" controls preload="metadata"></video>`,
    audio: `<audio src="${esc(s.url)}" controls preload="metadata"></audio>`,
    pdf: `<iframe class="md-pdf" src="${esc(s.url)}"></iframe>`,
    font: '<div class="md-font"></div>',
  }[kind]);
  const sides = [a, b].filter(Boolean);
  box.innerHTML = `${bar()}<div class="md-sides${sides.length > 1 ? '' : ' one'}">${sides.map(s =>
    `<figure class="md-side" data-side="${s.side}"><div class="md-box">${media(s)}</div><figcaption>${caption(s)}</figcaption></figure>`).join('')}</div>`;
  bind();
  for (const s of sides) {
    if (s.error) continue;
    const fig = box.querySelector(`.md-side[data-side="${s.side}"]`);
    const el = fig.querySelector('.md-box > *');
    const update = () => (fig.querySelector('.md-info').textContent = info(s));
    const fail = message => el.replaceWith(Object.assign(document.createElement('div'), { className: 'md-error', textContent: message }));
    if (kind === 'image') {
      el.onload = () => { s.w = el.naturalWidth; s.h = el.naturalHeight; update(); };
      el.onerror = () => fail('This image can\'t be shown here.');
    } else if (kind === 'video' || kind === 'audio') {
      el.onloadedmetadata = () => {
        if (el.videoWidth) { s.w = el.videoWidth; s.h = el.videoHeight; }
        s.duration = el.duration;
        update();
      };
      el.onerror = () => fail(`This ${kind} format can't be played here.`);
    } else if (kind === 'font') {
      fontFamily(s.url).then(family => {
        el.style.fontFamily = `'${family}'`;
        el.innerHTML = `<div style="font-size: 28px">The quick brown fox jumps over the lazy dog</div>
          <div style="font-size: 16px">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 !?&amp;@#%(){}</div>`;
      }, () => fail('This font can\'t be loaded.'));
    }
  }
}

const families = new Map();   // url -> promise of the name of the font loaded from it
function fontFamily(url) {
  if (!families.has(url)) {
    const family = `md-font-${families.size + 1}`;
    families.set(url, new FontFace(family, `url("${url}")`).load().then(face => {
      document.fonts.add(face);
      return family;
    }));
  }
  return families.get(url);
}
