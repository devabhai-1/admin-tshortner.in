import { safeNum, toFixed2 } from './tshortnerSchema.js'
export { formatUsd } from './formatMoney.js'

/**
 * Pending request approve/reject — pendingBalance out-of-sync (often $0) bhi handle.
 * Admin approve kabhi balance check pe block nahi hota (request = user ne paisa hold kiya).
 *
 * @param {{ currentBalance?: unknown, pendingBalance?: unknown, totalWithdrawn?: unknown }} wallet
 * @param {number} amount
 * @param {'approve'|'reject'} action
 * @returns {{
 *   patch: { currentBalance?: number, pendingBalance: number, totalWithdrawn?: number },
 *   fromPending: number,
 *   fromCurrent: number,
 *   shortfall: number,
 *   note: string,
 * }}
 */
export function buildPendingWithdrawalWalletPatch(wallet, amount, action) {
  const amt = safeNum(amount)
  const pendingBal = safeNum(wallet?.pendingBalance)
  const currentBal = safeNum(wallet?.currentBalance)
  const withdrawn = safeNum(wallet?.totalWithdrawn)

  const fromPending = Math.min(pendingBal, amt)
  const shortfall = toFixed2(Math.max(0, amt - fromPending))
  const nextPending = Math.max(0, toFixed2(pendingBal - fromPending))

  if (action === 'approve') {
    // Shortfall pending me nahi → current se jitna mil sake kata; baaki force approve
    const fromCurrent = toFixed2(Math.min(Math.max(0, currentBal), shortfall))
    /** @type {{ currentBalance?: number, pendingBalance: number, totalWithdrawn: number }} */
    const patch = {
      pendingBalance: nextPending,
      totalWithdrawn: toFixed2(withdrawn + amt),
    }
    if (fromCurrent > 0.001) {
      patch.currentBalance = Math.max(0, toFixed2(currentBal - fromCurrent))
    }
    const forced = shortfall > fromCurrent + 0.001
    return {
      patch,
      fromPending: toFixed2(fromPending),
      fromCurrent,
      shortfall,
      note: forced
        ? `force approve (pending $${pendingBal.toFixed(2)} / current se $${fromCurrent.toFixed(2)})`
        : shortfall > 0.001
          ? `pending $${fromPending.toFixed(2)} + current $${fromCurrent.toFixed(2)}`
          : '',
    }
  }

  // reject: pending me jo hold tha wapas; agar pending 0 thi to pura amount current me
  // (warna user ka paisa stuck / sync wipe ho chuka)
  const creditBack = shortfall > 0.001 && fromPending < 0.001 ? amt : toFixed2(fromPending)
  return {
    patch: {
      currentBalance: toFixed2(currentBal + creditBack),
      pendingBalance: nextPending,
    },
    fromPending: toFixed2(fromPending),
    fromCurrent: 0,
    shortfall,
    note:
      shortfall > 0.001 && fromPending < 0.001
        ? `pending $0 thi — $${amt.toFixed(2)} current me restore`
        : shortfall > 0.001
          ? `pending se $${fromPending.toFixed(2)} wapas`
          : '',
  }
}

/** @typedef {'pending'|'approved'|'rejected'} WithdrawalBucket */

/**
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown> & { requestKey: string }>}
 */
export function parseWithdrawalRequests(raw) {
  if (!raw) return []
  /** @type {Array<{ requestKey: string, item: Record<string, unknown> }>} */
  let entries = []
  if (Array.isArray(raw)) {
    entries = raw
      .map((item, i) => ({ requestKey: String(item?.id ?? i), item: item || {} }))
      .filter((e) => e.item && typeof e.item === 'object')
  } else if (typeof raw === 'object') {
    entries = Object.entries(raw).map(([key, item]) => ({
      requestKey: key,
      item: item && typeof item === 'object' ? item : {},
    }))
  }
  return entries.map(({ requestKey, item }) => ({
    requestKey,
    id: item.id ?? requestKey,
    createdAt: Number(item.createdAt) || 0,
    amount: safeNum(item.amount),
    currency: item.currency || 'USD',
    status: item.status || 'pending',
    method: item.method || '—',
    account: item.account || '',
    bankName: item.bankName || '',
    accountNumber: item.accountNumber || '',
    ifscCode: item.ifscCode || '',
    accountHolderName: item.accountHolderName || '',
    processedAt: item.processedAt || null,
  }))
}

/** @param {string} [status] @returns {WithdrawalBucket} */
export function withdrawalStatusBucket(status) {
  const s = (status || '').toLowerCase()
  if (s === 'paid' || s === 'completed' || s === 'approved') return 'approved'
  if (s === 'rejected' || s === 'cancelled' || s === 'reject') return 'rejected'
  return 'pending'
}

/** @param {string} [status] */
export function withdrawalStatusLabel(status) {
  const b = withdrawalStatusBucket(status)
  if (b === 'approved') return 'Approved'
  if (b === 'rejected') return 'Rejected'
  return 'Pending'
}

/** Same request do baar list me na aaye (emailKey + requestKey unique). */
export function dedupeWithdrawalRequests(requests) {
  const map = new Map()
  for (const r of requests || []) {
    if (!r?.emailKey || r.requestKey == null) continue
    const key = `${r.emailKey}::${String(r.requestKey)}`
    const prev = map.get(key)
    if (!prev || safeNum(r.amount) > 0) {
      map.set(key, r)
    }
  }
  return [...map.values()]
}

/** @param {Array<{ status?: string, amount?: number }>} rows */
export function summarizeWithdrawals(rows) {
  const unique = dedupeWithdrawalRequests(rows)
  const out = {
    pending: { count: 0, amount: 0 },
    approved: { count: 0, amount: 0 },
    rejected: { count: 0, amount: 0 },
    total: { count: 0, amount: 0 },
  }
  for (const row of unique) {
    const bucket = withdrawalStatusBucket(row.status)
    const amt = safeNum(row.amount)
    if (amt <= 0) continue
    out[bucket].count += 1
    out[bucket].amount += amt
    out.total.count += 1
    out.total.amount += amt
  }
  return out
}

export function formatWithdrawalDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatAccountDetails(req) {
  if (!req) return '—'
  const method = String(req.method || '').toLowerCase()
  const isBank =
    method === 'bank' ||
    method.includes('bank') ||
    Boolean(req.bankName || req.accountNumber || req.ifscCode || req.accountHolderName)

  if (isBank) {
    const parts = [
      req.accountHolderName,
      req.bankName,
      req.accountNumber ? `****${String(req.accountNumber).slice(-4)}` : '',
    ].filter(Boolean)
    const base = parts.join(' · ') || req.account || '—'
    return req.ifscCode ? `${base} (IFSC: ${req.ifscCode})` : base
  }
  return req.account || '—'
}
