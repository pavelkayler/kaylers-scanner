// Keeps the app usable with no connection to the PC: app files come from the cache,
// refreshed in the background whenever the PC is reachable. The app sends nothing to the PC.
// keep in step with the version shown in the header of index.html
const CACHE = "cs-app-v20";
const FILES = ["index.html", "common.js", "vendor/html5-qrcode.min.js", "vendor/xlsx.full.min.js",
  "vendor/zxing-reader.js", "vendor/zxing_reader.wasm",
  "manifest.webmanifest", "icon-180.png", "icon-512.png"];
// text recognition (vendor/tesseract, ~7 MB as used): kept in its own cache across app versions, read cache-first
const OCR_CACHE = "cs-ocr-v1";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== OCR_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if(e.request.method !== "GET" || url.origin !== location.origin) return;
  // the app's own folder: "/" when served by the PC, "/kaylers-scanner/" on GitHub Pages
  const home = new URL(self.registration.scope).pathname;
  if(e.request.mode === "navigate" && ![home, home + "index.html"].includes(url.pathname)) return;
  if(url.pathname.includes("/vendor/tesseract/")){
    e.respondWith(caches.open(OCR_CACHE).then(async c => (await c.match(e.request)) ||
      fetch(e.request).then(r => { if(r.ok && !r.redirected) c.put(e.request, r.clone()); return r; })));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = e.request.mode === "navigate" ? "index.html" : e.request;
    const hit = await c.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request.mode === "navigate" ? "index.html" : e.request).then(r => { if(r.ok && !r.redirected) c.put(key, r.clone()); return r; }).catch(() => null);
    return hit || (await fresh) || new Response("Нет связи с ПК", { status: 503 });
  }));
});
