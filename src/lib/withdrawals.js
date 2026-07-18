import { safeNum } from './tshortnerSchema.js'
export { formatUsd } from './formatMoney.js'

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
  if (req.method === 'Bank') {
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
