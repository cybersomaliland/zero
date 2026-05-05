const CACHE = "zero-v1";
const ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/maskable.svg"];
let notificationData = { upcomingCount: 0 };

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data?.type === "UPDATE_NOTIFICATION_DATA") {
    notificationData = { ...notificationData, ...(event.data.payload ?? {}) };
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag !== "zero-daily-check") return;
  event.waitUntil(
    self.registration.showNotification("Zero daily check-in", {
      body: notificationData.upcomingCount > 0
        ? `You have ${notificationData.upcomingCount} upcoming bill(s). Review your safe-to-spend today.`
        : "Take 30 seconds to review today's spending and safe-to-spend.",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "zero-daily",
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow(target);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match("/index.html"));
    }),
  );
});
