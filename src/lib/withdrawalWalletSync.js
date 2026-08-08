import { ref, update } from 'firebase/database'
import { safeNum, toFixed2 } from './tshortnerSchema.js'

const CHUNK_SIZE = 50

/**
 * SET (+= nahi):
 *   currentBalance = Earn − totalWithdrawn − pendingHold
 *   dashboard totalEarning/totalAvailable = daily-sum earn (stale $323 → $42 repair)
 * Example: 2000 − 1700 − 200 = 100 (pending balance me nahi jodte).
 * @param {import('firebase/database').Database} db
 * @param {Array<{ emailKey: string, expectedAvailable?: number, remainingEarn?: number, dashboardEarn?: number }>} analysisUsers
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
      const earn = toFixed2(u.dashboardEarn ?? 0)
      paths[`users/${u.emailKey}/wallet/currentBalance`] = bal
      // Stale summary fields ko daily-sum earn se align (Mail pe $323 vs daily $42)
      paths[`users/${u.emailKey}/dashboard/totalEarning`] = earn
      paths[`users/${u.emailKey}/dashboard/totalEarnings`] = earn
      paths[`users/${u.emailKey}/dashboard/totalAvailable`] = earn
      paths[`users/${u.emailKey}/dashboard/totalavailable`] = earn
    }
    if (Object.keys(paths).length > 0) {
      await update(ref(db), paths)
      updated += batch.length
    }
    onProgress?.(Math.min(i + batch.length, total), total)
  }

  return { updated, total }
}
