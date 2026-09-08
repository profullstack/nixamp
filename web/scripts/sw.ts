/**
 * The service worker, generated at build time.
 *
 * Written as a source string rather than a bundled entry because the one thing
 * it must know — the exact list of hashed files Vite emitted — does not exist
 * until the build is over. Workbox does this too; this is the twenty lines of
 * it that a player needs.
 */

/** Requests that must never come from a cache, whatever else is going on. */
export const NEVER_CACHE = ["/api/"];

export function serviceWorkerSource(files: string[], version: string): string {
  const precache = unique(["/", "/index.html", ...files]);
  return `/* nixamp service worker — generated, do not edit */
const CACHE = "nixamp-${version}";
const PRECACHE = ${JSON.stringify(precache, null, 2)};
const NEVER_CACHE = ${JSON.stringify(NEVER_CACHE)};

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One miss must not fail the whole install, or a single 404 leaves the app
    // with no offline shell at all.
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

// A broadcaster somebody follows went live. This is the same code path for a
// browser tab, an installed PWA and the desktop app: all three are a push
// subscription, and none of them has to be open to receive one.
self.addEventListener("push", (event) => {
  // A push with no payload is still a push. Showing something beats showing
  // nothing, and some services strip the body.
  let note = { title: "nixamp", body: "Someone you follow is live.", url: "/directory" };
  try {
    if (event.data) note = { ...note, ...event.data.json() };
  } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(note.title, {
      body: note.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // Tagged by destination so a second notification about the same stream
      // replaces the first rather than stacking up behind it.
      tag: "nixamp-live-" + (note.url || ""),
      renotify: false,
      data: { url: note.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/directory";
  event.waitUntil((async () => {
    // Focus a window we already have rather than opening a fourth copy of the
    // app, which is what happens if you just call openWindow every time.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        if ("navigate" in client) await client.navigate(target).catch(() => {});
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The control API and the media it streams are live state, never a cache.
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    // Network first, so a deploy lands; the shell answers when there is no network.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put("/index.html", fresh.clone());
        return fresh;
      } catch {
        return (await caches.match("/index.html")) ?? (await caches.match("/")) ?? Response.error();
      }
    })());
    return;
  }

  // Everything else is a hashed asset or an icon: cache first, refreshed behind.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      event.waitUntil(refresh(request));
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      return Response.error();
    }
  })());
});

async function refresh(request) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok && fresh.type === "basic") {
      const cache = await caches.open(CACHE);
      await cache.put(request, fresh);
    }
  } catch {
    /* offline: the cached copy stands */
  }
}
`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
