import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ref, get } from 'firebase/database'
import {
  appendWithdrawalsForUser,
  buildSingleUserOverviewRow,
  insertOverviewRowSorted,
  replaceOverviewRowForUser,
  replaceWithdrawalsForUser,
  sortWithdrawalRequests,
} from '../lib/buildUserOverviewRows.js'
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

const CHUNK_SIZE = 30

async function fetchAndBuildUsers(db, onChunk) {
  const snap = await get(ref(db, 'users'))
  const val = snap.val()
  const entries = val && typeof val === 'object' ? Object.entries(val) : []

  if (!entries.length) {
    const empty = { usersVal: val, overviewRows: [], withdrawalRequests: [] }
    onChunk?.({ ...empty, loaded: 0, total: 0, streaming: false })
    return empty
  }

  const acc = []
  const wdAcc = []
  let index = 0

  while (index < entries.length) {
    const end = Math.min(index + CHUNK_SIZE, entries.length)
    for (let i = index; i < end; i += 1) {
      const [emailKey, raw] = entries[i]
      insertOverviewRowSorted(acc, buildSingleUserOverviewRow(emailKey, raw))
      appendWithdrawalsForUser(wdAcc, emailKey, raw)
    }
    index = end
    sortWithdrawalRequests(wdAcc)
    onChunk?.({
      usersVal: val,
      overviewRows: [...acc],
      withdrawalRequests: [...wdAcc],
      loaded: end,
      total: entries.length,
      streaming: end < entries.length,
    })
    if (end < entries.length) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }

  return {
    usersVal: val,
    overviewRows: acc,
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
    async (force = false) => {
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

      setReloadBusy(true)
      setStreamProgress({ loaded: 0, total: 0, streaming: true })

      const task = (async () => {
        const built = await fetchAndBuildUsers(db, (chunk) => {
          if (!mounted.current) return
          setStreamProgress({
            loaded: chunk.loaded,
            total: chunk.total,
            streaming: chunk.streaming,
          })
          setOverviewRows(chunk.overviewRows)
          setWithdrawalRequests(chunk.withdrawalRequests)
          setUsersVal(chunk.usersVal)
          setReady(true)
          setFromCache(false)
          setUpdateTick((n) => n + 1)
        })
        commitUsersDataSession(built.overviewRows, built.withdrawalRequests, built.usersVal)
        applyPayload(built, { cached: false, streaming: false })
      })()

      usersDataSession.loadPromise = task
      try {
        await task
      } finally {
        usersDataSession.loadPromise = null
        if (mounted.current) {
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

    if (usersDataSession.loaded || ensureSessionHydrated()) {
      applyPayload(
        {
          usersVal: usersDataSession.usersVal,
          overviewRows: usersDataSession.overviewRows,
          withdrawalRequests: usersDataSession.withdrawalRequests,
        },
        { cached: true },
      )
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
    await runLoad(true)
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
    ],
  )

  return <UsersDataContext.Provider value={value}>{children}</UsersDataContext.Provider>
}
