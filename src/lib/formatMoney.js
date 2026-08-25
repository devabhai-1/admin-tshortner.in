import { safeNum } from './tshortnerSchema.js'

/** All money amounts in admin UI — USD ($) */
export function formatUsd(n) {
  return '$' + safeNum(n).toFixed(2)
}

/** INR with Indian grouping */
export function formatInr(n) {
  return (
    '₹' +
    safeNum(n).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

/** Convert USD → INR at given rate (1 USD = rate INR). */
export function usdToInr(usd, ratePerUsd) {
  return safeNum(usd) * safeNum(ratePerUsd)
}

export function formatInt(n) {
  return (Number(n) || 0).toLocaleString('en-IN')
}
