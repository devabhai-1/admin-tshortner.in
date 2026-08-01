// Service Worker - TShortner Admin PWA
const CACHE_NAME = 'tshortner-admin-v5-shell'

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

/** SPA client routes like /login, /ga4 — no file extension */
function isSpaPath(path) {
  if (!path || path === '/') return true
  const last = path.split('/').pop() || ''
  return !last.includes('.')
}

function offlineResponse(message = 'Offline') {
  return new Response(message, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

async function spaShellFallback() {
  const cached = (await caches.match('/index.html')) || (await caches.match('/'))
  return cached || offlineResponse('App shell unavailable')
}

async function networkThenShell(request) {
  try {
    const res = await fetch(request)
    // Vercel rewrite serves index.html for SPA routes — use it when OK
    if (res && res.ok) return res
  } catch {
    /* network / SSO blip */
  }
  return spaShellFallback()
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

  // Let browser handle SW script itself
  if (path === '/sw.js') return

  // Hashed assets: network only, soft fail (no Response.error())
  if (path.startsWith('/assets/')) {
    event.respondWith(
      fetch(event.request).catch(() => offlineResponse('Asset unavailable')),
    )
    return
  }

  // Navigations + SPA routes (/login, /ga4, …) → always fall back to app shell
  if (event.request.mode === 'navigate' || event.request.destination === 'document' || isSpaPath(path)) {
    event.respondWith(networkThenShell(event.request))
    return
  }

  // Precached static files
  if (PRECACHE_URLS.includes(path)) {
    event.respondWith(
      caches.match(event.request).then(async (cached) => {
        try {
          const response = await fetch(event.request)
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
          }
          return response
        } catch {
          return cached || offlineResponse('Resource unavailable')
        }
      }),
    )
    return
  }

  // Everything else: network, never Response.error()
  event.respondWith(fetch(event.request).catch(() => offlineResponse('Unavailable')))
})
