import { usersDataSession } from './usersDataSession.js'

const OVERVIEW_CACHE_KEY = 'tshortner.admin.overview.v5'
const WITHDRAWAL_CACHE_KEY = 'tshortner.admin.withdrawals.v2'
const FETCHED_ONCE_KEY = 'tshortner.admin.fetchedOnce.v1'

export function readOverviewCache() {
  try {
    const raw = sessionStorage.getItem(OVERVIEW_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.rows) ? parsed.rows : []
  } catch {
    return []
  }
}

export function readWithdrawalCache() {
  try {
    const raw = sessionStorage.getItem(WITHDRAWAL_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.rows) ? parsed.rows : []
  } catch {
    return []
  }
}

export function writeUsersDataCaches(overviewRows, withdrawalRequests) {
  try {
    sessionStorage.setItem(
      OVERVIEW_CACHE_KEY,
      JSON.stringify({ t: Date.now(), rows: overviewRows.slice(0, 5000) }),
    )
    sessionStorage.setItem(
      WITHDRAWAL_CACHE_KEY,
      JSON.stringify({ t: Date.now(), rows: withdrawalRequests.slice(0, 8000) }),
    )
  } catch {
    /* quota */
  }
}

export function hasFetchedOnceFlag() {
  try {
    return sessionStorage.getItem(FETCHED_ONCE_KEY) === '1'
  } catch {
    return false
  }
}

function markFetchedOnce() {
  try {
    sessionStorage.setItem(FETCHED_ONCE_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Purana cache hatao — Update / Reload ke baad fresh Firebase numbers */
export function clearUsersDataCaches() {
  try {
    sessionStorage.removeItem(OVERVIEW_CACHE_KEY)
    sessionStorage.removeItem(WITHDRAWAL_CACHE_KEY)
    sessionStorage.removeItem(FETCHED_ONCE_KEY)
  } catch {
    /* ignore */
  }
  usersDataSession.loaded = false
  usersDataSession.loadPromise = null
  usersDataSession.overviewRows = []
  usersDataSession.withdrawalRequests = []
  usersDataSession.usersVal = null
}

export function hydrateSessionFromStorage() {
  if (usersDataSession.loaded) return true
  const overview = readOverviewCache()
  if (!overview.length) return false
  const withdrawals = readWithdrawalCache()
  usersDataSession.overviewRows = overview
  usersDataSession.withdrawalRequests = withdrawals
  usersDataSession.usersVal = null
  usersDataSession.lastSync = Date.now()
  usersDataSession.loaded = true
  return true
}

export function ensureSessionHydrated() {
  if (usersDataSession.loaded) return true
  if (!hasFetchedOnceFlag()) return false
  return hydrateSessionFromStorage()
}

export function commitUsersDataSession(overviewRows, withdrawalRequests, usersVal) {
  usersDataSession.overviewRows = overviewRows
  usersDataSession.withdrawalRequests = withdrawalRequests
  usersDataSession.usersVal = usersVal
  usersDataSession.lastSync = Date.now()
  usersDataSession.loaded = true
  markFetchedOnce()
  writeUsersDataCaches(overviewRows, withdrawalRequests)
}
