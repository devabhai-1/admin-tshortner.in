import crypto from 'crypto'

const TOKEN_TTL_SEC = Number(process.env.ADMIN_TOKEN_TTL_SEC || 60 * 60 * 12) // 12h
const COOKIE_NAME = 'tshortner_admin_token'

function requireEnv(name) {
  const v = process.env[name]
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env: ${name}`)
  }
  return String(v)
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET
  if (!secret || !String(secret).trim()) {
    throw new Error('Missing required env: JWT_SECRET')
  }
  return String(secret)
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  return buf.toString('base64url')
}

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) {
    // Still compare equal-length buffers to reduce timing leakage of length.
    const dummy = Buffer.alloc(left.length)
    crypto.timingSafeEqual(left, dummy)
    return false
  }
  return crypto.timingSafeEqual(left, right)
}

export function credentialsConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && (process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET))
}

export function verifyAdminCredentials(username, password) {
  const expectedUser = requireEnv('ADMIN_USERNAME')
  const expectedPass = requireEnv('ADMIN_PASSWORD')
  const userOk = timingSafeEqualStr(username, expectedUser)
  const passOk = timingSafeEqualStr(password, expectedPass)
  return userOk && passOk
}

export function signAdminToken(extra = {}) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(
    JSON.stringify({
      role: 'admin',
      sub: process.env.ADMIN_USERNAME,
      iat: now,
      exp: now + TOKEN_TTL_SEC,
      jti: crypto.randomBytes(16).toString('hex'),
      ...extra,
    }),
  )
  const data = `${header}.${payload}`
  const sig = crypto.createHmac('sha256', getJwtSecret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || token.split('.').length !== 3) return null
  const [header, payload, signature] = token.split('.')
  const data = `${header}.${payload}`
  const expected = crypto.createHmac('sha256', getJwtSecret()).update(data).digest('base64url')
  if (!timingSafeEqualStr(signature, expected)) return null
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!body || body.role !== 'admin') return null
    if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null
    return body
  } catch {
    return null
  }
}

export function getCookie(req, name = COOKIE_NAME) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    if (key === name) return decodeURIComponent(trimmed.slice(eq + 1))
  }
  return null
}

export function extractToken(req) {
  const auth = req.headers.authorization || ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  const headerToken = req.headers['x-admin-token']
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim()

  // EventSource cannot set headers — allow query token only on SSE stream routes.
  const path = String(req.path || req.url || '')
  const isStream =
    path.includes('/analytics/stream') || path.endsWith('/analytics') // /api/analytics is also SSE in this app
  if (isStream && typeof req.query?.access_token === 'string' && req.query.access_token.trim()) {
    return req.query.access_token.trim()
  }
  return getCookie(req)
}

export function setAuthCookie(res, token) {
  const secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${TOKEN_TTL_SEC}`,
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function clearAuthCookie(res) {
  const secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function requireAuth(req, res, next) {
  try {
    if (!credentialsConfigured()) {
      return res.status(503).json({ error: 'Admin auth is not configured on the server' })
    }
    const token = extractToken(req)
    const payload = verifyAdminToken(token)
    if (!payload) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' })
    }
    req.admin = payload
    return next()
  } catch (e) {
    return res.status(503).json({ error: e.message || 'Auth error' })
  }
}

export { COOKIE_NAME, TOKEN_TTL_SEC }
