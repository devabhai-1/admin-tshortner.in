import { dashboardSummary, hasMeaningfulDashboardData } from './dashboardActivity.js'
import { parseWithdrawalRequests, withdrawalStatusBucket } from './withdrawals.js'
import { decodeEmailKey, safeNum } from './tshortnerSchema.js'

function quickWithdrawalStats(raw) {
  const list = parseWithdrawalRequests(raw)
  let pending = 0
  let pendingAmt = 0
  let approved = 0
  let rejected = 0
  for (const r of list) {
    const bucket = withdrawalStatusBucket(r.status)
    const amt = safeNum(r.amount)
    if (bucket === 'approved') approved += 1
    else if (bucket === 'rejected') rejected += 1
    else {
      pending += 1
      pendingAmt += amt
    }
  }
  return {
    total: list.length,
    pending,
    pendingAmt,
    approved,
    rejected,
  }
}

export function appendWithdrawalsForUser(list, emailKey, userData) {
  const wallet = userData?.wallet
  if (!wallet) return list
  const parsed = parseWithdrawalRequests(wallet.withdrawalRequests)
  for (const req of parsed) {
    list.push({
      ...req,
      emailKey,
      email: decodeEmailKey(emailKey),
      walletCurrent: safeNum(wallet.currentBalance),
      walletPending: safeNum(wallet.pendingBalance),
      walletWithdrawn: safeNum(wallet.totalWithdrawn),
    })
  }
  return list
}

export function sortWithdrawalRequests(list) {
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return list
}

/** Replace one user's withdrawal rows after wallet update (no full reload). */
export function replaceWithdrawalsForUser(list, emailKey, userData) {
  const next = list.filter((r) => r.emailKey !== emailKey)
  return sortWithdrawalRequests(appendWithdrawalsForUser(next, emailKey, userData))
}

/** Replace one overview row (keeps sort by data volume). */
export function replaceOverviewRowForUser(rows, emailKey, raw) {
  const idx = rows.findIndex((r) => r.emailKey === emailKey)
  if (idx >= 0) rows.splice(idx, 1)
  return insertOverviewRowSorted(rows, buildSingleUserOverviewRow(emailKey, raw))
}

/** All withdrawal requests flattened (for Withdrawals panel). */
export function collectWithdrawalRequests(usersVal) {
  const users = usersVal || {}
  const list = []
  for (const [emailKey, userData] of Object.entries(users)) {
    appendWithdrawalsForUser(list, emailKey, userData)
  }
  return sortWithdrawalRequests(list)
}

function countLinkList(channel) {
  if (!channel) return 0
  const list = channel.list
  if (Array.isArray(list)) return list.filter(Boolean).length
  if (list && typeof list === 'object') return Object.keys(list).length
  return safeNum(channel.totalLinks)
}

export function buildSingleUserOverviewRow(emailKey, raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const dashboard = data.dashboard || null
  const wallet = data.wallet || {}
  const profile = data.profile || {}
  const links = data.links || {}
  const dash = dashboardSummary(dashboard)
  const wd = quickWithdrawalStats(wallet.withdrawalRequests)

  return {
    emailKey,
    email: decodeEmailKey(emailKey),
    name: profile.name || '—',
    telegramUsername: String(profile.telegramUsername || '').trim() || '—',
    telegramUsernameAt: profile.telegramUsernameAt || null,
    lastLogin: profile.lastLogin || null,
    totalImpressions: dash.totalImpressions,
    totalEarnings: dash.totalEarnings,
    todayImpressions: dash.todayImpressions,
    currentCPM: dash.currentCPM,
    totalAvailable: dash.totalAvailable,
    withdrawnAmount: safeNum(dashboard?.withdrawnAmount),
    currentBalance: safeNum(wallet.currentBalance),
    pendingBalance: safeNum(wallet.pendingBalance),
    totalWithdrawn: safeNum(wallet.totalWithdrawn),
    withdrawalTotal: wd.total,
    withdrawalPending: wd.pending,
    withdrawalPendingAmt: wd.pendingAmt,
    withdrawalApproved: wd.approved,
    withdrawalRejected: wd.rejected,
    telegramLinks: countLinkList(links.telegram),
    websiteLinks: countLinkList(links.website),
    isActive: hasMeaningfulDashboardData(dashboard),
  }
}

/** Insert one row — ज्यादा data वाले ऊपर (index 0), कम data नीचे */
export function insertOverviewRowSorted(rows, row) {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    // rows[mid] से ज़्यादा data → ऊपर (छोटा index)
    if (compareRowsByDataVolume(rows[mid], row) > 0) hi = mid
    else lo = mid + 1
  }
  rows.splice(lo, 0, row)
  return rows
}

export function sortOverviewRows(rows) {
  rows.sort((a, b) => compareRowsByDataVolume(b, a))
  return rows
}

/**
 * @param {Record<string, unknown>} usersVal RTDB `users` node
 */
export function buildUserOverviewRows(usersVal) {
  const users = usersVal || {}
  const rows = Object.entries(users).map(([emailKey, raw]) =>
    buildSingleUserOverviewRow(emailKey, raw),
  )
  return sortOverviewRows(rows)
}

/** Higher score = more data → dashboard top */
export function rowDataScore(row) {
  if (!row) return 0
  return (
    (row.isActive ? 1_000_000_000 : 0) +
    safeNum(row.totalEarnings) * 1_000_000 +
    safeNum(row.totalImpressions) * 1_000 +
    safeNum(row.todayImpressions) * 500 +
    safeNum(row.totalAvailable) * 100_000 +
    safeNum(row.totalWithdrawn) * 10_000 +
    safeNum(row.currentBalance) * 5_000 +
    safeNum(row.pendingBalance) * 3_000 +
    safeNum(row.withdrawalTotal) * 2_000 +
    safeNum(row.withdrawalPending) * 1_500 +
    safeNum(row.telegramLinks) * 100 +
    safeNum(row.websiteLinks) * 100
  )
}

export function compareRowsByDataVolume(a, b) {
  const diff = rowDataScore(b) - rowDataScore(a)
  if (diff !== 0) return diff
  return String(a.email || '').localeCompare(String(b.email || ''))
}

/** Users with dashboard total earnings strictly above this (USD). */
export const ELIGIBLE_MIN_EARNING_USD = 1

export function isEligibleEarningUser(row, minUsd = ELIGIBLE_MIN_EARNING_USD) {
  return safeNum(row?.totalEarnings) > minUsd
}

export function filterEligibleEarningUsers(rows, minUsd = ELIGIBLE_MIN_EARNING_USD) {
  return rows.filter((r) => isEligibleEarningUser(r, minUsd))
}

export function sortByTotalEarningsDesc(rows) {
  return [...rows].sort((a, b) => safeNum(b.totalEarnings) - safeNum(a.totalEarnings))
}

/** @param {ReturnType<typeof buildUserOverviewRows>} rows */
export function summarizeOverviewRows(rows) {
  const out = {
    users: rows.length,
    active: 0,
    pendingWithdrawals: 0,
    pendingWithdrawalAmt: 0,
    totalEarnings: 0,
    totalImpressions: 0,
    todayImpressions: 0,
    walletPending: 0,
    walletBalance: 0,
    totalWithdrawn: 0,
    totalAvailable: 0,
    totalBalance: 0,
    withdrawalTotalCount: 0,
    withdrawalApprovedCount: 0,
    withdrawalRejectedCount: 0,
    telegramLinks: 0,
    websiteLinks: 0,
    avgCPM: 0,
  }
  let cpmWeighted = 0
  let cpmWeight = 0
  for (const r of rows) {
    if (r.isActive) out.active += 1
    out.pendingWithdrawals += r.withdrawalPending
    out.pendingWithdrawalAmt += r.withdrawalPendingAmt
    out.totalEarnings += r.totalEarnings
    out.totalImpressions += r.totalImpressions
    out.todayImpressions += r.todayImpressions
    out.walletPending += r.pendingBalance
    out.walletBalance += r.currentBalance
    out.totalWithdrawn += r.totalWithdrawn
    out.totalAvailable += r.totalAvailable
    out.withdrawalTotalCount += r.withdrawalTotal
    out.withdrawalApprovedCount += r.withdrawalApproved
    out.withdrawalRejectedCount += r.withdrawalRejected
    out.telegramLinks += r.telegramLinks
    out.websiteLinks += r.websiteLinks
    const imps = safeNum(r.totalImpressions)
    if (imps > 0) {
      cpmWeighted += safeNum(r.currentCPM) * imps
      cpmWeight += imps
    }
  }
  out.totalBalance = out.walletBalance + out.walletPending
  out.avgCPM = cpmWeight > 0 ? cpmWeighted / cpmWeight : 0
  return out
}
