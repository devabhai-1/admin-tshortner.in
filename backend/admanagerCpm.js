import { GoogleAuth } from 'google-auth-library'

const SCOPE = 'https://www.googleapis.com/auth/admanager'
const API = 'https://admanager.googleapis.com/v1'
const CACHE_MS = 3 * 60 * 60 * 1000
const REPORT_NAME = 'tshortner country cpm'

let memory = null
let inflight = null

function metricNumber(value) {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value) || 0
  if (value.doubleValue != null) return Number(value.doubleValue) || 0
  if (value.intValue != null) return Number(value.intValue) || 0
  if (value.stringValue != null && value.stringValue !== '') return Number(value.stringValue) || 0
  const money = value.moneyValue || value.money
  if (money) {
    return Number(money.units || 0) + Number(money.nanos || 0) / 1e9
  }
  return 0
}

function asMoney(n) {
  const value = Number(n) || 0
  if (Math.abs(value) >= 100000) return value / 1e6
  return value
}

function friendlyError(err) {
  const reason = String(err.reason || '')
  if (reason.includes('NO_NETWORKS_TO_ACCESS') || reason.includes('AUTHENTICATION_FAILED')) {
    return 'Ad Manager ne is service account ko network par allow nahi kiya. Admin → Users → Add a service account user se analytics@concise-emblem-480601-b8.iam.gserviceaccount.com add karo, API access On karke Save dabao.'
  }
  return err.message || 'Ad Manager report fail ho gayi'
}

async function gam(access, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const details = json?.error?.details || []
    const reason = details.find((item) => item.reason)?.reason
      || details[0]?.fieldViolations?.[0]?.reason
      || json?.error?.status
      || ''
    const err = new Error(json?.error?.message || `Ad Manager ${res.status}`)
    err.reason = reason
    err.status = res.status
    throw err
  }
  return json
}

async function accessToken(credentials) {
  const auth = new GoogleAuth({ credentials, scopes: [SCOPE] })
  const client = await auth.getClient()
  const token = await client.getAccessToken()
  return typeof token === 'string' ? token : token?.token
}

async function readCache(db) {
  if (!db) return memory
  try {
    const snap = await db.ref('admanagerCpm/latest').once('value')
    return snap.val() || memory
  } catch {
    return memory
  }
}

async function writeCache(db, payload) {
  memory = payload
  if (!db) return
  try {
    await db.ref('admanagerCpm/latest').set(payload)
  } catch (err) {
    console.error('admanager cache write', err.message)
  }
}

async function savedReportName(db) {
  if (!db) return ''
  try {
    const snap = await db.ref('admanagerCpm/reportName').once('value')
    return String(snap.val() || '')
  } catch {
    return ''
  }
}

async function ensureReport(access, network, db) {
  const existing = await savedReportName(db)
  if (existing) return existing
  const created = await gam(access, 'POST', `${API}/networks/${network}/reports`, {
    displayName: REPORT_NAME,
    reportDefinition: {
      dimensions: ['COUNTRY_CODE', 'COUNTRY_NAME'],
      metrics: ['AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM'],
      dateRange: { relative: 'LAST_7_DAYS' },
      reportType: 'HISTORICAL',
      currencyCode: 'INR',
    },
  })
  const name = created.name
  if (db && name) {
    try { await db.ref('admanagerCpm/reportName').set(name) } catch { /* ignore */ }
  }
  return name
}

async function runAndFetch(access, reportName) {
  const started = await gam(access, 'POST', `${API}/${reportName}:run`)
  let op = started
  for (let i = 0; i < 24 && !op.done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    op = await gam(access, 'GET', `${API}/${started.name}`)
  }
  if (!op.done) throw new Error('Ad Manager report abhi complete nahi hui. Thodi der baad refresh karo.')
  if (op.error) throw new Error(op.error.message || 'Ad Manager report error')
  const resultName = op.response?.reportResult
  if (!resultName) throw new Error('Ad Manager ne result nahi diya')

  const countries = {}
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=500&pageToken=${encodeURIComponent(pageToken)}` : '?pageSize=500'
    const page = await gam(access, 'GET', `${API}/${resultName}:fetchRows${query}`)
    for (const row of page.rows || []) {
      const code = String(row.dimensionValues?.[0]?.stringValue || row.dimensionValues?.[0]?.value || '').trim().toUpperCase()
      const name = String(row.dimensionValues?.[1]?.stringValue || row.dimensionValues?.[1]?.value || code)
      const values = row.metricValueGroups?.[0]?.primaryValues || []
      if (!code) continue
      const impressions = metricNumber(values[0])
      const revenue = asMoney(metricNumber(values[1]))
      let ecpm = asMoney(metricNumber(values[2]))
      if (!ecpm && impressions > 0 && revenue > 0) ecpm = (revenue / impressions) * 1000
      countries[code] = {
        code,
        name,
        impressions,
        revenue: Math.round(revenue * 100) / 100,
        ecpm: Math.round(ecpm * 100) / 100,
      }
    }
    pageToken = page.nextPageToken || ''
  } while (pageToken)

  return countries
}

async function loadCountryCpm({ credentials, db, networkCode, force }) {
  const cached = await readCache(db)
  if (!force && cached?.fetchedAt && Date.now() - cached.fetchedAt < CACHE_MS && cached.countries) {
    return { ...cached, cached: true }
  }
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Analytics service account missing')
  }
  const network = String(networkCode || '23113214187')
  try {
    const access = await accessToken(credentials)
    const reportName = await ensureReport(access, network, db)
    const countries = await runAndFetch(access, reportName)
    const payload = {
      fetchedAt: Date.now(),
      currency: 'INR',
      range: 'LAST_7_DAYS',
      network,
      countries,
      error: '',
    }
    await writeCache(db, payload)
    return { ...payload, cached: false }
  } catch (err) {
    if (cached?.countries) {
      return { ...cached, cached: true, error: friendlyError(err) }
    }
    err.message = friendlyError(err)
    throw err
  }
}

export function getCountryCpm(options) {
  if (inflight) return inflight
  inflight = loadCountryCpm(options).finally(() => {
    inflight = null
  })
  return inflight
}
