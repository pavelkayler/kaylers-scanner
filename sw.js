// Keeps the app usable offline. One release = one cache, filled completely at install and never changed afterwards,
// so a page always runs index.html, scripts and wasm of the same release. A new release (new CACHE name) installs in the
// background and waits; the page offers "Update now" (message "skipWaiting"), otherwise it takes over at the next cold start.
// The app sends nothing anywhere.
// keep in step with the version shown in the header of index.html
const CACHE = "cs-app-v59";
const FILES = ["index.html", "common.js", "platform.js", "portrait.js", "navigation.js", "vendor/html5-qrcode.min.js", "vendor/xlsx.full.min.js",
  "vendor/zxing-reader.js", "vendor/zxing_reader.wasm",
  "manifest.webmanifest", "icon-180.png", "icon-512.png"];
// pages linked from About; they open offline too
const PAGES = ["privacy.html", "support.html", "licenses.html"];
// cache: "reload" skips the browser's HTTP cache (GitHub Pages sends max-age=600), so a new version never stores old files.
// If any file fails, install fails and the previous release stays in use untouched.
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.concat(PAGES).map(f => new Request(f, { cache: "reload" }))))); });
self.addEventListener("message", e => { if(e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if(e.request.method !== "GET" || url.origin !== location.origin) return;
  // the app's own folder: "/" when served by the PC, "/kaylers-scanner/" on GitHub Pages
  const home = new URL(self.registration.scope).pathname;
  const page = PAGES.find(p => url.pathname === home + p);
  if(e.request.mode === "navigate" && !page && ![home, home + "index.html"].includes(url.pathname)) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = e.request.mode === "navigate" ? page || "index.html" : e.request;
    const hit = await c.match(key, { ignoreSearch: true });
    if(hit) return hit;
    // not part of the release (should not happen for app files): from the network, never stored into the release
    const fresh = await fetch(e.request.mode === "navigate" ? page || "index.html" : e.request.url, { cache: "no-cache" }).catch(() => null);
    return fresh || new Response("Offline: this app file is not available yet. Connect to the internet and open the app again.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
