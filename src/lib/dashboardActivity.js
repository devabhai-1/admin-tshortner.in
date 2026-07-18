import { buildDashboardTotals, readDailyMap } from './tshortnerSchema.js'
import { safeNum } from './utils.js'

export function dashboardSummary(dashboard) {
  const d = dashboard || {}
  let totalEarnings = safeNum(d.totalEarnings ?? d.totalEarning)
  let totalImpressions = safeNum(d.totalImpressions)
  let todayImpressions = safeNum(d.todayImpressions)
  let currentCPM = safeNum(d.currentCPM ?? d.overallCPM)
  let totalAvailable = safeNum(d.totalavailable ?? d.totalAvailable ?? d.totalEarning ?? d.totalEarnings)

  const daily = readDailyMap(d)
  if (Object.keys(daily).length > 0) {
    const t = buildDashboardTotals(daily)
    if (totalEarnings <= 0) totalEarnings = t.totalEarnings
    if (totalImpressions <= 0) totalImpressions = t.totalImpressions
    if (todayImpressions <= 0) todayImpressions = t.todayImpressions
    if (currentCPM <= 0) currentCPM = t.currentCPM
    if (totalAvailable <= 0) totalAvailable = t.totalAvailable
  }

  return {
    totalImpressions,
    totalEarnings,
    todayImpressions,
    currentCPM,
    totalAvailable,
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
