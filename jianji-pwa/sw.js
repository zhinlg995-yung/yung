'use strict';
const CACHE_NAME = 'jianji-shell-v6';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const urls = ASSETS.map(path => new URL(path, self.registration.scope).toString());
    // cache: 'reload' 绕过浏览器 HTTP 缓存，确保拿到最新文件
    await Promise.all(urls.map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error('缓存失败：' + url);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('jianji-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        const cache = await caches.open(CACHE_NAME);
        cache.put(new URL('./index.html', self.registration.scope), response.clone()).catch(() => {});
        return response;
      } catch (_) {
        return (await caches.match(new URL('./index.html', self.registration.scope))) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_) {
      return cached || Response.error();
    }
  })());
});
