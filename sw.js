/**
 * Service worker for the Final Fantasy MTG Collection Tracker.
 *
 * Goals, in order:
 *   1. The app opens and works with no network (in a card shop, on a plane).
 *   2. A new deploy is picked up promptly rather than being pinned forever.
 *   3. Card images are cached, but with a hard cap so the phone does not end up
 *      storing 1,365 images.
 *
 * BUMP CACHE_VERSION whenever index.html / style.css / app.js / cards_data.js
 * change, otherwise returning visitors keep the old shell until their browser
 * revalidates it.
 */

const CACHE_VERSION = "v12";
const SHELL_CACHE = `ff-tracker-shell-${CACHE_VERSION}`;
const IMAGE_CACHE = `ff-tracker-images-${CACHE_VERSION}`;

/** Opaque cross-origin responses are padded in storage accounting, so keep this modest. */
const MAX_IMAGE_ENTRIES = 250;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "cards_data.js",
  "manifest.webmanifest",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is all-or-nothing; add individually so one missing optional file
      // cannot stop the whole worker from installing.
      .then(cache => Promise.all(SHELL_ASSETS.map(asset =>
        cache.add(new Request(asset, { cache: "reload" })).catch(err => {
          console.warn("[sw] could not precache", asset, err && err.message);
        })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(name => name.startsWith("ff-tracker-") && name !== SHELL_CACHE && name !== IMAGE_CACHE)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;

  // Never interfere with writes. Collection saves are POSTs to Apps Script and
  // must always go to the network - a cached "save" would be a lost save.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Sync traffic is never cached, in either direction. A stale "pull" would
  // silently show the other device's old collection.
  if (url.hostname === "script.google.com" || url.hostname === "script.googleusercontent.com") return;

  // Card images from Scryfall's CDN: cache-first, with an LRU-ish cap.
  if (url.hostname === "cards.scryfall.io" || url.hostname === "svgs.scryfall.io") {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  // Everything else cross-origin (fonts, etc.): let the network handle it.
  if (url.origin !== self.location.origin) return;

  // Page navigations: network-first so a new deploy is seen, cache as fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put("index.html", copy));
          return response;
        })
        .catch(() => caches.match("index.html").then(hit => hit || caches.match("./")))
    );
    return;
  }

  // Same-origin assets: serve from cache immediately, refresh in the background.
  event.respondWith(staleWhileRevalidate(request));
});

function staleWhileRevalidate(request) {
  return caches.open(SHELL_CACHE).then(cache =>
    cache.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

function cacheFirstImage(request) {
  return caches.open(IMAGE_CACHE).then(cache =>
    cache.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Opaque responses (status 0) are still worth caching for offline art.
        if (response && (response.ok || response.type === "opaque")) {
          cache.put(request, response.clone()).then(() => trimCache(cache, MAX_IMAGE_ENTRIES));
        }
        return response;
      });
    })
  );
}

/** Drop the oldest entries once the image cache grows past its cap. */
function trimCache(cache, maxEntries) {
  return cache.keys().then(keys => {
    if (keys.length <= maxEntries) return;
    return Promise.all(
      keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key))
    );
  });
}
