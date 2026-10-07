// This worker only displays opt-in Duck alerts. It does not intercept or
// cache page requests, especially authenticated pages and API responses.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Ignore malformed payloads. */ }
  const body = [
    "A Duck replied.",
    "A Duck needs your attention.",
    "An approval needs your attention.",
    "A Duck run ended with a problem.",
  ].includes(data.body) ? data.body : "A Duck update is ready.";
  const path = typeof data.path === "string" &&
    /^\/w\/[0-9a-f-]{36}\/inbox$/i.test(data.path)
      ? data.path : "/";
  event.waitUntil(self.registration.showNotification("TameDuck", {
    body,
    icon: "/favicon.svg",
    data: { path },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path || "/";
  const destination = new URL(path, self.location.origin);
  if (destination.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(destination.href);
      return existing.focus();
    }
    return clients.openWindow(destination.href);
  })());
});
