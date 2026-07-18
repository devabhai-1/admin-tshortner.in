/**
 * Firebase RTDB schema aligned with tshortner site (src/firebase/utils.js).
 * users/{emailKey}/dashboard.daily[date] = { impressions, cpm, earning }
 * emailKey = email with "." replaced by ","
 */
export const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
export const toFixed2 = (n) => Number(safeNum(n).toFixed(2))

/** Site: email.replace(/\./g, ",") — legacy admin used "_" */
export function encodeEmailKey(email) {
  return (email || '').replace(/\./g, ',')
}

export function decodeEmailKey(key) {
  if (!key) return ''
  if (key.includes(',')) return key.replace(/,/g, '.')
  return key.replace(/_/g, '.')
}

export function getEarningFromRow(row) {
  if (!row || typeof row !== 'object') return 0
  return safeNum(row.earning ?? row.earnings)
}

/** Normalize one day row for admin UI + site writes */
export function normalizeDailyRow(row) {
  if (!row || typeof row !== 'object') {
    return { impressions: 0, earning: 0, cpm: 0 }
  }
  const impressions = safeNum(row.impressions)
  const earning = toFixed2(row.earning ?? row.earnings ?? 0)
  let cpm = safeNum(row.cpm)
  if (!cpm && impressions > 0 && earning > 0) {
    cpm = toFixed2((earning / impressions) * 1000)
  }
  return { impressions, earning, cpm }
}

/** Read daily map from dashboard (site `daily` + legacy `dailyStats`) */
export function readDailyMap(dashboard) {
  const dash = dashboard || {}
  const raw = { ...(dash.dailyStats || {}), ...(dash.daily || {}) }
  const out = {}
  for (const [date, row] of Object.entries(raw)) {
    out[date] = normalizeDailyRow(row)
  }
  return out
}

/** Totals for site dashboard fields + admin summary labels */
export function buildDashboardTotals(dailyMap) {
  const today = new Date().toISOString().split('T')[0]
  let totalImpressions = 0
  let totalEarning = 0
  let todayImpressions = 0
  let dailyEarning = 0
  let dailyCPM = 0

  for (const [date, row] of Object.entries(dailyMap || {})) {
    const im = safeNum(row.impressions)
    const er = getEarningFromRow(row)
    totalImpressions += im
    totalEarning += er
    if (date === today) {
      todayImpressions = im
      dailyEarning = er
      dailyCPM = safeNum(row.cpm) || (im > 0 && er > 0 ? toFixed2((er / im) * 1000) : 0)
    }
  }

  const overallCPM =
    totalImpressions > 0 && totalEarning > 0
      ? toFixed2((totalEarning / totalImpressions) * 1000)
      : 0

  return {
    dailyEarning: toFixed2(dailyEarning),
    dailyCPM: toFixed2(dailyCPM),
    totalEarning: toFixed2(totalEarning),
    totalImpressions,
    overallCPM,
    // Admin UI aliases
    totalEarnings: toFixed2(totalEarning),
    totalAvailable: toFixed2(totalEarning),
    todayImpressions,
    currentCPM: overallCPM,
  }
}

/** Firebase multi-path update for one user + date */
export function dashboardUpdatePaths(emailKey, date, row, dailyMap) {
  const day = normalizeDailyRow(row)
  const totals = buildDashboardTotals(dailyMap)
  const base = `users/${emailKey}/dashboard`
  return {
    [`${base}/daily/${date}`]: day,
    [`${base}/dailyEarning`]: totals.dailyEarning,
    [`${base}/dailyCPM`]: totals.dailyCPM,
    [`${base}/totalEarning`]: totals.totalEarning,
    [`${base}/totalImpressions`]: totals.totalImpressions,
    [`${base}/overallCPM`]: totals.overallCPM,
  }
}
