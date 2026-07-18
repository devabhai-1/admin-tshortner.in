/** Backend base URL. Empty = same origin (Vite dev proxy → Python). */
export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  const base = String(import.meta.env.VITE_BACKEND_URL ?? '')
    .trim()
    .replace(/\/$/, '')
  return base ? `${base}${p}` : p
}
