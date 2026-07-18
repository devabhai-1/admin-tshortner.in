import { useCallback, useEffect, useMemo, useState } from 'react'
import { ref, get, update, remove, onValue } from 'firebase/database'
import { useFirebaseDb } from '../context/FirebaseProvider.jsx'
import {
  computeSummaryFromDaily,
  decodeEmailKey,
  encodeEmailKey,
  safeNum,
  toFixed2,
} from '../lib/utils.js'
import {
  buildDashboardTotals,
  dashboardUpdatePaths,
  getEarningFromRow,
  normalizeDailyRow,
  readDailyMap,
} from '../lib/tshortnerSchema.js'
import './GaFirebaseDashboard.css'
import { apiUrl } from '../lib/api.js'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import { formatUsd } from '../lib/withdrawals.js'

/** GA4 allocation + Firebase save — सब calculation USD ($), wallet जैसा */

const GA_ANALYTICS_SESSION_KEY = 'tshortner.ga4.analytics.v6'
const GA_ANALYTICS_SESSION_RAW = 'tshortner.ga4.analytics.raw.v5'
const PANEL_MODE_KEY = 'tshortner.admin.panelMode'
/** Pehli load: sirf latest N din (fast). Purani date select → on-demand fetch. */
const GA_INITIAL_DAYS = Number(import.meta.env.VITE_GA4_INITIAL_DAYS) || 5
const GA_PICKER_DAYS = Number(import.meta.env.VITE_GA4_PICKER_DAYS) || 365

function isoDateDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

function buildPickerDates(count) {
  const out = []
  const base = new Date()
  for (let i = 0; i < count; i += 1) {
    const d = new Date(base)
    d.setDate(base.getDate() - i)
    out.push(d.toISOString().split('T')[0])
  }
  return out
}

function rowKey(r) {
  return `${r.date}|${r.email || ''}|${r.pagePath || ''}|${r.linkId || ''}|${r.views}`
}

function mergeGaRows(prev, incoming) {
  const map = new Map()
  for (const r of prev) map.set(rowKey(r), r)
  for (const r of incoming) map.set(rowKey(r), r)
  return Array.from(map.values())
}

function replaceRowsInRange(rows, incoming, startDate, endDate) {
  const kept = rows.filter((r) => !r.date || r.date < startDate || r.date > endDate)
  return mergeGaRows(kept, incoming)
}

function streamGaRange(startDate, endDate, { gaOnly, refreshMap = false, onProgress, onRows }) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
      reject(new Error('EventSource not supported'))
      return
    }

    const modeQ = gaOnly ? '&mode=raw' : ''
    const mapQ = refreshMap ? '&refresh_map=1' : ''
    const url = apiUrl(
      `/api/analytics/stream?start_date=${startDate}&end_date=${endDate}${modeQ}${mapQ}`,
    )
    const es = new EventSource(url, { withCredentials: false })
    let done = false

    const close = () => {
      try {
        es.close()
      } catch {
        /* ignore */
      }
    }

    es.addEventListener('progress', (ev) => {
      try {
        const data = JSON.parse(ev.data)
        onProgress?.(data)
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('rows', (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (Array.isArray(data?.rows)) onRows?.(data.rows, data.meta || null)
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('done', (ev) => {
      done = true
      close()
      try {
        const data = JSON.parse(ev.data)
        resolve(data)
      } catch (e) {
        reject(e)
      }
    })

    es.addEventListener('error', () => {
      if (done) return
      close()
      reject(new Error('GA4 stream disconnected'))
    })
  })
}

function parseAnalyticsResponse(data) {
  if (Array.isArray(data)) return { rows: data, meta: null }
  if (data && Array.isArray(data.rows)) {
    return { rows: data.rows, meta: data.meta || null }
  }
  return { rows: [], meta: null }
}

function useGaAllocations(analyticsRows, selectedGaDate, gaTotalImpressions, gaTotalEarnings) {
  return useMemo(() => {
    const rowsForDate = analyticsRows.filter((r) => r.date === selectedGaDate)
    const byEmail = {}
    for (const row of rowsForDate) {
      const email = (row.email || '').trim()
      const views = safeNum(row.views)
      if (!email) continue
      byEmail[email] = (byEmail[email] || 0) + views
    }
    const currentDateRows = Object.entries(byEmail).map(([email, views]) => ({
      date: selectedGaDate,
      email,
      views,
    }))

    if (!currentDateRows.length) {
      return {
        currentDateRows,
        allocations: {},
        sortedRows: [],
        totalViews: 0,
        baseLabel: 'Views',
      }
    }

    const totalViews = currentDateRows.reduce((sum, r) => sum + safeNum(r.views), 0)
    const manualImps = safeNum(gaTotalImpressions)
    const manualEarn = safeNum(gaTotalEarnings)
    const baseImps = manualImps > 0 ? manualImps : totalViews
    const baseLabel = manualImps > 0 ? 'Manual Impressions' : 'Views'

    const allocations = {}
    const sorted = currentDateRows.slice().sort((a, b) => safeNum(b.views) - safeNum(a.views))

    const sortedRows = sorted.map((row) => {
      const email = row.email
      const views = safeNum(row.views)
      const share = totalViews > 0 ? views / totalViews : 0
      const imps = Math.round(share * baseImps)
      const earn = manualEarn > 0 ? toFixed2(share * manualEarn) : 0
      const cpm = imps > 0 && earn > 0 ? toFixed2((earn / imps) * 1000) : 0
      allocations[email] = {
        date: selectedGaDate,
        views,
        share,
        impressions: imps,
        earnings: earn,
        cpm,
      }
      return { email, views, share, imps, earn, cpm }
    })

    return {
      currentDateRows,
      allocations,
      sortedRows,
      totalViews,
      baseLabel,
    }
  }, [analyticsRows, selectedGaDate, gaTotalImpressions, gaTotalEarnings])
}

export default function GaFirebaseDashboard() {
  const { db, loading: fbLoading, error: fbInitError } = useFirebaseDb()

  const [panelMode, setPanelMode] = useState(() => {
    try {
      const saved = localStorage.getItem(PANEL_MODE_KEY)
      return saved === 'ga-only' ? 'ga-only' : 'firebase'
    } catch {
      return 'firebase'
    }
  })
  const isGaOnly = panelMode === 'ga-only'

  const [analyticsRows, setAnalyticsRows] = useState([])
  const [analyticsReady, setAnalyticsReady] = useState(false)
  const [gaMsg, setGaMsg] = useState({ text: '', kind: 'neutral' })
  const [selectedGaDate, setSelectedGaDate] = useState(() => isoDateDaysAgo(0))
  const [loadingDate, setLoadingDate] = useState(null)
  const [gaTotalImpressions, setGaTotalImpressions] = useState('')
  const [gaTotalEarnings, setGaTotalEarnings] = useState('')

  const [allUserKeys, setAllUserKeys] = useState([])
  const [userSearch, setUserSearch] = useState('')
  const [userListMsg, setUserListMsg] = useState({ text: '', kind: 'neutral' })

  const [selectedEmail, setSelectedEmail] = useState(null)
  const [fbDate, setFbDate] = useState(() => new Date().toISOString().split('T')[0])
  const [fbImpressions, setFbImpressions] = useState('')
  const [fbEarnings, setFbEarnings] = useState('')
  const [fbCPM, setFbCPM] = useState('')
  const [currentDailyStats, setCurrentDailyStats] = useState({})

  const [fbExistingMsg, setFbExistingMsg] = useState({ text: '', kind: 'neutral' })
  const [fbMsg, setFbMsg] = useState({ text: '', kind: 'neutral' })
  const [gaSaveAllMsg, setGaSaveAllMsg] = useState({ text: '', kind: 'neutral' })
  const [gaDeleteAllMsg, setGaDeleteAllMsg] = useState({ text: '', kind: 'neutral' })
  const [savingAll, setSavingAll] = useState(false)
  const [tableSort, setTableSort] = useState({ key: 'views', dir: 'desc' })

  const gaSlice = useGaAllocations(
    analyticsRows,
    selectedGaDate,
    gaTotalImpressions,
    gaTotalEarnings,
  )

  const summary = useMemo(
    () => computeSummaryFromDaily(currentDailyStats),
    [currentDailyStats],
  )

  const filteredUserKeys = useMemo(() => {
    const q = userSearch.trim().toLowerCase()
    if (!q) return allUserKeys
    return allUserKeys.filter((k) => decodeEmailKey(k).toLowerCase().includes(q))
  }, [allUserKeys, userSearch])

  const allocationRows = useMemo(() => {
    const list = gaSlice.sortedRows
    const { key, dir } = tableSort
    const mul = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (key) {
        case 'email':
          return mul * a.email.localeCompare(b.email)
        case 'views':
          return mul * (safeNum(a.views) - safeNum(b.views))
        case 'share':
          return mul * (a.share - b.share)
        case 'imps':
          return mul * (a.imps - b.imps)
        case 'earn':
          return mul * (a.earn - b.earn)
        case 'cpm':
          return mul * (a.cpm - b.cpm)
        default:
          return 0
      }
    })
  }, [gaSlice.sortedRows, tableSort])

  const gaOnlyDisplayRows = useMemo(() => {
    let list = analyticsRows
    if (selectedGaDate) list = list.filter((r) => r.date === selectedGaDate)
    const { key, dir } = tableSort
    const mul = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (key) {
        case 'email':
          return mul * String(a.email || '').localeCompare(String(b.email || ''))
        case 'date':
          return mul * String(a.date || '').localeCompare(String(b.date || ''))
        case 'path':
          return mul * String(a.pagePath || '').localeCompare(String(b.pagePath || ''))
        default:
          return mul * (safeNum(a.views) - safeNum(b.views))
      }
    })
  }, [analyticsRows, selectedGaDate, tableSort])

  const toggleTableSort = (key) => {
    setTableSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    )
  }

  const pickerDates = useMemo(() => buildPickerDates(GA_PICKER_DAYS), [])

  const loadedDates = useMemo(
    () => new Set(analyticsRows.map((r) => r.date).filter(Boolean)),
    [analyticsRows],
  )

  const fetchGaRange = useCallback(async (startDate, endDate, { gaOnly, refreshMap = false }) => {
    const modeQ = gaOnly ? '&mode=raw' : ''
    const mapQ = refreshMap ? '&refresh_map=1' : ''
    const apiPath = `/api/analytics?start_date=${startDate}&end_date=${endDate}${modeQ}${mapQ}`
    const res = await fetch(apiUrl(apiPath))
    const data = await res.json()
    if (!res.ok) {
      const msg = typeof data?.error === 'string' ? data.error : 'HTTP ' + res.status
      throw new Error(msg)
    }
    return parseAnalyticsResponse(data)
  }, [])

  const loadRecent = useCallback(
    async (hadCachedUi = false, modeOverride) => {
      const mode = modeOverride || panelMode
      const gaOnly = mode === 'ga-only'
      const cacheKey = gaOnly ? GA_ANALYTICS_SESSION_RAW : GA_ANALYTICS_SESSION_KEY
      const startDate = isoDateDaysAgo(GA_INITIAL_DAYS - 1)
      const endDate = isoDateDaysAgo(0)

      try {
        if (hadCachedUi) {
          setGaMsg({ text: `⟳ Latest ${GA_INITIAL_DAYS} days sync…`, kind: 'neutral' })
        } else {
          setAnalyticsReady(false)
          setGaMsg({ text: `Loading latest ${GA_INITIAL_DAYS} days…`, kind: 'neutral' })
        }
        setLoadingDate(`${startDate}→${endDate}`)
        const seenStart = performance.now()
        const { rows: incoming, meta } = await streamGaRange(startDate, endDate, {
          gaOnly,
          refreshMap: false,
          onProgress: (p) => {
            const exp = p?.ga4_rows_expected
            const got = p?.ga4_rows_fetched
            const out = p?.output_rows
            if (got != null) {
              setGaMsg({
                text:
                  exp != null && exp > 0
                    ? `⟳ Loading… GA4 ${got.toLocaleString('en-IN')} / ${exp.toLocaleString('en-IN')} · output ${String(out ?? 0)}`
                    : `⟳ Loading… GA4 ${got.toLocaleString('en-IN')} · output ${String(out ?? 0)}`,
                kind: 'neutral',
              })
            }
          },
          onRows: (batch) => {
            setAnalyticsRows((prev) => mergeGaRows(prev, batch))
          },
        })
        setAnalyticsRows((prev) => replaceRowsInRange(prev, incoming, startDate, endDate))

        try {
          const merged = replaceRowsInRange([], incoming, startDate, endDate)
          if (merged.length) sessionStorage.setItem(cacheKey, JSON.stringify(merged))
        } catch {
          sessionStorage.removeItem(cacheKey)
        }

        const todayIso = isoDateDaysAgo(0)
        setFbDate((d) => d || todayIso)
        setSelectedGaDate((cur) => cur || todayIso)

        const fetched = meta?.ga4_rows_fetched
        const errHint = meta?.ga4_error ? ` · ${String(meta.ga4_error).slice(0, 120)}` : ''
        const metaBit = fetched != null ? ` · ${fetched.toLocaleString('en-IN')} rows${errHint}` : ''
        const took = ((performance.now() - seenStart) / 1000).toFixed(1)
        setGaMsg({
          text: incoming.length
            ? `✅ Latest ${GA_INITIAL_DAYS} days loaded (${startDate} → ${endDate})${metaBit} · ${took}s. Purani date select karo.`
            : `⚠ Latest ${GA_INITIAL_DAYS} days me koi data nahi`,
          kind: incoming.length ? 'ok' : 'err',
        })
      } catch (e) {
        console.error(e)
        setGaMsg({
          text: '❌ Error: ' + (e instanceof Error ? e.message : String(e)),
          kind: 'err',
        })
      } finally {
        setLoadingDate(null)
        setAnalyticsReady(true)
      }
    },
    [panelMode],
  )

  const loadSingleDate = useCallback(
    async (isoDate) => {
      if (!isoDate || loadedDates.has(isoDate)) return
      const gaOnly = panelMode === 'ga-only'
      setLoadingDate(isoDate)
      setGaMsg({ text: `⟳ ${isoDate} load ho raha hai…`, kind: 'neutral' })
      try {
        const { rows: incoming, meta } = await streamGaRange(isoDate, isoDate, {
          gaOnly,
          refreshMap: false,
          onProgress: (p) => {
            const exp = p?.ga4_rows_expected
            const got = p?.ga4_rows_fetched
            const out = p?.output_rows
            if (got != null) {
              setGaMsg({
                text:
                  exp != null && exp > 0
                    ? `⟳ ${isoDate}… GA4 ${got.toLocaleString('en-IN')} / ${exp.toLocaleString('en-IN')} · output ${String(out ?? 0)}`
                    : `⟳ ${isoDate}… GA4 ${got.toLocaleString('en-IN')} · output ${String(out ?? 0)}`,
                kind: 'neutral',
              })
            }
          },
          onRows: (batch) => {
            setAnalyticsRows((prev) => mergeGaRows(prev, batch))
          },
        })
        setAnalyticsRows((prev) => replaceRowsInRange(prev, incoming, isoDate, isoDate))
        const n = incoming.length
        const metaBit =
          meta?.ga4_rows_fetched != null
            ? ` (${meta.ga4_rows_fetched.toLocaleString('en-IN')} GA4 rows)`
            : ''
        setGaMsg({
          text: n
            ? `✅ ${isoDate} loaded — ${n.toLocaleString('en-IN')} rows${metaBit}`
            : `⚠ ${isoDate} par koi data nahi`,
          kind: n ? 'ok' : 'err',
        })
      } catch (e) {
        console.error(e)
        setGaMsg({
          text: '❌ ' + isoDate + ': ' + (e instanceof Error ? e.message : String(e)),
          kind: 'err',
        })
      } finally {
        setLoadingDate(null)
      }
    },
    [panelMode, loadedDates],
  )

  const switchPanelMode = (mode) => {
    setPanelMode(mode)
    try {
      localStorage.setItem(PANEL_MODE_KEY, mode)
    } catch {
      /* ignore */
    }
    setSelectedEmail(null)
    setGaSaveAllMsg({ text: '', kind: 'neutral' })
    setGaDeleteAllMsg({ text: '', kind: 'neutral' })
  }

  useEffect(() => {
    let hadCache = false
    const cacheKey = isGaOnly ? GA_ANALYTICS_SESSION_RAW : GA_ANALYTICS_SESSION_KEY
    try {
      const raw = sessionStorage.getItem(cacheKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAnalyticsRows(parsed)
          setAnalyticsReady(true)
          setGaMsg({ text: '⚡ कैश से तुरंत दिख रहा है — GA4 से sync हो रहा है…', kind: 'neutral' })
          hadCache = true
        }
      }
    } catch {
      sessionStorage.removeItem(cacheKey)
    }
    if (!hadCache) setAnalyticsReady(false)
    void loadRecent(hadCache, panelMode)
  }, [loadRecent, panelMode, isGaOnly])

  useEffect(() => {
    const ms = 4 * 60 * 1000
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadRecent(true)
    }, ms)
    return () => clearInterval(id)
  }, [loadRecent])

  useEffect(() => {
    if (!selectedGaDate || !analyticsReady) return
    if (loadedDates.has(selectedGaDate) || loadingDate === selectedGaDate) return
    void loadSingleDate(selectedGaDate)
  }, [selectedGaDate, loadedDates, analyticsReady, loadSingleDate, loadingDate])

  useEffect(() => {
    if (!db) return
    const usersRef = ref(db, 'users')
    setUserListMsg({ text: 'Firebase users (live)…', kind: 'neutral' })
    const unsub = onValue(
      usersRef,
      (snap) => {
        const users = snap.val() || {}
        const keys = Object.keys(users)
        setAllUserKeys(keys)
        if (!keys.length)
          setUserListMsg({ text: '⚠ No users in Firebase', kind: 'err' })
        else
          setUserListMsg({
            text: `✅ Live · ${keys.length.toLocaleString('en-IN')} users`,
            kind: 'ok',
          })
      },
      (err) => {
        setUserListMsg({
          text: '❌ Firebase users: ' + (err instanceof Error ? err.message : String(err)),
          kind: 'err',
        })
      },
    )
    return unsub
  }, [db])

  useEffect(() => {
    if (!selectedGaDate) return
    setFbDate((prev) => prev || selectedGaDate)
  }, [selectedGaDate])

  const loadUserDashboard = useCallback(
    async (email) => {
      if (!db || !email) {
        setCurrentDailyStats({})
        return {}
      }
      try {
        const key = encodeEmailKey(email)
        const snap = await get(ref(db, `users/${key}/dashboard`))
        if (!snap.exists()) {
          setCurrentDailyStats({})
          return {}
        }
        const data = snap.val() || {}
        const daily = readDailyMap(data)
        setCurrentDailyStats(daily)
        return daily
      } catch (e) {
        console.error(e)
        setCurrentDailyStats({})
        return {}
      }
    },
    [db],
  )

  const applySelection = useCallback(
    async (email) => {
      setSelectedEmail(email)
      setFbExistingMsg({ text: '', kind: 'neutral' })
      setFbMsg({ text: '', kind: 'neutral' })

      if (!email) {
        setCurrentDailyStats({})
        return
      }

      const todayIso = new Date().toISOString().split('T')[0]
      const dateForFb = selectedGaDate || todayIso
      setFbDate(dateForFb)

      const alloc = gaSlice.allocations[email]
      if (alloc) {
        setFbImpressions(String(alloc.impressions ?? ''))
        setFbEarnings(String(alloc.earnings ?? ''))
        setFbCPM(String(alloc.cpm ?? ''))
      } else {
        setFbImpressions('')
        setFbEarnings('')
        setFbCPM('')
      }

      const daily = await loadUserDashboard(email)
      const local = daily[dateForFb]
      if (local) {
        setFbExistingMsg({
          text: `Existing: imps=${safeNum(local.impressions)}, earning=${formatUsd(getEarningFromRow(local))}, cpm=${formatUsd(local.cpm)}`,
          kind: 'ok',
        })
        return
      }

      if (!db) return
      try {
        const key = encodeEmailKey(email)
        const snap = await get(ref(db, `users/${key}/dashboard/daily/${dateForFb}`))
        if (!snap.exists()) {
          setFbExistingMsg({
            text: 'No existing daily stat in Firebase for this email + date.',
            kind: 'neutral',
          })
          return
        }
        const d = snap.val() || {}
        setCurrentDailyStats((prev) => ({ ...prev, [dateForFb]: d }))
        setFbExistingMsg({
          text: `Existing: imps=${safeNum(d.impressions)}, earning=${formatUsd(getEarningFromRow(d))}, cpm=${formatUsd(d.cpm)}`,
          kind: 'ok',
        })
      } catch (e) {
        setFbExistingMsg({
          text: 'Error loading existing stat: ' + (e instanceof Error ? e.message : String(e)),
          kind: 'err',
        })
      }
    },
    [db, selectedGaDate, gaSlice.allocations, loadUserDashboard],
  )

  const loadDailyFromFirebase = useCallback(
    async (dateOverride) => {
    if (!selectedEmail) {
      setFbExistingMsg({ text: 'No email selected.', kind: 'neutral' })
      return
    }
    const date = dateOverride ?? fbDate
    if (!date) {
      setFbExistingMsg({ text: 'Select a date to load existing stat.', kind: 'neutral' })
      return
    }

    const local = currentDailyStats[date]
    if (local) {
      setFbExistingMsg({
        text: `Existing: imps=${safeNum(local.impressions)}, earning=${formatUsd(getEarningFromRow(local))}, cpm=${formatUsd(local.cpm)}`,
        kind: 'ok',
      })
      return
    }

    if (!db) return
    try {
      const key = encodeEmailKey(selectedEmail)
      const snap = await get(ref(db, `users/${key}/dashboard/daily/${date}`))
      if (!snap.exists()) {
        setFbExistingMsg({
          text: 'No existing daily stat in Firebase for this email + date.',
          kind: 'neutral',
        })
        return
      }
      const d = snap.val() || {}
      setCurrentDailyStats((prev) => ({ ...prev, [date]: d }))
      setFbExistingMsg({
        text: `Existing: imps=${safeNum(d.impressions)}, earning=${formatUsd(getEarningFromRow(d))}, cpm=${formatUsd(d.cpm)}`,
        kind: 'ok',
      })
    } catch (e) {
      setFbExistingMsg({
        text: 'Error loading existing stat: ' + (e instanceof Error ? e.message : String(e)),
        kind: 'err',
      })
    }
  },
    [db, selectedEmail, fbDate, currentDailyStats],
  )

  const saveDailyToFirebase = async () => {
    if (!db) return setFbMsg({ text: 'Firebase not initialized', kind: 'err' })
    if (!selectedEmail) return setFbMsg({ text: 'Please select an email first.', kind: 'err' })
    const date = fbDate
    if (!date) return setFbMsg({ text: 'Please select a date.', kind: 'err' })

    let imps = safeNum(fbImpressions)
    let earn = toFixed2(fbEarnings)
    let cpm = safeNum(fbCPM)
    if (!cpm && imps > 0 && earn > 0) {
      cpm = toFixed2((earn / imps) * 1000)
      setFbCPM(String(cpm))
    }

    try {
      setFbMsg({ text: 'Saving...', kind: 'neutral' })
      const nextDaily = {
        ...currentDailyStats,
        [date]: normalizeDailyRow({ impressions: imps, earning: earn, cpm }),
      }
      setCurrentDailyStats(nextDaily)

      const key = encodeEmailKey(selectedEmail)
      await update(ref(db), dashboardUpdatePaths(key, date, nextDaily[date], nextDaily))
      setFbMsg({ text: '✅ Saved.', kind: 'ok' })
    } catch (e) {
      setFbMsg({ text: '❌ Save failed: ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    }
  }

  const deleteDailyFromFirebase = async () => {
    if (!db) return setFbMsg({ text: 'Firebase not initialized', kind: 'err' })
    if (!selectedEmail) return setFbMsg({ text: 'Please select an email first.', kind: 'err' })
    const date = fbDate
    if (!date) return setFbMsg({ text: 'Please select a date.', kind: 'err' })

    try {
      setFbMsg({ text: 'Deleting...', kind: 'neutral' })
      const key = encodeEmailKey(selectedEmail)
      const nextDaily = { ...currentDailyStats }
      delete nextDaily[date]
      setCurrentDailyStats(nextDaily)
      const paths = dashboardUpdatePaths(key, date, { impressions: 0, earning: 0, cpm: 0 }, nextDaily)
      paths[`users/${key}/dashboard/daily/${date}`] = null
      await update(ref(db), paths)
      setFbMsg({ text: '✅ Deleted.', kind: 'ok' })
    } catch (e) {
      setFbMsg({ text: '❌ Delete failed: ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    }
  }

  const saveAllToFirebase = async () => {
    if (!db) return setGaSaveAllMsg({ text: '❌ Firebase not initialized', kind: 'err' })
    const date = selectedGaDate
    if (!date) return setGaSaveAllMsg({ text: '❌ Select GA date first', kind: 'err' })
    const emails = Object.keys(gaSlice.allocations || {})
    if (!emails.length) return setGaSaveAllMsg({ text: '❌ No allocations to save', kind: 'err' })

    try {
      setSavingAll(true)
      setGaSaveAllMsg({ text: 'Saving all users... please wait.', kind: 'neutral' })
      const usersSnap = await get(ref(db, 'users'))
      const usersObj = usersSnap.val() || {}
      const updates = {}
      let savedCount = 0
      let skippedMissingUser = 0

      for (const email of emails) {
        const key = encodeEmailKey(email)
        if (!usersObj[key]) {
          skippedMissingUser++
          continue
        }
        const alloc = gaSlice.allocations[email]
        const imps = safeNum(alloc.impressions)
        const earn = toFixed2(alloc.earnings)
        const cpm = toFixed2(alloc.cpm)
        const existingDash = usersObj[key].dashboard || {}
        const dailyMap = readDailyMap(existingDash)
        dailyMap[date] = normalizeDailyRow({ impressions: imps, earning: earn, cpm })
        Object.assign(updates, dashboardUpdatePaths(key, date, dailyMap[date], dailyMap))
        savedCount++
      }

      if (!Object.keys(updates).length) {
        setGaSaveAllMsg({
          text: '⚠ Nothing to save (all emails missing in Firebase).',
          kind: 'err',
        })
        return
      }

      await update(ref(db), updates)
      setGaSaveAllMsg({
        text: `✅ Saved ${savedCount} users for date ${date}. Skipped (not found): ${skippedMissingUser}`,
        kind: 'ok',
      })
    } catch (e) {
      setGaSaveAllMsg({
        text: '❌ Save all failed: ' + (e instanceof Error ? e.message : String(e)),
        kind: 'err',
      })
    } finally {
      setSavingAll(false)
    }
  }

  const deleteAllFromFirebase = async () => {
    if (!db) return setGaDeleteAllMsg({ text: '❌ Firebase not initialized', kind: 'err' })
    const date = selectedGaDate
    if (!date) return setGaDeleteAllMsg({ text: '❌ Select GA date first', kind: 'err' })
    const sure = window.confirm(
      `Are you sure?\n\nThis will DELETE dashboard.daily for ALL users on date: ${date}`,
    )
    if (!sure) return

    try {
      setSavingAll(true)
      setGaDeleteAllMsg({ text: 'Deleting all users... please wait.', kind: 'neutral' })
      const usersSnap = await get(ref(db, 'users'))
      const usersObj = usersSnap.val() || {}
      const updates = {}
      let deletedCount = 0
      let skippedCount = 0

      for (const key of Object.keys(usersObj)) {
        const dash = usersObj[key]?.dashboard || {}
        const dailyMap = readDailyMap(dash)
        if (!dailyMap[date]) {
          skippedCount++
          continue
        }
        delete dailyMap[date]
        const paths = dashboardUpdatePaths(key, date, { impressions: 0, earning: 0, cpm: 0 }, dailyMap)
        paths[`users/${key}/dashboard/daily/${date}`] = null
        Object.assign(updates, paths)
        deletedCount++
      }

      if (!Object.keys(updates).length) {
        setGaDeleteAllMsg({ text: `⚠ Nothing to delete for date ${date}`, kind: 'err' })
        return
      }

      await update(ref(db), updates)
      setGaDeleteAllMsg({
        text: `✅ Deleted date ${date} for ${deletedCount} users. Skipped (no stat): ${skippedCount}`,
        kind: 'ok',
      })
    } catch (e) {
      setGaDeleteAllMsg({
        text: '❌ Delete all failed: ' + (e instanceof Error ? e.message : String(e)),
        kind: 'err',
      })
    } finally {
      setSavingAll(false)
    }
  }

  const msgClass = (k) => 'msg ' + (k || 'neutral')

  const sortMark = (key) =>
    tableSort.key === key ? (tableSort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const dailySortedKeys = Object.keys(currentDailyStats || {}).sort(
    (a, b) => new Date(b) - new Date(a),
  )

  return (
    <div className="ga-dash-root">
      <header className="ga-hero-header">
        <div className="ga-hero-title">
          <h1>
            {isGaOnly ? 'GA4 Analytics' : 'GA4 × Firebase'}{' '}
            <span className="badge">Latest {GA_INITIAL_DAYS} days</span>
          </h1>
          <p className="ga-hero-desc">
            {isGaOnly
              ? `Pehle latest ${GA_INITIAL_DAYS} din fast load — purani date dropdown se select karo.`
              : `Latest ${GA_INITIAL_DAYS} din auto load · purani date select par fetch · Firebase save.`}
          </p>
        </div>
        <div className="ga-hero-nav-row">
          <AdminSectionNav />
          <button
            type="button"
            className="secondary ga-refresh-btn"
            disabled={!analyticsReady && !analyticsRows.length}
            onClick={() => {
              try {
                sessionStorage.removeItem(
                  isGaOnly ? GA_ANALYTICS_SESSION_RAW : GA_ANALYTICS_SESSION_KEY,
                )
              } catch {
                /* ignore */
              }
              void loadRecent(false, panelMode)
            }}
          >
            ↻ Refresh (latest {GA_INITIAL_DAYS}d)
          </button>
        </div>
        <div className="ga-mode-switch" role="tablist" aria-label="Panel mode">
          <button
            type="button"
            role="tab"
            aria-selected={!isGaOnly}
            className={!isGaOnly ? 'active' : ''}
            onClick={() => switchPanelMode('firebase')}
          >
            GA4 + Firebase
            <small>Latest {GA_INITIAL_DAYS}d · save RTDB</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isGaOnly}
            className={isGaOnly ? 'active' : ''}
            onClick={() => switchPanelMode('ga-only')}
          >
            Only GA4
            <small>Latest {GA_INITIAL_DAYS}d · date se load</small>
          </button>
        </div>
        {!isGaOnly && (
          <div className="ga-hero-tip pill">
            <span>Tip:</span> बाईं टेबल की row पर क्लिक → दायाँ पैनल में उसी email की डिटेल।
          </div>
        )}
      </header>

      <div className="ga-dash-container">
        {fbInitError && (
          <p className="msg err ga-alert">
            Firebase: {fbInitError}
          </p>
        )}

        {isGaOnly ? (
          <div className="card ga-card-full">
            <h2>
              GA4 Raw Data <small>Latest {GA_INITIAL_DAYS} days auto · purani date select</small>
            </h2>
            <div className="card-sub">
              <span className="tag-small">GA4 only</span>
              Loaded: {loadedDates.size} dates · select karo jo abhi load nahi (↓ load likha hoga).
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="gaDateSelectOnly">Select date</label>
                <select
                  id="gaDateSelectOnly"
                  value={selectedGaDate}
                  onChange={(e) => setSelectedGaDate(e.target.value)}
                  disabled={!!loadingDate}
                >
                  {pickerDates.map((d) => (
                    <option key={d} value={d}>
                      {d}
                      {loadedDates.has(d) ? '' : ' ↓ load'}
                      {loadingDate === d ? ' …' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="stat-chip">
                Showing: <strong>{gaOnlyDisplayRows.length}</strong> rows
                {loadingDate ? ` · loading ${loadingDate}` : ''}
              </div>
            </div>
            <table className="ga-sort-table">
              <thead>
                <tr>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('date')}>
                      Date{sortMark('date')}
                    </button>
                  </th>
                  <th style={{ minWidth: 160 }}>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('email')}>
                      Email{sortMark('email')}
                    </button>
                  </th>
                  <th>Link ID</th>
                  <th style={{ minWidth: 180 }}>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('path')}>
                      Page path{sortMark('path')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('views')}>
                      Views{sortMark('views')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!gaOnlyDisplayRows.length ? (
                  <tr className="empty">
                    <td colSpan={5}>
                      {!analyticsReady && !analyticsRows.length
                        ? '⏳ Loading GA4…'
                        : 'No rows — refresh or check GA4 property.'}
                    </td>
                  </tr>
                ) : (
                  gaOnlyDisplayRows.map((row, i) => (
                    <tr key={`${row.date}-${row.linkId}-${row.pagePath}-${i}`}>
                      <td>{row.date}</td>
                      <td className="email">{row.email || '—'}</td>
                      <td>{row.linkId || '—'}</td>
                      <td className="ga-path-cell" title={row.pagePath}>
                        {row.pagePath && row.pagePath.length > 48
                          ? `${row.pagePath.slice(0, 46)}…`
                          : row.pagePath || '—'}
                      </td>
                      <td>{row.views}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className={msgClass(gaMsg.kind)}>{gaMsg.text}</div>
          </div>
        ) : (
        <div className="two-col">
          <div className="card ga-card-left">
            <h2>
              GA4 Daily Allocation <small>Views → Impressions &amp; Earnings</small>
            </h2>
            <div className="card-sub">
              <span className="tag-small">Step 1</span>
              Date select karo → Total impressions / earnings daalo → Neeche table me har email ka share
              dikhega.
            </div>

            <div className="row">
              <div className="field">
                <label htmlFor="gaDateSelect">Select Date (GA4)</label>
                <select
                  id="gaDateSelect"
                  value={selectedGaDate}
                  onChange={(e) => setSelectedGaDate(e.target.value)}
                  disabled={!!loadingDate}
                >
                  {pickerDates.map((d) => (
                    <option key={d} value={d}>
                      {d}
                      {loadedDates.has(d) ? '' : ' ↓ load'}
                      {loadingDate === d ? ' …' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="stat-chip">
                Loaded dates: <strong>{loadedDates.size}</strong>
                {loadingDate ? ` · ⟳ ${loadingDate}` : ''}
              </div>
              <div className="field">
                <label htmlFor="gaTotalImpressions">Total Impressions (Your input)</label>
                <input
                  type="number"
                  id="gaTotalImpressions"
                  placeholder="e.g. 12000"
                  value={gaTotalImpressions}
                  onChange={(e) => setGaTotalImpressions(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="gaTotalEarnings">Total Earnings (USD $) (Your input)</label>
                <input
                  type="number"
                  id="gaTotalEarnings"
                  step="0.01"
                  placeholder="e.g. 850.50"
                  value={gaTotalEarnings}
                  onChange={(e) => setGaTotalEarnings(e.target.value)}
                />
              </div>
            </div>

            <div className="stat-bar">
              <div className="stat-chip">
                GA4 Total Views (selected date): <strong>{gaSlice.totalViews}</strong>
              </div>
              <div className="stat-chip">
                Records: <strong>{gaSlice.sortedRows.length} users</strong>
              </div>
              <div className="stat-chip">
                Allocation Base: <strong>{gaSlice.baseLabel}</strong>
              </div>
            </div>

            <table className="ga-sort-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('email')}>
                      Email{sortMark('email')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('views')}>
                      GA Views{sortMark('views')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('share')}>
                      % Share{sortMark('share')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('imps')}>
                      Impressions{sortMark('imps')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('earn')}>
                      Earnings ($){sortMark('earn')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className="ga-th" onClick={() => toggleTableSort('cpm')}>
                      CPM ($){sortMark('cpm')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!allocationRows.length ? (
                  <tr className="empty">
                    <td colSpan={6}>
                      {!analyticsReady && !analyticsRows.length
                        ? '⏳ Loading GA4 analytics...'
                        : !analyticsRows.length
                          ? 'No GA4 rows found.'
                          : 'No rows for selected date.'}
                    </td>
                  </tr>
                ) : (
                  allocationRows.map((row) => (
                    <tr
                      key={row.email}
                      data-email={row.email}
                      onClick={() => {
                        void applySelection(row.email)
                        document.querySelector('.ga-dash-root .two-col .card:last-child')?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'start',
                        })
                      }}
                    >
                      <td className="email">{row.email}</td>
                      <td>{row.views}</td>
                      <td>{(row.share * 100).toFixed(2)}%</td>
                      <td>{row.imps}</td>
                      <td>{formatUsd(row.earn)}</td>
                      <td>{formatUsd(row.cpm)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
              <button
                type="button"
                className="secondary"
                disabled={savingAll || fbLoading}
                onClick={() => void saveAllToFirebase()}
              >
                ✅ Save ALL to Firebase (Selected Date)
              </button>
            </div>
            <div className={msgClass(gaSaveAllMsg.kind)}>{gaSaveAllMsg.text}</div>

            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
              <button
                type="button"
                className="danger"
                disabled={savingAll || fbLoading}
                onClick={() => void deleteAllFromFirebase()}
              >
                🗑 Delete ALL from Firebase (Selected Date)
              </button>
            </div>
            <div className={msgClass(gaDeleteAllMsg.kind)}>{gaDeleteAllMsg.text}</div>
            <div className={msgClass(gaMsg.kind)}>{gaMsg.text}</div>
          </div>

          <div className="card ga-card-right">
            <h2>
              Firebase Daily Update <small>User + date</small>
            </h2>
            <div className="card-sub">
              <span className="tag-small">Step 2</span>
              Left side se email row pe click karo ya search karo → Date select → values check karo →{' '}
              <b>Save to Firebase</b>.
            </div>

            <div className="section-title">User Selector</div>
            <div className="row ga-user-row">
              <div className="field">
                <label htmlFor="userSearch">Search by Email</label>
                <input
                  type="text"
                  id="userSearch"
                  placeholder="Type to filter users..."
                  autoComplete="off"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="userSelect">Select User (from Firebase)</label>
                <select
                  id="userSelect"
                  value={selectedEmail ? encodeEmailKey(selectedEmail) : ''}
                  onChange={(e) => {
                    const key = e.target.value
                    if (!key) void applySelection(null)
                    else void applySelection(decodeEmailKey(key))
                  }}
                >
                  <option value="">-- Select a user --</option>
                  {filteredUserKeys.map((key) => (
                    <option key={key} value={key}>
                      {decodeEmailKey(key)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className={msgClass(userListMsg.kind)}>{userListMsg.text}</div>

            <div className="section-title">Selected User & Date</div>
            <div className="row">
              <div className="field">
                <label>Selected Email</label>
                <div className="pill-soft">
                  <span>{selectedEmail || 'None'}</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="fbDate">Date</label>
                <input
                  type="date"
                  id="fbDate"
                  value={fbDate}
                  onChange={(e) => {
                    const v = e.target.value
                    setFbDate(v)
                    if (selectedEmail) void loadDailyFromFirebase(v)
                  }}
                />
              </div>
            </div>

            <div className="section-title">Main Dashboard Summary (auto)</div>
            <div className="summary-grid">
              <div className="summary-item">
                Total Impressions: <strong>{summary.totalImpressions}</strong>
              </div>
              <div className="summary-item">
                Total Earnings ($): <strong>{formatUsd(summary.totalEarnings)}</strong>
              </div>
              <div className="summary-item">
                Today Impressions: <strong>{summary.todayImpressions}</strong>
              </div>
              <div className="summary-item">
                Current CPM ($): <strong>{formatUsd(summary.currentCPM)}</strong>
              </div>
              <div className="summary-item">
                Total Available ($): <strong>{formatUsd(summary.totalAvailable)}</strong>
              </div>
            </div>

            <div className="section-title">Daily Stat (for this email + date)</div>
            <div className="row">
              <div className="field">
                <label htmlFor="fbImpressions">Impressions</label>
                <input
                  type="number"
                  id="fbImpressions"
                  value={fbImpressions}
                  onChange={(e) => setFbImpressions(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="fbEarnings">Earnings (USD $)</label>
                <input
                  type="number"
                  id="fbEarnings"
                  step="0.01"
                  value={fbEarnings}
                  onChange={(e) => setFbEarnings(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="fbCPM">CPM (USD $)</label>
                <input
                  type="number"
                  id="fbCPM"
                  step="0.01"
                  placeholder="Auto = (earnings/imps)*1000"
                  value={fbCPM}
                  onChange={(e) => setFbCPM(e.target.value)}
                />
              </div>
            </div>

            <div className="row" style={{ marginTop: 0 }}>
              <button type="button" onClick={() => void saveDailyToFirebase()}>
                💾 Save to Firebase
              </button>
              <button type="button" className="danger" onClick={() => void deleteDailyFromFirebase()}>
                🗑 Delete Daily Stat
              </button>
              <button type="button" className="secondary" onClick={() => void loadDailyFromFirebase()}>
                🔄 Reload from Firebase
              </button>
            </div>

            <div className={msgClass(fbExistingMsg.kind)}>{fbExistingMsg.text}</div>
            <div className={msgClass(fbMsg.kind)}>{fbMsg.text}</div>

            <div className="section-title">All Daily Stats (history)</div>
            <div className="small-table-wrapper">
              <table className="small-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Impressions</th>
                    <th>Earnings ($)</th>
                    <th>CPM ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {!dailySortedKeys.length ? (
                    <tr>
                      <td colSpan={4}>No daily stats loaded</td>
                    </tr>
                  ) : (
                    dailySortedKeys.map((date) => {
                      const d = currentDailyStats[date] || {}
                      return (
                        <tr key={date}>
                          <td>{date}</td>
                          <td>{safeNum(d.impressions)}</td>
                          <td>{formatUsd(getEarningFromRow(d))}</td>
                          <td>{formatUsd(d.cpm)}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
