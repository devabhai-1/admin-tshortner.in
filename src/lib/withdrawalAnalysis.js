import { safeNum, toFixed2 } from './tshortnerSchema.js'
import { dedupeWithdrawalRequests, withdrawalStatusBucket } from './withdrawals.js'

const MATCH_TOLERANCE = 0.02

/**
 * Har unique request ka amount — sirf valid amount > 0.
 * @param {Array<{ emailKey: string, requestKey: string, status?: string, amount?: number }>} requests
 */
function sumRequestAmountsForUser(requests, emailKey) {
  const unique = dedupeWithdrawalRequests(
    (requests || []).filter((r) => r.emailKey === emailKey),
  )
  let approved = 0
  let pending = 0
  let rejected = 0
  let approvedCount = 0
  let pendingCount = 0
  for (const r of unique) {
    const amt = safeNum(r.amount)
    if (amt <= 0) continue
    const bucket = withdrawalStatusBucket(r.status)
    if (bucket === 'approved') {
      approved += amt
      approvedCount += 1
    } else if (bucket === 'pending') {
      pending += amt
      pendingCount += 1
    } else if (bucket === 'rejected') {
      rejected += amt
    }
  }
  return {
    approved: toFixed2(approved),
    pending: toFixed2(pending),
    rejected: toFixed2(rejected),
    approvedCount,
    pendingCount,
    requestCount: unique.length,
  }
}

/**
 * Sync (ADD/plus nahi — poora REPLACE):
 *   currentBalance = Dashboard Earn − wallet.totalWithdrawn
 * pendingBalance alag rehti hai, is formula me nahi.
 */
export function analyzeUserWithdrawalBalance(row, requestTotals) {
  const dashboardEarn = safeNum(row?.totalEarnings)
  const dashboardAvail = safeNum(row?.totalAvailable)
  const approvedFromRequests = safeNum(requestTotals?.approved)
  const pendingFromRequests = safeNum(requestTotals?.pending)
  const walletWithdrawn = safeNum(row?.totalWithdrawn)
  const walletPending = safeNum(row?.pendingBalance)
  const walletAvailable = safeNum(row?.currentBalance)

  // Har user: earn − withdrawn (minus allowed) → sab jod = Earn − Withdrawn total ($1318…)
  const expectedAvailable = toFixed2(dashboardEarn - walletWithdrawn)

  const expectedFromRequests = Math.max(
    0,
    toFixed2(dashboardEarn - approvedFromRequests),
  )

  const totalBal = toFixed2(walletAvailable + walletPending)
  const diffAvailable = toFixed2(walletAvailable - expectedAvailable)
  const updateDelta = toFixed2(expectedAvailable - walletAvailable)
  const withdrawnVsApproved = toFixed2(walletWithdrawn - approvedFromRequests)
  const requestsVsWallet = toFixed2(
    approvedFromRequests + pendingFromRequests - walletWithdrawn - walletPending,
  )

  return {
    dashboardEarn,
    dashboardAvail,
    totalEarnings: dashboardEarn,
    approvedWd: approvedFromRequests,
    approvedFromRequests,
    pendingWd: pendingFromRequests,
    pendingFromRequests,
    approvedCount: requestTotals?.approvedCount ?? 0,
    pendingCount: requestTotals?.pendingCount ?? 0,
    requestCount: requestTotals?.requestCount ?? 0,
    walletWithdrawn,
    walletPending,
    expectedAvailable,
    remainingEarn: expectedAvailable,
    expectedFromRequests,
    walletAvailable,
    available: walletAvailable,
    totalBal,
    diffAvailable,
    updateDelta,
    withdrawnVsApproved,
    requestsVsWallet,
    matches: Math.abs(diffAvailable) <= MATCH_TOLERANCE,
  }
}

/**
 * @param {ReturnType<import('./buildUserOverviewRows.js').buildUserOverviewRows>} overviewRows
 * @param {Array<{ emailKey: string, requestKey: string, status?: string, amount?: number }>} withdrawalRequests
 */
export function computeWithdrawalAnalysis(overviewRows, withdrawalRequests) {
  const uniqueRequests = dedupeWithdrawalRequests(withdrawalRequests)

  const userRows = []
  let totalDashboardEarn = 0
  let totalApprovedFromRequests = 0
  let totalPendingFromRequests = 0
  let totalExpectedAvailable = 0
  let totalWalletAvailable = 0
  let totalWalletWithdrawn = 0
  let totalWalletPending = 0
  let totalBal = 0
  let mismatchCount = 0
  let withdrawnMismatchCount = 0

  for (const row of overviewRows || []) {
    const reqTotals = sumRequestAmountsForUser(uniqueRequests, row.emailKey)
    const analysis = analyzeUserWithdrawalBalance(row, reqTotals)

    userRows.push({
      emailKey: row.emailKey,
      email: row.email,
      name: row.name,
      ...analysis,
    })

    totalDashboardEarn += analysis.dashboardEarn
    totalApprovedFromRequests += analysis.approvedFromRequests
    totalPendingFromRequests += analysis.pendingFromRequests
    totalExpectedAvailable += analysis.expectedAvailable
    // wallet-based expected (sync target)
    totalWalletAvailable += analysis.walletAvailable
    totalWalletWithdrawn += analysis.walletWithdrawn
    totalWalletPending += analysis.walletPending
    totalBal += analysis.totalBal
    if (!analysis.matches) mismatchCount += 1
    if (Math.abs(analysis.withdrawnVsApproved) > MATCH_TOLERANCE) withdrawnMismatchCount += 1
  }

  const formulaBalance = toFixed2(totalDashboardEarn - totalWalletWithdrawn)
  const setTotalCurrent = toFixed2(totalExpectedAvailable)
  const diffAvailable = toFixed2(totalWalletAvailable - setTotalCurrent)
  const formulaVsSetDiff = toFixed2(setTotalCurrent - formulaBalance)
  const globalApprovedReqCount = uniqueRequests.filter(
    (r) => withdrawalStatusBucket(r.status) === 'approved' && safeNum(r.amount) > 0,
  ).length

  userRows.sort((a, b) => Math.abs(b.diffAvailable) - Math.abs(a.diffAvailable))

  return {
    uniqueRequestCount: uniqueRequests.length,
    global: {
      users: userRows.length,
      totalDashboardAvailable: toFixed2(totalDashboardEarn),
      totalDashboardEarn: toFixed2(totalDashboardEarn),
      totalEarnings: toFixed2(totalDashboardEarn),
      totalApprovedWd: toFixed2(totalApprovedFromRequests),
      totalApprovedFromRequests: toFixed2(totalApprovedFromRequests),
      totalPendingWd: toFixed2(totalPendingFromRequests),
      totalPendingFromRequests: toFixed2(totalPendingFromRequests),
      totalWalletWithdrawn: toFixed2(totalWalletWithdrawn),
      totalWalletPending: toFixed2(totalWalletPending),
      formulaBalance,
      setTotalCurrent,
      remainingAfterApproved: setTotalCurrent,
      expectedAvailable: setTotalCurrent,
      actualAvailable: toFixed2(totalWalletAvailable),
      actualTotalBal: toFixed2(totalBal),
      diffAvailable,
      formulaVsSetDiff,
      approvedRequestCount: globalApprovedReqCount,
      matches: Math.abs(diffAvailable) <= MATCH_TOLERANCE,
      mismatchCount,
      withdrawnMismatchCount,
    },
    users: userRows,
    mismatches: userRows.filter((u) => !u.matches),
  }
}
