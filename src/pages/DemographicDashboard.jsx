import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './DemographicDashboard.css'

function isoDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtInt(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(n) || 0)
}

function fmtDec(n, digits = 2) {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(n) || 0)
}

function fmtPct(rate) {
  const n = Number(rate) || 0
  const pct = n <= 1 ? n * 100 : n
  return `${fmtDec(pct, 2)}%`
}

function fmtShare(part, total) {
  const t = Number(total) || 0
  if (!t) return '0%'
  return `${fmtDec((Number(part) / t) * 100, 2)}%`
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m ${r}s` : `${m}m`
}

function fmtInr(n) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(n) || 0)
}

function shortDate(iso) {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
  return `${Number(d)} ${months[Number(m) - 1] || m}`
}

const COLORS = ['#1a73e8', '#e37400', '#0d904f', '#d93025', '#9334e6', '#12b5cb', '#e52592', '#5f6368']

function CountryChart({ series, countries }) {
  const width = 920
  const height = 260
  const pad = { l: 52, r: 16, t: 16, b: 36 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b

  const max = Math.max(
    1,
    ...series.flatMap((row) => countries.map((c) => Number(row[c]) || 0)),
  )
  const ticks = 4
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => Math.round((max / ticks) * i))

  const xAt = (i) => {
    if (series.length <= 1) return pad.l + innerW / 2
    return pad.l + (i / (series.length - 1)) * innerW
  }
  const yAt = (v) => pad.t + innerH - (v / max) * innerH

  return (
    <svg className="demo-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Active users by country">
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={width - pad.r} y1={yAt(t)} y2={yAt(t)} className="demo-chart__grid" />
          <text x={pad.l - 8} y={yAt(t) + 4} className="demo-chart__axis" textAnchor="end">
            {t >= 1000 ? `${Math.round(t / 1000)}K` : t}
          </text>
        </g>
      ))}
      {countries.map((country, ci) => {
        const pts = series
          .map((row, i) => `${xAt(i)},${yAt(Number(row[country]) || 0)}`)
          .join(' ')
        return (
          <polyline
            key={country}
            points={pts}
            fill="none"
            stroke={COLORS[ci % COLORS.length]}
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      })}
      {series.map((row, i) => (
        <text key={row.date} x={xAt(i)} y={height - 10} className="demo-chart__axis" textAnchor="middle">
          {shortDate(row.date)}
        </text>
      ))}
    </svg>
  )
}

export default function DemographicDashboard() {
  const [startDate, setStartDate] = useState(isoDaysAgo(3))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [applied, setApplied] = useState({ start: isoDaysAgo(3), end: isoDaysAgo(0) })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const load = useCallback(async (start, end) => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(
        `/api/analytics/demographics?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`,
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`)
      setData(json)
      setPage(1)
    } catch (e) {
      setError(e.message || 'Could not load demographics')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(applied.start, applied.end)
  }, [applied, load])

  const filtered = useMemo(() => {
    const rows = data?.rows || []
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => String(r.country || '').toLowerCase().includes(q))
  }, [data, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const totals = data?.totals

  const applyRange = (start, end) => {
    setStartDate(start)
    setEndDate(end)
    setApplied({ start, end })
  }

  return (
    <div className="demo-root">
      <AdminSectionNav />
      <header className="demo-head">
        <div>
          <p className="demo-kicker">Analytics</p>
          <h1>Demographic details: Country</h1>
          <p className="demo-sub">
            Daily country report from GA4. Date select karke active users, sessions, engagement aur revenue dekho.
          </p>
        </div>
        <div className="demo-range">
          <label>
            From
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <button type="button" onClick={() => applyRange(startDate, endDate)} disabled={loading}>
            {loading ? 'Loading…' : 'Apply'}
          </button>
        </div>
      </header>

      <div className="demo-presets">
        <button type="button" onClick={() => applyRange(isoDaysAgo(0), isoDaysAgo(0))}>Today</button>
        <button type="button" onClick={() => applyRange(isoDaysAgo(1), isoDaysAgo(1))}>Yesterday</button>
        <button type="button" onClick={() => applyRange(isoDaysAgo(6), isoDaysAgo(0))}>Last 7 days</button>
        <button type="button" onClick={() => applyRange(isoDaysAgo(27), isoDaysAgo(0))}>Last 28 days</button>
        <span className="demo-note">This report uses 100% of available GA4 data for the selected dates.</span>
      </div>

      {error ? <p className="demo-error">{error}</p> : null}

      <section className="demo-card">
        <div className="demo-card__head">
          <h2>Active users by Country over time</h2>
          <span>Day</span>
        </div>
        {data?.series?.length ? (
          <>
            <CountryChart series={data.series} countries={data.seriesCountries || []} />
            <ul className="demo-legend">
              {(data.seriesCountries || []).map((c, i) => (
                <li key={c}>
                  <i style={{ background: COLORS[i % COLORS.length] }} />
                  {c}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="demo-empty">{loading ? 'Chart load ho raha hai…' : 'Is date range me data nahi mila.'}</p>
        )}
      </section>

      <section className="demo-card">
        <div className="demo-toolbar">
          <input
            type="search"
            placeholder="Search country…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
          />
          <label>
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                setPage(1)
              }}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <span className="demo-count">
            {filtered.length ? `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)} of ${filtered.length}` : '0 rows'}
          </span>
        </div>

        <div className="demo-table-wrap">
          <table className="demo-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Country</th>
                <th>Active users</th>
                <th>New users</th>
                <th>Engaged sessions</th>
                <th>Engagement rate</th>
                <th>Engaged sessions / user</th>
                <th>Avg engagement time</th>
                <th>Event count</th>
                <th>Key events</th>
                <th>User key event rate</th>
                <th>Total revenue</th>
              </tr>
            </thead>
            <tbody>
              {totals ? (
                <tr className="demo-total">
                  <td />
                  <td>Total</td>
                  <td>{fmtInt(totals.activeUsers)}<small>100%</small></td>
                  <td>{fmtInt(totals.newUsers)}<small>100%</small></td>
                  <td>{fmtInt(totals.engagedSessions)}<small>100%</small></td>
                  <td>{fmtPct(totals.engagementRate)}</td>
                  <td>{fmtDec(totals.engagedSessionsPerActiveUser, 2)}</td>
                  <td>{fmtDuration(totals.avgEngagementTime)}</td>
                  <td>{fmtInt(totals.eventCount)}<small>100%</small></td>
                  <td>{fmtDec(totals.keyEvents, 2)}</td>
                  <td>{fmtPct(totals.userKeyEventRate)}</td>
                  <td>{fmtInr(totals.totalRevenue)}<small>100%</small></td>
                </tr>
              ) : null}
              {pageRows.map((r, i) => {
                const index = (safePage - 1) * pageSize + i + 1
                return (
                  <tr key={r.country}>
                    <td>{index}</td>
                    <td>{r.country}</td>
                    <td>{fmtInt(r.activeUsers)}<small>{fmtShare(r.activeUsers, totals?.activeUsers)}</small></td>
                    <td>{fmtInt(r.newUsers)}<small>{fmtShare(r.newUsers, totals?.newUsers)}</small></td>
                    <td>{fmtInt(r.engagedSessions)}<small>{fmtShare(r.engagedSessions, totals?.engagedSessions)}</small></td>
                    <td>{fmtPct(r.engagementRate)}</td>
                    <td>{fmtDec(r.engagedSessionsPerActiveUser, 2)}</td>
                    <td>{fmtDuration(r.avgEngagementTime)}</td>
                    <td>{fmtInt(r.eventCount)}<small>{fmtShare(r.eventCount, totals?.eventCount)}</small></td>
                    <td>{fmtDec(r.keyEvents, 2)}</td>
                    <td>{fmtPct(r.userKeyEventRate)}</td>
                    <td>{fmtInr(r.totalRevenue)}<small>{fmtShare(r.totalRevenue, totals?.totalRevenue)}</small></td>
                  </tr>
                )
              })}
              {!loading && !pageRows.length ? (
                <tr>
                  <td colSpan={12} className="demo-empty">Koi country nahi mili.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="demo-pager">
          <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
          <span>Page {safePage} / {pageCount}</span>
          <button type="button" disabled={safePage >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </section>
    </div>
  )
}
