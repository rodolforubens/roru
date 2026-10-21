// The service worker of the web page, which makes it installable as an app (its own window, from
// the browser's "Install" or the account menu) and lets it open offline. The page's own files are
// always asked to the network first, so a reload still gets the version just published; the last
// copy of each one is kept (under its address without the ?v=<commit>, so versions replace each
// other) and used only when the network fails. The account (Supabase) is never cached here.
const CACHE = 'roru-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const keyOf = req => {
  const url = new URL(req.url);
  url.search = '';
  url.hash = '';
  return req.mode === 'navigate' ? new URL('./', self.registration.scope).href : url.href;
};

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(keyOf(req), res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(keyOf(req));
      if (hit) return hit;
      throw err;
    }
  })());
});
