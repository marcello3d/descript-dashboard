// Minimal service worker for Web Notification support in Safari dock web apps.
// No offline caching — just enough for Safari to allow the Notification API.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
