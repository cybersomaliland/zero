const CACHE = "zero-v4-zero-mark-icon";
const ASSETS = ["/", "/index.html", "/manifest.webmanifest?v=ios4", "/icon.svg?v=ios4", "/maskable.svg?v=ios4"];
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
  if (event.data?.type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
    );
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

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Zero reminder";
  const options = {
    body: payload.body || "Open Zero to review your money and routine.",
    icon: payload.icon || "/icon.svg",
    badge: typeof payload.badge === "string" ? payload.badge : "/icon.svg",
    tag: payload.tag || "zero-push",
    data: { url: payload.url || "/" },
  };
  const rawBadge = payload.badgeCount ?? (typeof payload.badge === "number" ? payload.badge : null);
  const badgeCount = typeof rawBadge === "number" && Number.isFinite(rawBadge) ? Math.round(rawBadge) : null;

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if (badgeCount === null) return;
      try {
        if (!("setAppBadge" in navigator)) return;
        if (badgeCount <= 0) {
          if ("clearAppBadge" in navigator) await navigator.clearAppBadge();
          return;
        }
        await navigator.setAppBadge(badgeCount);
      } catch {
        // ignore
      }
    })(),
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
