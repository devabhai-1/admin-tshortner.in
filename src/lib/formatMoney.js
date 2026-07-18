import { safeNum } from './tshortnerSchema.js'

/** All money amounts in admin UI — USD ($) */
export function formatUsd(n) {
  return '$' + safeNum(n).toFixed(2)
}

export function formatInt(n) {
  return (Number(n) || 0).toLocaleString('en-IN')
}
