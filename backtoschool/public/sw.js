/* BackToSchool.help push notifications. */
self.addEventListener("push", (event) => {
  let note = { title: "BackToSchool.help", body: "A followed host has an update.", url: "/" };
  try { if (event.data) note = { ...note, ...event.data.json() }; } catch (_) {}
  event.waitUntil(self.registration.showNotification(note.title, {
    body: note.body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: "backtoschool-" + (note.url || ""),
    data: { url: note.url },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    for (const client of clients) {
      if ("navigate" in client) await client.navigate(target).catch(() => {});
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
