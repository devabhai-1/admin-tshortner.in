import { buildDashboardTotals, readDailyMap } from './tshortnerSchema.js'
import { safeNum } from './utils.js'

/**
 * Dashboard totals — jab daily/{date} data ho to WAHI source of truth.
 * Stale totalEarning / totalAvailable / totalEarnings fields ignore
 * (e.g. daily sum $42 but totalAvailable $323 → use $42).
 */
export function dashboardSummary(dashboard) {
  const d = dashboard || {}
  const daily = readDailyMap(d)
  const hasDaily = Object.keys(daily).length > 0

  if (hasDaily) {
    const t = buildDashboardTotals(daily)
    return {
      totalImpressions: t.totalImpressions,
      totalEarnings: t.totalEarnings,
      todayImpressions: t.todayImpressions,
      currentCPM: t.currentCPM,
      totalAvailable: t.totalAvailable,
      fromDaily: true,
      storedTotalEarning: safeNum(d.totalEarning ?? d.totalEarnings),
      storedTotalAvailable: safeNum(d.totalavailable ?? d.totalAvailable),
    }
  }

  const totalEarnings = safeNum(d.totalEarnings ?? d.totalEarning)
  const totalImpressions = safeNum(d.totalImpressions)
  const todayImpressions = safeNum(d.todayImpressions)
  const currentCPM = safeNum(d.currentCPM ?? d.overallCPM)
  const totalAvailable = safeNum(
    d.totalavailable ?? d.totalAvailable ?? d.totalEarning ?? d.totalEarnings,
  )

  return {
    totalImpressions,
    totalEarnings,
    todayImpressions,
    currentCPM,
    totalAvailable,
    fromDaily: false,
    storedTotalEarning: totalEarnings,
    storedTotalAvailable: totalAvailable,
  }
}

/**
 * इनमें से कोई भी 0 से बड़ा हो → डिलीट मना (Total Impressions, Total Earnings,
 * Today Impressions, CPM — और Total Available भी).
 */
export function hasProtectedSummaryMetrics(dashboard) {
  if (!dashboard || typeof dashboard !== 'object') return false
  const s = dashboardSummary(dashboard)
  return (
    s.totalImpressions > 0 ||
    s.totalEarnings > 0 ||
    s.todayImpressions > 0 ||
    s.currentCPM > 0 ||
    s.totalAvailable > 0
  )
}

/** किसी दिन daily stat में impression या earning > 0 */
export function hasMeaningfulDailyStats(dashboard) {
  if (!dashboard || typeof dashboard !== 'object') return false
  const daily = readDailyMap(dashboard)
  for (const row of Object.values(daily)) {
    if (safeNum(row.impressions) > 0) return true
    if (safeNum(row.earning) > 0 || safeNum(row.earnings) > 0) return true
  }
  return false
}

/**
 * UI / टैग: कोई भी रियल डेटा है या नहीं
 */
export function hasMeaningfulDashboardData(dashboard) {
  return hasProtectedSummaryMetrics(dashboard) || hasMeaningfulDailyStats(dashboard)
}

/**
 * सिर्फ तभी true जब Firebase से पूरा dashboard हटाना सुरक्षित हो —
 * न तो summary में कुछ > 0, न ही daily में।
 */
export function isSafeToRemoveDashboard(dashboard) {
  if (!dashboard || typeof dashboard !== 'object') return false
  if (hasProtectedSummaryMetrics(dashboard)) return false
  if (hasMeaningfulDailyStats(dashboard)) return false
  return true
}
