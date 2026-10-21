import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import { formatInt, formatInr, formatUsd, usdToInr } from '../lib/formatMoney.js'
import {
  decodeEmailKey,
  getEarningFromRow,
  normalizeDailyRow,
  safeNum,
  toFixed2,
} from '../lib/tshortnerSchema.js'
import './RevenueSharingDashboard.css'

const RANGE_DAYS = 90
/** 1 USD = 93 INR — brackets me rupee dikhane ke liye */
const USD_TO_INR = 93
const FB_BASE =
  import.meta.env.VITE_FIREBASE_DATABASE_URL ||
  'https://tshortner-in-default-rtdb.asia-southeast1.firebasedatabase.app'
const CACHE_KEY = 'tshortner.admin.revenueShare.v1'
const FETCH_CONCURRENCY = 48
const FETCH_TIMEOUT_MS = 8000

function formatUsdInr(n) {
  return `${formatUsd(n)} (${formatInr(usdToInr(n, USD_TO_INR))})`
}

function isoTodayKolkata() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function addDaysIso(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + delta))
  return dt.toISOString().slice(0, 10)
}

function buildLastNDays(n) {
  const end = isoTodayKolkata()
  const days = []
  for (let i = n - 1; i >= 0; i -= 1) days.push(addDaysIso(end, -i))
  return days
}

function formatDayLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
}

function weekdayLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number)
  if (!y || !m || !d) return ''
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    timeZone: 'UTC',
  })
}

function readCache(today) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.today !== today || !Array.isArray(parsed.dateRows)) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(payload) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* quota */
  }
}

function emptyAnalysis(days) {
  return {
    dateRows: [...days]
      .reverse()
      .map((date) => ({ date, total: 0, users: 0, rows: [] })),
    userRows: [],
    grandTotal: 0,
    paidUserCount: 0,
    paidDayCount: 0,
    scannedUsers: 0,
  }
}

function buildAnalysis(userDailyList, days, daySet) {
  const byDate = new Map()
  for (const day of days) {
    byDate.set(day, { date: day, total: 0, users: 0, rows: [] })
  }

  const byUser = new Map()
  let grandTotal = 0
  let paidUserCount = 0
  let paidDayCount = 0

  for (const item of userDailyList) {
    const { emailKey, email, daily } = item
    let userTotal = 0
    const userDays = []

    for (const [date, rawRow] of Object.entries(daily || {})) {
      if (!daySet.has(date)) continue
      const row = normalizeDailyRow(rawRow)
      const earn = toFixed2(getEarningFromRow(row))
      if (earn <= 0) continue
      const imps = safeNum(row.impressions)
      userTotal += earn
      userDays.push({ date, earning: earn, impressions: imps, cpm: safeNum(row.cpm) })

      const bucket = byDate.get(date)
      if (bucket) {
        bucket.total += earn
        bucket.users += 1
        bucket.rows.push({ email, emailKey, earning: earn, impressions: imps })
      }
    }

    if (userTotal > 0) {
      paidUserCount += 1
      userDays.sort((a, b) => (a.date < b.date ? 1 : -1))
      byUser.set(emailKey, {
        email,
        emailKey,
        total: toFixed2(userTotal),
        days: userDays,
        dayCount: userDays.length,
      })
      grandTotal += userTotal
    }
  }

  const dateRows = days
    .map((date) => {
      const bucket = byDate.get(date)
      const total = toFixed2(bucket?.total || 0)
      const rows = (bucket?.rows || []).slice().sort((a, b) => b.earning - a.earning)
      if (total > 0) paidDayCount += 1
      return {
        date,
        total,
        users: bucket?.users || 0,
        rows,
      }
    })
    .reverse()

  return {
    dateRows,
    userRows: [...byUser.values()].sort((a, b) => b.total - a.total),
    grandTotal: toFixed2(grandTotal),
    paidUserCount,
    paidDayCount,
    scannedUsers: userDailyList.length,
  }
}

async function fetchJson(url, parentSignal) {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (parentSignal) {
    if (parentSignal.aborted) {
      ac.abort()
    } else {
      parentSignal.addEventListener('abort', onAbort, { once: true })
    }
  }
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort)
  }
}

async function mapPool(items, concurrency, fn, signal) {
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      if (signal?.aborted) return
      const idx = cursor
      cursor += 1
      await fn(items[idx], idx)
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
}

/** Sirf earning wale users ka daily — poora users dump skip */
async function loadUserDailyMaps(preferredKeys, onProgress, signal) {
  let keys = Array.isArray(preferredKeys) ? preferredKeys.filter(Boolean) : []
  let totalKeys = keys.length

  if (!keys.length) {
    const keysObj = await fetchJson(`${FB_BASE}/users.json?shallow=true`, signal)
    const allKeys = Object.keys(keysObj || {})
    totalKeys = allKeys.length
    const paid = []
    let scanned = 0
    await mapPool(
      allKeys,
      60,
      async (emailKey) => {
        try {
          const te = await fetchJson(
            `${FB_BASE}/users/${encodeURIComponent(emailKey)}/dashboard/totalEarning.json`,
            signal,
          )
          if (safeNum(te) > 0) paid.push(emailKey)
        } catch {
          /* skip */
        }
        scanned += 1
        if (scanned % 80 === 0 || scanned === allKeys.length) {
          onProgress({
            phase: 'filter',
            loaded: scanned,
            total: allKeys.length,
            usersWithDaily: paid.length,
            list: [],
          })
        }
      },
      signal,
    )
    keys = paid
  }

  const out = []
  let done = 0
  await mapPool(
    keys,
    FETCH_CONCURRENCY,
    async (emailKey) => {
      try {
        const daily = await fetchJson(
          `${FB_BASE}/users/${encodeURIComponent(emailKey)}/dashboard/daily.json`,
          signal,
        )
        if (daily && typeof daily === 'object') {
          out.push({
            emailKey,
            email: decodeEmailKey(emailKey),
            daily,
          })
        }
      } catch {
        /* skip failed user */
      }
      done += 1
      if (done % 20 === 0 || done === keys.length) {
        onProgress({
          phase: 'daily',
          loaded: done,
          total: keys.length,
          usersWithDaily: out.length,
          list: out,
        })
      }
    },
    signal,
  )

  return { list: out, totalKeys: totalKeys || keys.length, paidKeys: keys.length }
}

export default function RevenueSharingDashboard() {
  const days = useMemo(() => buildLastNDays(RANGE_DAYS), [])
  const daySet = useMemo(() => new Set(days), [days])
  const today = days[days.length - 1] || isoTodayKolkata()

  const cached = useMemo(() => readCache(today), [today])
  const [analysis, setAnalysis] = useState(() => cached || emptyAnalysis(days))
  const [ready, setReady] = useState(() => !!cached)
  const [loading, setLoading] = useState(() => !cached)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [lastSync, setLastSync] = useState(() => cached?.t || null)
  const [fromCache, setFromCache] = useState(() => !!cached)

  const [selectedDate, setSelectedDate] = useState(today)
  const [rangeFrom, setRangeFrom] = useState(() => addDaysIso(today, -6))
  const [rangeTo, setRangeTo] = useState(today)
  const [view, setView] = useState('dates')
  const [search, setSearch] = useState('')
  const [sortUsers, setSortUsers] = useState('earn')
  const deferredSearch = useDeferredValue(search)
  const abortRef = useRef(null)
  const runIdRef = useRef(0)

  const minDay = days[0] || today
  const from = rangeFrom <= rangeTo ? rangeFrom : rangeTo
  const to = rangeFrom <= rangeTo ? rangeTo : rangeFrom

  const clampDate = (iso) => {
    if (!iso) return today
    if (iso < minDay) return minDay
    if (iso > today) return today
    return iso
  }

  const setPreset = (n) => {
    setRangeFrom(clampDate(addDaysIso(today, -(n - 1))))
    setRangeTo(today)
  }

  const runLoad = (force = false) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const runId = ++runIdRef.current

    setLoading(true)
    setError('')
    if (!force && cached) {
      setFromCache(true)
      setReady(true)
    } else if (force) {
      setFromCache(false)
      setAnalysis(emptyAnalysis(days))
    }

    void (async () => {
      try {
        const { list, totalKeys, paidKeys } = await loadUserDailyMaps(
          [],
          (p) => {
            if (runId !== runIdRef.current) return
            setProgress({
              phase: p.phase,
              loaded: p.loaded,
              total: p.total,
              usersWithDaily: p.usersWithDaily,
            })
            if (
              p.phase === 'daily' &&
              p.list?.length &&
              (p.loaded % 40 === 0 || p.loaded === p.total)
            ) {
              startTransition(() => {
                const snap = buildAnalysis(p.list.slice(), days, daySet)
                snap.scannedUsers = p.total
                setAnalysis(snap)
                setReady(true)
              })
            }
          },
          ac.signal,
        )

        if (runId !== runIdRef.current) return

        const next = buildAnalysis(list, days, daySet)
        next.scannedUsers = totalKeys || paidKeys
        setAnalysis(next)
        setReady(true)
        setFromCache(false)
        const t = Date.now()
        setLastSync(t)
        writeCache({ today, t, ...next })
        setProgress(null)
      } catch (err) {
        if (runId !== runIdRef.current) return
        if (err?.name === 'AbortError') return
        setError(err?.message || 'Load failed')
      } finally {
        if (runId === runIdRef.current) setLoading(false)
      }
    })()
  }

  useEffect(() => {
    runLoad(false)
    return () => {
      runIdRef.current += 1
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today])

  useEffect(() => {
    if (selectedDate < from || selectedDate > to) setSelectedDate(to)
  }, [from, to, selectedDate])

  const selectedDay = useMemo(() => {
    return (
      analysis.dateRows.find((row) => row.date === selectedDate) || {
        date: selectedDate,
        total: 0,
        users: 0,
        rows: [],
      }
    )
  }, [analysis.dateRows, selectedDate])

  const rangeStats = useMemo(() => {
    let total = 0
    let paidDays = 0
    const mailSet = new Set()
    for (const row of analysis.dateRows) {
      if (row.date < from || row.date > to) continue
      total += safeNum(row.total)
      if (safeNum(row.total) > 0) paidDays += 1
      for (const u of row.rows) mailSet.add(u.emailKey)
    }
    return {
      total: toFixed2(total),
      paidDays,
      users: mailSet.size,
      daySpan: Math.max(0, days.filter((d) => d >= from && d <= to).length),
    }
  }, [analysis.dateRows, from, to, days])

  const q = deferredSearch.trim().toLowerCase()

  const filteredDateRows = useMemo(() => {
    let list = analysis.dateRows.filter((row) => row.date >= from && row.date <= to)
    if (q) {
      list = list.filter(
        (row) =>
          row.date.includes(q) ||
          row.rows.some((u) => u.email.toLowerCase().includes(q)),
      )
    }
    return list
  }, [analysis.dateRows, from, to, q])

  const filteredUserRows = useMemo(() => {
    let list = analysis.userRows
      .map((row) => {
        const inRange = (row.days || []).filter((d) => d.date >= from && d.date <= to)
        if (!inRange.length) return null
        const total = toFixed2(inRange.reduce((s, d) => s + safeNum(d.earning), 0))
        if (total <= 0) return null
        return {
          ...row,
          total,
          days: inRange,
          dayCount: inRange.length,
        }
      })
      .filter(Boolean)

    if (q) list = list.filter((row) => row.email.toLowerCase().includes(q))
    if (sortUsers === 'email') {
      list = list.slice().sort((a, b) => a.email.localeCompare(b.email))
    } else {
      list = list.slice().sort((a, b) => b.total - a.total)
    }
    return list
  }, [analysis.userRows, from, to, q, sortUsers])

  const selectedDayFiltered = useMemo(() => {
    if (!q) return selectedDay.rows
    return selectedDay.rows.filter((row) => row.email.toLowerCase().includes(q))
  }, [selectedDay.rows, q])

  const avgPerPaidDay =
    rangeStats.paidDays > 0 ? toFixed2(rangeStats.total / rangeStats.paidDays) : 0

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : loading
        ? 5
        : 100

  return (
    <div className="rev-share">
      <header className="rev-share__hero">
        <div>
          <h1>
            Date Total Revenue Sharing
            <span
              className={
                'rev-share__pill ' + (ready && !loading ? 'on' : loading ? 'load' : '')
              }
            >
              {loading
                ? `⟳ ${pct}%`
                : ready
                  ? fromCache
                    ? '● Cache'
                    : '● Ready'
                  : '○ …'}
            </span>
          </h1>
          <p>
            Last {RANGE_DAYS} days — har date pe kitne dollar user ko share kiye. Dollar ke saath ₹
            brackets me (1$ = ₹{USD_TO_INR}). Lightweight load: pehle earning filter, phir daily.
            {loading && progress
              ? ` · ${progress.phase === 'filter' ? 'filter' : 'daily'} ${formatInt(progress.loaded)} / ${formatInt(progress.total)}`
              : ''}
          </p>
          {loading ? (
            <div className="rev-share__bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {error ? <p className="rev-share__err">⚠ {error}</p> : null}
        </div>
        <AdminSectionNav />
      </header>

      <div className="rev-share__range-bar">
        <label className="rev-share__date">
          <span>From date</span>
          <input
            type="date"
            value={from}
            min={minDay}
            max={to}
            onChange={(e) => setRangeFrom(clampDate(e.target.value))}
          />
        </label>
        <label className="rev-share__date">
          <span>To date</span>
          <input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setRangeTo(clampDate(e.target.value))}
          />
        </label>
        <div className="rev-share__presets">
          <button type="button" onClick={() => setPreset(7)}>
            7d
          </button>
          <button type="button" onClick={() => setPreset(30)}>
            30d
          </button>
          <button type="button" onClick={() => setPreset(RANGE_DAYS)}>
            90d
          </button>
        </div>
        <div className="rev-share__range-total">
          <span>
            Range total · {formatDayLabel(from)} → {formatDayLabel(to)}
          </span>
          <strong>{ready ? formatUsdInr(rangeStats.total) : '…'}</strong>
        </div>
      </div>

      <div className="rev-share__kpi">
        <div className="rev-share__kpi-card highlight">
          <span>Selected range total</span>
          <strong>{ready ? formatUsdInr(rangeStats.total) : '…'}</strong>
          <small>
            {formatDayLabel(from)} → {formatDayLabel(to)} · {formatInt(rangeStats.daySpan)} days
          </small>
        </div>
        <div className="rev-share__kpi-card">
          <span>Users in range</span>
          <strong>{ready ? formatInt(rangeStats.users) : '…'}</strong>
          <small>{formatInt(rangeStats.paidDays)} days with payout</small>
        </div>
        <div className="rev-share__kpi-card ok">
          <span>Focus day</span>
          <strong>{formatUsdInr(selectedDay.total)}</strong>
          <small>
            {formatDayLabel(selectedDate)} · {formatInt(selectedDay.users)} users
          </small>
        </div>
        <div className="rev-share__kpi-card">
          <span>Avg / paid day</span>
          <strong>{ready ? formatUsdInr(avgPerPaidDay) : '…'}</strong>
          <small>inside selected range</small>
        </div>
        <div className="rev-share__kpi-card">
          <span>Full {RANGE_DAYS}-day</span>
          <strong>{ready ? formatUsdInr(analysis.grandTotal) : '…'}</strong>
          <small>{formatInt(analysis.paidUserCount)} users all-time in window</small>
        </div>
      </div>

      <div className="rev-share__toolbar">
        <div className="rev-share__tabs">
          <button
            type="button"
            className={view === 'dates' ? 'on' : ''}
            onClick={() => setView('dates')}
          >
            By Date
          </button>
          <button
            type="button"
            className={view === 'users' ? 'on' : ''}
            onClick={() => setView('users')}
          >
            By User
          </button>
        </div>
        <label className="rev-share__search">
          <span>Search mail / date</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="uttam… or 2026-10-13"
          />
        </label>
        <label className="rev-share__date">
          <span>Focus date</span>
          <input
            type="date"
            value={selectedDate}
            min={from}
            max={to}
            onChange={(e) => {
              setSelectedDate(e.target.value)
              setView('dates')
            }}
          />
        </label>
        {view === 'users' ? (
          <label className="rev-share__sort">
            <span>Sort</span>
            <select value={sortUsers} onChange={(e) => setSortUsers(e.target.value)}>
              <option value="earn">Highest $ first</option>
              <option value="email">Email A–Z</option>
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className="rev-share__refresh"
          onClick={() => {
            try {
              sessionStorage.removeItem(CACHE_KEY)
            } catch {
              /* ignore */
            }
            void runLoad(true)
          }}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {lastSync ? (
          <span className="rev-share__sync">
            Synced {new Date(lastSync).toLocaleTimeString('en-IN')}
          </span>
        ) : null}
      </div>

      {view === 'dates' ? (
        <div className="rev-share__split">
          <section className="rev-share__panel">
            <h2>
              Daily totals{' '}
              <small>
                {formatDayLabel(from)} → {formatDayLabel(to)} · {formatUsdInr(rangeStats.total)}
              </small>
            </h2>
            <div className="rev-share__table-wrap">
              <table className="rev-share__table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Users</th>
                    <th>Shared ($ / ₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {!ready && !filteredDateRows.some((r) => r.total > 0) ? (
                    <tr>
                      <td colSpan={4} className="rev-share__empty">
                        Daily earning load ho rahi hai…
                      </td>
                    </tr>
                  ) : null}
                  {filteredDateRows.map((row) => (
                    <tr
                      key={row.date}
                      className={
                        (row.date === selectedDate ? 'selected ' : '') +
                        (row.total > 0 ? 'has-earn' : 'zero')
                      }
                      onClick={() => setSelectedDate(row.date)}
                    >
                      <td>{formatDayLabel(row.date)}</td>
                      <td>{weekdayLabel(row.date)}</td>
                      <td>{formatInt(row.users)}</td>
                      <td className="num">{formatUsdInr(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rev-share__panel">
            <h2>
              {formatDayLabel(selectedDate)} — user breakdown
              <small>
                {formatUsdInr(selectedDay.total)} · {formatInt(selectedDayFiltered.length)} users
              </small>
            </h2>
            <div className="rev-share__table-wrap">
              <table className="rev-share__table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Email</th>
                    <th>Impressions</th>
                    <th>Shared ($ / ₹)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!selectedDayFiltered.length ? (
                    <tr>
                      <td colSpan={5} className="rev-share__empty">
                        {loading
                          ? 'Load chal raha hai — thodi der me users aayenge…'
                          : 'Is date pe koi earning share nahi hai.'}
                      </td>
                    </tr>
                  ) : (
                    selectedDayFiltered.map((row, i) => (
                      <tr key={row.emailKey}>
                        <td>{i + 1}</td>
                        <td className="mail">{row.email}</td>
                        <td className="num">{formatInt(row.impressions)}</td>
                        <td className="num">{formatUsdInr(row.earning)}</td>
                        <td>
                          <Link to="/mail">Mail</Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : (
        <section className="rev-share__panel full">
          <h2>
            Users — range total
            <small>
              {formatInt(filteredUserRows.length)} users · {formatUsdInr(rangeStats.total)}
            </small>
          </h2>
          <div className="rev-share__table-wrap">
            <table className="rev-share__table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Email</th>
                  <th>Days paid</th>
                  <th>Total shared ($ / ₹)</th>
                  <th>Latest day</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {!ready && !filteredUserRows.length ? (
                  <tr>
                    <td colSpan={6} className="rev-share__empty">
                      Users load ho rahe hain…
                    </td>
                  </tr>
                ) : null}
                {!filteredUserRows.length && ready && !loading ? (
                  <tr>
                    <td colSpan={6} className="rev-share__empty">
                      Is range me koi shared earning nahi mili.
                    </td>
                  </tr>
                ) : null}
                {filteredUserRows.map((row, i) => {
                  const latest = row.days[0]
                  return (
                    <tr key={row.emailKey}>
                      <td>{i + 1}</td>
                      <td className="mail">{row.email}</td>
                      <td className="num">{formatInt(row.dayCount)}</td>
                      <td className="num strong">{formatUsdInr(row.total)}</td>
                      <td>
                        {latest
                          ? `${formatDayLabel(latest.date)} · ${formatUsdInr(latest.earning)}`
                          : '—'}
                      </td>
                      <td>
                        <Link to="/mail">Mail</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
