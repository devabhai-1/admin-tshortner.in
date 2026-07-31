// Service Worker - TShortner Admin PWA
const CACHE_NAME = 'tshortner-admin-v3-shell'

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/apple-touch-icon.png',
]

function isSameOrigin(url) {
  return url.origin === self.location.origin
}

function isFirebaseOrExternal(url) {
  const u = url.href
  return (
    u.includes('firebase') ||
    u.includes('googleapis') ||
    u.includes('gstatic') ||
    (u.startsWith('http') && !u.startsWith(self.location.origin))
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(PRECACHE_URLS.map((path) => new Request(path, { cache: 'reload' }))),
      )
      .catch((err) => console.error('SW precache failed', err)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name)
        }),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)
  if (!isSameOrigin(url) || isFirebaseOrExternal(url)) return

  const path = url.pathname

  // Never intercept API / SSE
  if (path.startsWith('/api/')) return

  if (path.startsWith('/assets/') || path === '/sw.js') {
    event.respondWith(fetch(event.request).catch(() => Response.error()))
    return
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html').then((r) => r || caches.match('/') || Response.error()),
      ),
    )
    return
  }

  const precachePath = PRECACHE_URLS.includes(path) || path === '/index.html'
  if (!precachePath) {
    event.respondWith(fetch(event.request).catch(() => Response.error()))
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const responseToCache = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache))
          }
          return response
        })
        .catch(() => cached || Response.error())
    }),
  )
})
