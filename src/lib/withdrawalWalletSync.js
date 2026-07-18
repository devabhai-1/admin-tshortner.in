import { ref, update } from 'firebase/database'
import { safeNum, toFixed2 } from './tshortnerSchema.js'

const CHUNK_SIZE = 50

/**
 * SET (+= nahi): currentBalance = Dashboard Earn − totalWithdrawn
 * Purana currentBalance replace — plus/jod nahi.
 * @param {import('firebase/database').Database} db
 * @param {Array<{ emailKey: string, expectedAvailable?: number, remainingEarn?: number }>} analysisUsers
 */
export async function syncAllWalletBalancesFromAnalysis(db, analysisUsers, onProgress) {
  if (!db || !analysisUsers?.length) {
    return { updated: 0, total: 0 }
  }

  let updated = 0
  const total = analysisUsers.length

  for (let i = 0; i < analysisUsers.length; i += CHUNK_SIZE) {
    const batch = analysisUsers.slice(i, i + CHUNK_SIZE)
    /** @type {Record<string, number>} */
    const paths = {}
    for (const u of batch) {
      if (!u?.emailKey) continue
      const bal = toFixed2(u.expectedAvailable ?? u.remainingEarn ?? 0)
      paths[`users/${u.emailKey}/wallet/currentBalance`] = bal
    }
    if (Object.keys(paths).length > 0) {
      await update(ref(db), paths)
      updated += batch.length
    }
    onProgress?.(Math.min(i + batch.length, total), total)
  }

  return { updated, total }
}
