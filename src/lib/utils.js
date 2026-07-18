import {
  buildDashboardTotals,
  getEarningFromRow,
  normalizeDailyRow,
  safeNum,
  toFixed2,
} from './tshortnerSchema.js'

export { encodeEmailKey, decodeEmailKey, safeNum, toFixed2 } from './tshortnerSchema.js'

export function computeSummaryFromDaily(dailyStatsObj) {
  const map = {}
  for (const [date, row] of Object.entries(dailyStatsObj || {})) {
    map[date] = normalizeDailyRow(row)
  }
  return buildDashboardTotals(map)
}

export function sumEarningsBetweenForDailyObj(dailyObj, start, end) {
  let startDate = new Date(start)
  let endDate = new Date(end)
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return { total: 0, days: 0 }

  if (startDate > endDate) {
    const t = startDate
    startDate = endDate
    endDate = t
  }

  let total = 0
  let days = 0
  const d = new Date(startDate)
  while (d <= endDate) {
    const key = d.toISOString().split('T')[0]
    const row = dailyObj?.[key]
    if (row && (row.earning != null || row.earnings != null)) {
      const earn = Number(getEarningFromRow(row))
      if (!isNaN(earn)) {
        total += earn
        days++
      }
    }
    d.setDate(d.getDate() + 1)
  }

  return { total, days }
}

export function isZeroAmount(n) {
  return Math.abs(Number(n) || 0) < 0.000001
}

/** @deprecated — use formatUsd from formatMoney.js */
export function formatINR(num) {
  const n = Number(num) || 0
  return '$' + n.toFixed(2)
}
