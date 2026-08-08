import { ref, update } from 'firebase/database'
import { dashboardSummary } from './dashboardActivity.js'
import { buildDashboardTotals, readDailyMap, safeNum, toFixed2 } from './tshortnerSchema.js'
import { dedupeWithdrawalRequests, parseWithdrawalRequests, withdrawalStatusBucket } from './withdrawals.js'

const TOL = 0.02
const CHUNK = 40

function pendingHoldFromWalletAndRequests(wallet) {
  const walletPending = safeNum(wallet?.pendingBalance)
  let reqPending = 0
  for (const r of parseWithdrawalRequests(wallet?.withdrawalRequests)) {
    if (withdrawalStatusBucket(r.status) === 'pending') {
      reqPending += safeNum(r.amount)
    }
  }
  return toFixed2(Math.max(walletPending, reqPending))
}

/**
 * Ek user ki sahi economics — daily sum truth, phir wallet formula.
 * @returns {{
 *   emailKey?: string,
 *   trueEarn: number,
 *   trueImps: number,
 *   trueCpm: number,
 *   fromDaily: boolean,
 *   storedEarn: number,
 *   storedAvailable: number,
 *   withdrawn: number,
 *   pendingHold: number,
 *   currentBalance: number,
 *   expectedBalance: number,
 *   earnMismatch: boolean,
 *   balanceMismatch: boolean,
 *   needsRepair: boolean,
 * }}
 */
export function computeUserTrueEconomics(emailKey, rawUser) {
  const data = rawUser && typeof rawUser === 'object' ? rawUser : {}
  const dashboard = data.dashboard || {}
  const wallet = data.wallet || {}
  const dash = dashboardSummary(dashboard)

  const trueEarn = toFixed2(dash.totalEarnings)
  const trueImps = safeNum(dash.totalImpressions)
  const trueCpm = toFixed2(dash.currentCPM)
  const storedEarn = toFixed2(
    Math.max(
      safeNum(dashboard.totalEarning ?? dashboard.totalEarnings),
      safeNum(dashboard.totalavailable ?? dashboard.totalAvailable),
      safeNum(dash.storedTotalEarning),
      safeNum(dash.storedTotalAvailable),
    ),
  )
  const storedAvailable = toFixed2(
    safeNum(dashboard.totalavailable ?? dashboard.totalAvailable ?? dash.storedTotalAvailable),
  )
  const withdrawn = toFixed2(wallet.totalWithdrawn)
  const pendingHold = pendingHoldFromWalletAndRequests(wallet)
  const currentBalance = toFixed2(wallet.currentBalance)
  const expectedBalance = toFixed2(trueEarn - withdrawn - pendingHold)

  const earnMismatch =
    dash.fromDaily &&
    (Math.abs(storedEarn - trueEarn) > TOL || Math.abs(storedAvailable - trueEarn) > TOL)
  const balanceMismatch = Math.abs(currentBalance - expectedBalance) > TOL
  const needsRepair = Boolean(dash.fromDaily && (earnMismatch || balanceMismatch))

  return {
    emailKey,
    trueEarn,
    trueImps,
    trueCpm,
    fromDaily: dash.fromDaily,
    storedEarn,
    storedAvailable,
    withdrawn,
    pendingHold,
    currentBalance,
    expectedBalance,
    earnMismatch,
    balanceMismatch,
    needsRepair,
  }
}

/** Firebase multi-path: dashboard summary aliases + wallet currentBalance */
export function buildSmartRepairPaths(emailKey, rawUser) {
  const eco = computeUserTrueEconomics(emailKey, rawUser)
  if (!eco.fromDaily) return { paths: {}, eco, skip: true }

  const daily = readDailyMap(rawUser?.dashboard)
  const totals = buildDashboardTotals(daily)
  const base = `users/${emailKey}/dashboard`

  /** @type {Record<string, number>} */
  const paths = {
    [`${base}/totalEarning`]: totals.totalEarning,
    [`${base}/totalEarnings`]: totals.totalEarnings,
    [`${base}/totalAvailable`]: totals.totalAvailable,
    [`${base}/totalavailable`]: totals.totalAvailable,
    [`${base}/totalImpressions`]: totals.totalImpressions,
    [`${base}/overallCPM`]: totals.overallCPM,
    [`${base}/currentCPM`]: totals.currentCPM,
    [`${base}/dailyEarning`]: totals.dailyEarning,
    [`${base}/dailyCPM`]: totals.dailyCPM,
    [`users/${emailKey}/wallet/currentBalance`]: eco.expectedBalance,
  }

  return { paths, eco, skip: false }
}

/**
 * Sirf un users ko repair karo jinko zarurat ho (stale earn ya galat wallet).
 * @param {import('firebase/database').Database} db
 * @param {Record<string, unknown>} usersVal
 */
export async function smartRepairAllUsers(db, usersVal, onProgress) {
  if (!db || !usersVal || typeof usersVal !== 'object') {
    return { repaired: 0, scanned: 0, skipped: 0 }
  }

  const entries = Object.entries(usersVal)
  const toFix = []
  for (const [emailKey, raw] of entries) {
    const { paths, eco, skip } = buildSmartRepairPaths(emailKey, raw)
    if (skip || !eco.needsRepair) continue
    toFix.push({ emailKey, paths, eco })
  }

  let repaired = 0
  const total = toFix.length
  onProgress?.(0, total, { phase: 'repair' })

  for (let i = 0; i < toFix.length; i += CHUNK) {
    const batch = toFix.slice(i, i + CHUNK)
    /** @type {Record<string, number>} */
    const merged = {}
    for (const item of batch) {
      Object.assign(merged, item.paths)
    }
    if (Object.keys(merged).length > 0) {
      await update(ref(db), merged)
    }
    repaired += batch.length
    onProgress?.(repaired, total, { phase: 'repair' })
  }

  return {
    repaired,
    scanned: entries.length,
    skipped: entries.length - toFix.length,
    samples: toFix.slice(0, 12).map((x) => ({
      emailKey: x.emailKey,
      trueEarn: x.eco.trueEarn,
      storedEarn: x.eco.storedEarn,
      expectedBalance: x.eco.expectedBalance,
      currentBalance: x.eco.currentBalance,
    })),
  }
}

/** Overview / KPI ke liye kitne users repair chahiye */
export function countUsersNeedingRepair(usersVal) {
  if (!usersVal || typeof usersVal !== 'object') {
    return { needRepair: 0, earnMismatch: 0, balanceMismatch: 0, scanned: 0 }
  }
  let needRepair = 0
  let earnMismatch = 0
  let balanceMismatch = 0
  const entries = Object.entries(usersVal)
  for (const [emailKey, raw] of entries) {
    const eco = computeUserTrueEconomics(emailKey, raw)
    if (eco.earnMismatch) earnMismatch += 1
    if (eco.balanceMismatch) balanceMismatch += 1
    if (eco.needsRepair) needRepair += 1
  }
  return { needRepair, earnMismatch, balanceMismatch, scanned: entries.length }
}

/** Deduped pending amount helper for analysis parity */
export function sumPendingRequestAmount(withdrawalRequests, emailKey) {
  const list = dedupeWithdrawalRequests(
    (withdrawalRequests || []).filter((r) => r.emailKey === emailKey),
  )
  let pending = 0
  for (const r of list) {
    if (withdrawalStatusBucket(r.status) === 'pending') pending += safeNum(r.amount)
  }
  return toFixed2(pending)
}
