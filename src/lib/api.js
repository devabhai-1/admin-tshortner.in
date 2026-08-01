const TOKEN_KEY = 'tshortner_admin_token'

export function getStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setStoredToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export function clearStoredToken() {
  setStoredToken('')
}

/** Backend base URL. Empty = same origin (Vite proxy / Vercel rewrite). */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  const base = String(import.meta.env.VITE_BACKEND_URL ?? '')
    .trim()
    .replace(/\/$/, '')
  return base ? `${base}${p}` : p
}

export function authHeaders(extra = {}) {
  const token = getStoredToken()
  const headers = { ...extra }
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-Admin-Token'] = token
  }
  return headers
}

export async function apiFetch(path, options = {}) {
  const headers = authHeaders(
    options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) },
  )
  const res = await fetch(apiUrl(path), {
    ...options,
    credentials: 'include',
    headers,
  })
  if (res.status === 401) {
    clearStoredToken()
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login')
    }
  }
  return res
}

/** EventSource cannot set Authorization headers — append access_token query param. */
export function apiStreamUrl(path) {
  const token = getStoredToken()
  const url = apiUrl(path)
  if (!token) return url
  const join = url.includes('?') ? '&' : '?'
  return `${url}${join}access_token=${encodeURIComponent(token)}`
}
