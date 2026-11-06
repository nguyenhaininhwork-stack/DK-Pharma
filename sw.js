// Service Worker: phục vụ các file của gói SCORM (đã giải nén vào Cache Storage)
// dưới đường dẫn ./pkg/<id>/<đường-dẫn-file>
const CACHE = 'scorm-packages-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  if (!url.pathname.startsWith(scope.pathname + 'pkg/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const clean = url.origin + url.pathname; // bỏ query/hash
    let res = await cache.match(clean);
    if (!res) {
      // thử dạng chuẩn hoá encode/decode khác nhau
      try {
        const decoded = decodeURIComponent(url.pathname);
        const reencoded = decoded.split('/').map(encodeURIComponent).join('/');
        res = (await cache.match(url.origin + reencoded)) || (await cache.match(url.origin + decoded));
      } catch (_) { /* ignore */ }
    }
    if (!res) {
      // thử khớp không phân biệt hoa thường (gói tạo trên Windows hay sai hoa/thường)
      const want = decodeURIComponent(url.pathname).toLowerCase();
      for (const req of await cache.keys()) {
        if (decodeURIComponent(new URL(req.url).pathname).toLowerCase() === want) {
          res = await cache.match(req);
          break;
        }
      }
    }
    return res || new Response('Không tìm thấy file trong gói SCORM: ' + url.pathname, {
      status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
