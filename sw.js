// Two jobs:
// 1. Receive what Android's share sheet sends (photos, selected text). A static site cannot handle a POST, so the worker
//    stores the shared files in a cache and redirects to the page, which reads them from there.
// 2. Network-first cache for the app itself, so updates show up straight away and the page still opens offline.
const CACHE = 'cc-v1';
const SHARED = 'cc-shared';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARED).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARED);
  for (const key of await cache.keys()) await cache.delete(key);

  const files = form.getAll('cards').filter((f) => f instanceof File && f.size > 0);
  let i = 0;
  for (const file of files) {
    await cache.put(`shared/image-${i++}`, new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
  }
  const text = ['title', 'text', 'url']
    .map((k) => String(form.get(k) || '').trim())
    .filter(Boolean)
    .join('\n');
  if (text) await cache.put('shared/text', new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));

  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  const url = new URL(r.url);
  if (r.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(r).catch(() => Response.redirect(new URL('./', self.registration.scope).href, 303)));
    return;
  }
  if (r.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(r, copy));
        }
        return res;
      })
      .catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || caches.match('./'))),
  );
});
