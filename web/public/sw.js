/**
 * Offline service worker.
 *
 * The precache list is injected by `oneframework build web` after Vite runs, so the
 * multi-megabyte Pyodide runtime, the Python bundle and the app shell are all
 * cached on install. After the first load the app starts with no network at all.
 */

const CACHE = "oneframework-__BUILD_ID__";
const ASSETS = /*__ASSETS__*/ [];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add individually: one bad URL must not abort the whole precache.
      await Promise.all(
        ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[sw] precache miss", url, err);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      // `ignoreVary` matters: dev/preview servers answer with `Vary: Origin`,
      // and the precache stored these responses against requests that carried
      // no Origin header. Without it every module/stylesheet request misses the
      // cache and the app fails to start offline.
      const cached = await caches.match(request, {
        ignoreSearch: true,
        ignoreVary: true,
      });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Offline navigation falls back to the app shell.
        if (request.mode === "navigate") {
          const shell = await caches.match("./index.html", {
            ignoreSearch: true,
            ignoreVary: true,
          });
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
});
