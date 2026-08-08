import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ref, get } from 'firebase/database'
import {
  appendWithdrawalsForUser,
  buildSingleUserOverviewRow,
  replaceOverviewRowForUser,
  replaceWithdrawalsForUser,
  sortOverviewRows,
  sortWithdrawalRequests,
} from '../lib/buildUserOverviewRows.js'
import { smartRepairAllUsers } from '../lib/smartDashboardRepair.js'
import { useFirebaseDb } from './FirebaseProvider.jsx'
import { UsersDataContext } from './usersDataContext.js'
import {
  clearUsersDataCaches,
  commitUsersDataSession,
  ensureSessionHydrated,
  hasFetchedOnceFlag,
  hydrateSessionFromStorage,
  readOverviewCache,
  readWithdrawalCache,
  writeUsersDataCaches,
} from './usersDataCache.js'
import { usersDataSession } from './usersDataSession.js'

/** Yield to UI without waiting a full animation frame (faster than rAF). */
function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Fast path: one Firebase get + O(n) build + one O(n log n) sort.
 * Avoids per-user binary-insert (was O(n²)) and tiny rAF chunks.
 */
async function fetchAndBuildUsers(db, onChunk) {
  const snap = await get(ref(db, 'users'))
  const val = snap.val()
  const entries = val && typeof val === 'object' ? Object.entries(val) : []
  const total = entries.length

  if (!total) {
    const empty = { usersVal: val, overviewRows: [], withdrawalRequests: [] }
    onChunk?.({ ...empty, loaded: 0, total: 0, streaming: false })
    return empty
  }

  const overviewRows = new Array(total)
  const wdAcc = []
  // Large batches keep UI responsive without slowing the build much
  const BATCH = Math.max(400, Math.min(2000, Math.ceil(total / 4)))

  for (let i = 0; i < total; i += 1) {
    const [emailKey, raw] = entries[i]
    overviewRows[i] = buildSingleUserOverviewRow(emailKey, raw)
    appendWithdrawalsForUser(wdAcc, emailKey, raw)

    const done = i + 1
    if (done === total || done % BATCH === 0) {
      if (done === total) {
        sortOverviewRows(overviewRows)
        sortWithdrawalRequests(wdAcc)
      }
      onChunk?.({
        usersVal: val,
        overviewRows: done === total ? overviewRows : overviewRows.slice(0, done),
        withdrawalRequests: done === total ? wdAcc : wdAcc.slice(),
        loaded: done,
        total,
        streaming: done < total,
      })
      if (done < total) await yieldToMain()
    }
  }

  return {
    usersVal: val,
    overviewRows,
    withdrawalRequests: wdAcc,
  }
}

function initialRows() {
  ensureSessionHydrated()
  if (usersDataSession.loaded) return usersDataSession.overviewRows
  return readOverviewCache()
}

function initialWithdrawals() {
  ensureSessionHydrated()
  if (usersDataSession.loaded) return usersDataSession.withdrawalRequests
  return readWithdrawalCache()
}

export default function UsersDataProvider({ children }) {
  const { db, loading: fbLoading } = useFirebaseDb()
  const bootRows = initialRows()
  const bootWd = initialWithdrawals()
  const [usersVal, setUsersVal] = useState(() =>
    usersDataSession.loaded ? usersDataSession.usersVal : null,
  )
  const [overviewRows, setOverviewRows] = useState(bootRows)
  const [withdrawalRequests, setWithdrawalRequests] = useState(bootWd)
  const [ready, setReady] = useState(
    () => usersDataSession.loaded || bootRows.length > 0 || bootWd.length > 0,
  )
  const [fromCache, setFromCache] = useState(
    () => usersDataSession.loaded || bootRows.length > 0 || bootWd.length > 0,
  )
  const [sessionLoaded, setSessionLoaded] = useState(() => usersDataSession.loaded)
  const [lastSync, setLastSync] = useState(() => usersDataSession.lastSync)
  const [updateTick, setUpdateTick] = useState(0)
  const [streamProgress, setStreamProgress] = useState(null)
  const [reloadBusy, setReloadBusy] = useState(false)
  const mounted = useRef(true)

  const applyPayload = useCallback((payload, { cached = false, streaming = false } = {}) => {
    if (!mounted.current) return
    setUsersVal(payload.usersVal)
    setOverviewRows(payload.overviewRows)
    setWithdrawalRequests(payload.withdrawalRequests)
    setReady(true)
    setFromCache(cached)
    if (!streaming) {
      setSessionLoaded(true)
      setLastSync(usersDataSession.lastSync ?? Date.now())
      setStreamProgress(null)
    }
    setUpdateTick((n) => n + 1)
  }, [])

  const runLoad = useCallback(
    async (force = false, { silent = false } = {}) => {
      if (!db) return
      if (!force && usersDataSession.loaded) {
        applyPayload(
          {
            usersVal: usersDataSession.usersVal,
            overviewRows: usersDataSession.overviewRows,
            withdrawalRequests: usersDataSession.withdrawalRequests,
          },
          { cached: true },
        )
        return
      }

      if (!force && usersDataSession.loadPromise) {
        await usersDataSession.loadPromise
        if (usersDataSession.loaded) {
          applyPayload(
            {
              usersVal: usersDataSession.usersVal,
              overviewRows: usersDataSession.overviewRows,
              withdrawalRequests: usersDataSession.withdrawalRequests,
            },
            { cached: false },
          )
        }
        return
      }

      if (usersDataSession.loadPromise) {
        await usersDataSession.loadPromise
        if (!force) return
      }

      if (!silent) {
        setReloadBusy(true)
        setStreamProgress({ loaded: 0, total: 0, streaming: true })
      }

      const task = (async () => {
        const built = await fetchAndBuildUsers(db, (chunk) => {
          if (!mounted.current || silent) return
          setStreamProgress({
            loaded: chunk.loaded,
            total: chunk.total,
            streaming: chunk.streaming,
          })
          // Mid-stream paint only; final applyPayload does the last paint
          if (chunk.streaming) {
            setOverviewRows(chunk.overviewRows)
            setWithdrawalRequests(chunk.withdrawalRequests)
            setUsersVal(chunk.usersVal)
            setReady(true)
            setFromCache(false)
            setUpdateTick((n) => n + 1)
          }
        })
        commitUsersDataSession(built.overviewRows, built.withdrawalRequests, built.usersVal)
        applyPayload(built, { cached: false, streaming: false })
      })()

      usersDataSession.loadPromise = task
      try {
        await task
      } finally {
        usersDataSession.loadPromise = null
        if (mounted.current && !silent) {
          setReloadBusy(false)
          setStreamProgress(null)
        }
      }
    },
    [db, applyPayload],
  )

  useEffect(() => {
    mounted.current = true
    if (!db) return undefined

    // Instant paint from memory / sessionStorage, then silent background refresh
    if (usersDataSession.loaded || ensureSessionHydrated()) {
      applyPayload(
        {
          usersVal: usersDataSession.usersVal,
          overviewRows: usersDataSession.overviewRows,
          withdrawalRequests: usersDataSession.withdrawalRequests,
        },
        { cached: true },
      )
      void runLoad(true, { silent: true })
      return () => {
        mounted.current = false
      }
    }

    if (hasFetchedOnceFlag() && bootRows.length > 0) {
      hydrateSessionFromStorage()
      applyPayload(
        {
          usersVal: usersDataSession.usersVal,
          overviewRows: usersDataSession.overviewRows,
          withdrawalRequests: usersDataSession.withdrawalRequests,
        },
        { cached: true },
      )
      void runLoad(true, { silent: true })
      return () => {
        mounted.current = false
      }
    }

    void runLoad(false)

    return () => {
      mounted.current = false
    }
  }, [db, applyPayload, runLoad])

  const refreshUsersData = useCallback(async () => {
    clearUsersDataCaches()
    await runLoad(true, { silent: false })
  }, [runLoad])

  const refreshUser = useCallback(
    async (emailKey) => {
      if (!db || !emailKey) return
      const snap = await get(ref(db, `users/${emailKey}`))
      const raw = snap.val()
      if (!raw || typeof raw !== 'object') return

      setOverviewRows((prev) => {
        const next = [...prev]
        replaceOverviewRowForUser(next, emailKey, raw)
        usersDataSession.overviewRows = next
        return next
      })
      setWithdrawalRequests((prev) => {
        const next = replaceWithdrawalsForUser([...prev], emailKey, raw)
        usersDataSession.withdrawalRequests = next
        return next
      })
      setUsersVal((prev) => {
        const next = { ...(prev || {}), [emailKey]: raw }
        usersDataSession.usersVal = next
        return next
      })
      usersDataSession.lastSync = Date.now()
      setLastSync(usersDataSession.lastSync)
      writeUsersDataCaches(usersDataSession.overviewRows, usersDataSession.withdrawalRequests)
      setUpdateTick((n) => n + 1)
    },
    [db],
  )

  /** Daily sum → dashboard totals + wallet = Earn − WD − Pending (sirf mismatched users) */
  const smartRepairAll = useCallback(
    async (onProgress) => {
      if (!db) return { repaired: 0, scanned: 0, skipped: 0 }
      let source = usersVal || usersDataSession.usersVal
      if (!source) {
        const snap = await get(ref(db, 'users'))
        source = snap.val()
      }
      const result = await smartRepairAllUsers(db, source, onProgress)
      clearUsersDataCaches()
      await runLoad(true, { silent: false })
      return result
    },
    [db, usersVal, runLoad],
  )

  const value = useMemo(
    () => ({
      usersVal,
      overviewRows,
      withdrawalRequests,
      ready: ready || (!fbLoading && fromCache),
      fromCache,
      live: sessionLoaded && !reloadBusy,
      sessionLoaded,
      lastSync,
      updateTick,
      streamProgress,
      allUsersLoaded:
        ready &&
        !reloadBusy &&
        !(streamProgress?.streaming === true) &&
        overviewRows.length > 0,
      reloadBusy,
      fbConnecting: fbLoading && !ready,
      refreshUsersData,
      refreshUser,
      smartRepairAll,
    }),
    [
      usersVal,
      overviewRows,
      withdrawalRequests,
      ready,
      fromCache,
      sessionLoaded,
      lastSync,
      updateTick,
      streamProgress,
      overviewRows.length,
      reloadBusy,
      fbLoading,
      refreshUsersData,
      refreshUser,
      smartRepairAll,
    ],
  )

  return <UsersDataContext.Provider value={value}>{children}</UsersDataContext.Provider>
}
