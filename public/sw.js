/*
 * Arcadia Home service worker. Deliberately small:
 * - Caches only build assets that are public and content-hashed (/_next/static, icons,
 *   fonts) and one static offline page.
 * - Never caches pages, server action or RSC responses, API routes, receipts, reports or
 *   anything marked private or no-store. Financial data stays out of every cache.
 * - Offline navigations get the offline page; nothing pretends to have been saved.
 */
const VERSION = "v1";
const STATIC = `arcadia-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll([OFFLINE_URL, "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("arcadia-") && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStaticAsset = (url) =>
  url.origin === self.location.origin && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname === OFFLINE_URL);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // server actions, uploads: straight to the network
  const url = new URL(req.url);

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const cc = res.headers.get("cache-control") || "";
            if (res.ok && !/private|no-store/.test(cc)) {
              const copy = res.clone();
              caches.open(STATIC).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: always the network; if it's unreachable, the offline page (never a cached page).
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
  }
  // Everything else (RSC, API, receipts, reports) isn't intercepted at all.
});
