// Where the app runs: the desktop app (Tauri), whose backend runs git, reads the folders and keeps
// the notes, or the web page in a browser, which has no backend: there, only what is kept in the
// account (the projects and their links) is available, and Git, the folders and the notes stay in
// the desktop app. Modules call the backend through `invoke` from here, never `window.__TAURI__`.
const tauri = window.__TAURI__;

export const desktop = !!tauri;

// In the browser, the few commands that make sense on the web are done here; the others fail.
function webInvoke(cmd, args = {}) {
  if (cmd === 'open_url' && /^(https?|mailto):/i.test(args.url || '')) {
    window.open(args.url, '_blank', 'noopener');
    return Promise.resolve();
  }
  return Promise.reject(new Error('Only available in the desktop app'));
}

export const invoke = desktop ? tauri.core.invoke : webInvoke;
export const convertFileSrc = desktop ? tauri.core.convertFileSrc : src => src;

if (!desktop) document.documentElement.classList.add('web');

// A phone, or a window as narrow as one: the app shows one screen at a time (see mobile.js).
const narrow = matchMedia('(max-width: 640px)');
export const isMobile = () => narrow.matches;
export const onMobileChange = fn => narrow.addEventListener('change', () => fn(narrow.matches));
// There the page doesn't zoom, like an app: the viewport can't be scaled (which also stops the zoom
// into a focused text field; the desktop's zoom, with Ctrl, is the webview's own and stays), touches
// only pan (styles.css), and Safari, which ignores user-scalable, has its pinch gestures stopped.
const viewport = document.querySelector('meta[name="viewport"]');
const baseViewport = viewport?.content || 'width=device-width, initial-scale=1';
const markMobile = () => {
  document.documentElement.classList.toggle('mobile', narrow.matches);
  if (viewport) viewport.content = narrow.matches ? `${baseViewport}, minimum-scale=1, maximum-scale=1, user-scalable=no` : baseViewport;
};
markMobile();
narrow.addEventListener('change', markMobile);
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, e => { if (narrow.matches) e.preventDefault(); }, { passive: false });
}
