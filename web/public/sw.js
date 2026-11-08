// FRC Packs service worker: makes the site installable as an app and shows push notifications (free pack ready,
// trade offers). It doesn't cache pages: packs, timers and trades are always live from the server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(msg.title || "FRC Packs", {
      body: msg.body || "",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      tag: msg.tag || "frc-packs",
      renotify: !!msg.tag,
      data: { url: msg.url || "/" },
    }),
    // An open app catches up straight away (a trade accepted, a new offer).
    self.clients.matchAll({ type: "window" }).then((ws) => ws.forEach((w) => w.postMessage({ type: "push", tag: msg.tag || "" }))),
  ]));
});

// Tapping a notification brings an open FRC Packs window forward (on the right screen), or opens one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url).catch(() => {}); }
    }
    return self.clients.openWindow(url);
  })());
});
