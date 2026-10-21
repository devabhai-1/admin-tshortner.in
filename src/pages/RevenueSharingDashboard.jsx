import { useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import { useUsersData } from '../context/usersDataContext.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import {
  decodeEmailKey,
  getEarningFromRow,
  readDailyMap,
  safeNum,
  toFixed2,
} from '../lib/tshortnerSchema.js'
import './RevenueSharingDashboard.css'

const RANGE_DAYS = 90

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

export default function RevenueSharingDashboard() {
  const { usersVal, ready, sessionLoaded, streamProgress, lastSync, refreshUsersData } =
    useUsersData()

  const days = useMemo(() => buildLastNDays(RANGE_DAYS), [])
  const daySet = useMemo(() => new Set(days), [days])
  const today = days[days.length - 1] || isoTodayKolkata()

  const [selectedDate, setSelectedDate] = useState(today)
  const [view, setView] = useState('dates') // dates | users
  const [search, setSearch] = useState('')
  const [sortUsers, setSortUsers] = useState('earn') // earn | email
  const deferredSearch = useDeferredValue(search)

  const isStreaming = streamProgress?.streaming === true

  const analysis = useMemo(() => {
    const byDate = new Map()
    for (const day of days) {
      byDate.set(day, { date: day, total: 0, users: 0, rows: [] })
    }

    const byUser = new Map()
    let grandTotal = 0
    let paidUserCount = 0
    let paidDayCount = 0

    const entries =
      usersVal && typeof usersVal === 'object' ? Object.entries(usersVal) : []

    for (const [emailKey, raw] of entries) {
      if (!raw || typeof raw !== 'object') continue
      const email =
        String(raw.profile?.email || '').trim() || decodeEmailKey(emailKey)
      if (!email.includes('@')) continue

      const daily = readDailyMap(raw.dashboard)
      let userTotal = 0
      const userDays = []

      for (const [date, row] of Object.entries(daily)) {
        if (!daySet.has(date)) continue
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
        const rows = (bucket?.rows || [])
          .slice()
          .sort((a, b) => b.earning - a.earning)
        if (total > 0) paidDayCount += 1
        return {
          date,
          total,
          users: bucket?.users || 0,
          rows,
        }
      })
      .reverse()

    const userRows = [...byUser.values()].sort((a, b) => b.total - a.total)

    return {
      dateRows,
      userRows,
      grandTotal: toFixed2(grandTotal),
      paidUserCount,
      paidDayCount,
      scannedUsers: entries.length,
    }
  }, [usersVal, days, daySet])

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

  const q = deferredSearch.trim().toLowerCase()

  const filteredDateRows = useMemo(() => {
    if (!q) return analysis.dateRows
    return analysis.dateRows.filter(
      (row) =>
        row.date.includes(q) ||
        row.rows.some((u) => u.email.toLowerCase().includes(q)),
    )
  }, [analysis.dateRows, q])

  const filteredUserRows = useMemo(() => {
    let list = analysis.userRows
    if (q) list = list.filter((row) => row.email.toLowerCase().includes(q))
    if (sortUsers === 'email') {
      list = list.slice().sort((a, b) => a.email.localeCompare(b.email))
    }
    return list
  }, [analysis.userRows, q, sortUsers])

  const selectedDayFiltered = useMemo(() => {
    if (!q) return selectedDay.rows
    return selectedDay.rows.filter((row) => row.email.toLowerCase().includes(q))
  }, [selectedDay.rows, q])

  const avgPerPaidDay =
    analysis.paidDayCount > 0
      ? toFixed2(analysis.grandTotal / analysis.paidDayCount)
      : 0

  return (
    <div className="rev-share">
      <header className="rev-share__hero">
        <div>
          <h1>
            Date Total Revenue Sharing
            <span className={'rev-share__pill ' + (sessionLoaded && !isStreaming ? 'on' : '')}>
              {isStreaming ? '⟳ Loading' : sessionLoaded ? '● Ready' : '○ …'}
            </span>
          </h1>
          <p>
            Last {RANGE_DAYS} days — har date pe kitne dollar user ko share kiye (Firebase{' '}
            <code>dashboard/daily.earning</code>). GA4 save ke baad yahi ledger dikhta hai.
            {isStreaming && streamProgress
              ? ` Loading ${formatInt(streamProgress.loaded)} / ${formatInt(streamProgress.total)}…`
              : ''}
          </p>
        </div>
        <AdminSectionNav />
      </header>

      <div className="rev-share__kpi">
        <div className="rev-share__kpi-card highlight">
          <span>{RANGE_DAYS}-day shared ($)</span>
          <strong>{ready ? formatUsd(analysis.grandTotal) : '…'}</strong>
          <small>
            {ready
              ? `${formatInt(analysis.paidDayCount)} days with payout`
              : 'loading'}
          </small>
        </div>
        <div className="rev-share__kpi-card">
          <span>Users paid</span>
          <strong>{ready ? formatInt(analysis.paidUserCount) : '…'}</strong>
          <small>of {formatInt(analysis.scannedUsers)} scanned</small>
        </div>
        <div className="rev-share__kpi-card ok">
          <span>Selected day</span>
          <strong>{formatUsd(selectedDay.total)}</strong>
          <small>
            {formatDayLabel(selectedDate)} · {formatInt(selectedDay.users)} users
          </small>
        </div>
        <div className="rev-share__kpi-card">
          <span>Avg / paid day</span>
          <strong>{ready ? formatUsd(avgPerPaidDay) : '…'}</strong>
          <small>only days with &gt; $0</small>
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
            min={days[0]}
            max={today}
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
          onClick={() => refreshUsersData()}
          disabled={isStreaming}
        >
          Refresh
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
              Daily totals <small>{RANGE_DAYS} days · newest first</small>
            </h2>
            <div className="rev-share__table-wrap">
              <table className="rev-share__table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Users</th>
                    <th>Shared ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {!ready && !filteredDateRows.length ? (
                    <tr>
                      <td colSpan={4} className="rev-share__empty">
                        Users load ho rahe hain…
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
                      <td className="num">{formatUsd(row.total)}</td>
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
                {formatUsd(selectedDay.total)} · {formatInt(selectedDayFiltered.length)} users
              </small>
            </h2>
            <div className="rev-share__table-wrap">
              <table className="rev-share__table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Email</th>
                    <th>Impressions</th>
                    <th>Shared ($)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!selectedDayFiltered.length ? (
                    <tr>
                      <td colSpan={5} className="rev-share__empty">
                        Is date pe koi earning share nahi hai.
                      </td>
                    </tr>
                  ) : (
                    selectedDayFiltered.map((row, i) => (
                      <tr key={row.emailKey}>
                        <td>{i + 1}</td>
                        <td className="mail">{row.email}</td>
                        <td className="num">{formatInt(row.impressions)}</td>
                        <td className="num">{formatUsd(row.earning)}</td>
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
            Users — {RANGE_DAYS}-day total
            <small>
              {formatInt(filteredUserRows.length)} users · {formatUsd(analysis.grandTotal)}
            </small>
          </h2>
          <div className="rev-share__table-wrap">
            <table className="rev-share__table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Email</th>
                  <th>Days paid</th>
                  <th>Total shared ($)</th>
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
                {!filteredUserRows.length && ready ? (
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
                      <td className="num strong">{formatUsd(row.total)}</td>
                      <td>
                        {latest
                          ? `${formatDayLabel(latest.date)} · ${formatUsd(latest.earning)}`
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
