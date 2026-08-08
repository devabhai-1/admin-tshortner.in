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
 * Pending hold: wallet.pendingBalance ya pending requests — jo bada ho.
 * (Dono me se missing side ignore na ho.)
 */
export function resolvePendingHold(walletPending, pendingFromRequests) {
  return toFixed2(Math.max(safeNum(walletPending), safeNum(pendingFromRequests)))
}

/**
 * Sync SET target:
 *   currentBalance = Earn − totalWithdrawn − pendingHold
 *
 * Example: Earn 2000, Withdrawn 1700, Pending 200 → Balance 100 (not 300).
 * pendingBalance alag rehti hai — sirf currentBalance SET hota hai.
 */
export function analyzeUserWithdrawalBalance(row, requestTotals) {
  const dashboardEarn = safeNum(row?.totalEarnings)
  const dashboardAvail = safeNum(row?.totalAvailable)
  const approvedFromRequests = safeNum(requestTotals?.approved)
  const pendingFromRequests = safeNum(requestTotals?.pending)
  const walletWithdrawn = safeNum(row?.totalWithdrawn)
  const walletPending = safeNum(row?.pendingBalance)
  const walletAvailable = safeNum(row?.currentBalance)

  const pendingHold = resolvePendingHold(walletPending, pendingFromRequests)

  // Earn − paid WD − pending WD hold → available currentBalance
  const expectedAvailable = toFixed2(dashboardEarn - walletWithdrawn - pendingHold)

  const expectedFromRequests = toFixed2(
    dashboardEarn - approvedFromRequests - pendingFromRequests,
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
    pendingHold,
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
  let totalPendingHold = 0
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
    totalPendingHold += analysis.pendingHold
    totalExpectedAvailable += analysis.expectedAvailable
    totalWalletAvailable += analysis.walletAvailable
    totalWalletWithdrawn += analysis.walletWithdrawn
    totalWalletPending += analysis.walletPending
    totalBal += analysis.totalBal
    if (!analysis.matches) mismatchCount += 1
    if (Math.abs(analysis.withdrawnVsApproved) > MATCH_TOLERANCE) withdrawnMismatchCount += 1
  }

  // Earn − Withdrawn − Pending → SET currentBalance total
  const formulaBalance = toFixed2(
    totalDashboardEarn - totalWalletWithdrawn - totalPendingHold,
  )
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
      totalPendingHold: toFixed2(totalPendingHold),
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
