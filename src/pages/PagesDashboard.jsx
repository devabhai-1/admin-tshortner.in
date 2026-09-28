import { useEffect, useMemo, useState } from 'react'
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

const COLORS = ['#9aa0a6', '#1a73e8', '#e37400', '#0d904f', '#d93025', '#9334e6']

function ViewsChart({ series, paths }) {
  const lines = ['Total', ...paths]
  const width = 920
  const height = 260
  const pad = { l: 52, r: 16, t: 16, b: 36 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const max = Math.max(1, ...series.flatMap((row) => lines.map((key) => Number(row[key]) || 0)))
  const yTicks = Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i))
  const xAt = (i) => (series.length <= 1 ? pad.l + innerW / 2 : pad.l + (i / (series.length - 1)) * innerW)
  const yAt = (v) => pad.t + innerH - (v / max) * innerH
  const label = (n) => {
    if (n >= 100000) return `${Math.round(n / 100000)}L`
    if (n >= 1000) return `${Math.round(n / 1000)}K`
    return String(n)
  }

  return (
    <svg className="demo-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Views by page">
      {yTicks.map((tick) => (
        <g key={tick}>
          <line x1={pad.l} x2={width - pad.r} y1={yAt(tick)} y2={yAt(tick)} className="demo-chart__grid" />
          <text x={pad.l - 8} y={yAt(tick) + 4} className="demo-chart__axis" textAnchor="end">{label(tick)}</text>
        </g>
      ))}
      {lines.map((key, index) => (
        <polyline
          key={key}
          points={series.map((row, i) => `${xAt(i)},${yAt(Number(row[key]) || 0)}`).join(' ')}
          fill="none"
          stroke={COLORS[index % COLORS.length]}
          strokeWidth={key === 'Total' ? 2.8 : 2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {series.map((row, i) => (
        <text key={row.date} x={xAt(i)} y={height - 10} className="demo-chart__axis" textAnchor="middle">
          {shortDate(row.date)}
        </text>
      ))}
    </svg>
  )
}

export default function PagesDashboard() {
  const [startDate, setStartDate] = useState(isoDaysAgo(6))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [draftStart, setDraftStart] = useState(isoDaysAgo(6))
  const [draftEnd, setDraftEnd] = useState(isoDaysAgo(0))
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [pageSize, setPageSize] = useState(10)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim())
      setOffset(0)
    }, 350)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      limit: String(pageSize),
      offset: String(offset),
    })
    if (search) params.set('q', search)
    apiFetch(`/api/analytics/pages?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || 'Pages report nahi aaya')
        setData(body)
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError(err.message || 'Pages report nahi aaya')
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [startDate, endDate, pageSize, offset, search])

  const totals = data?.totals
  const rows = data?.rows || []
  const rowCount = Number(data?.rowCount || 0)
  const page = Math.floor(offset / pageSize) + 1
  const pages = Math.max(1, Math.ceil(rowCount / pageSize))
  const legend = useMemo(() => ['Total', ...(data?.seriesPaths || [])], [data])

  const applyRange = (start, end) => {
    setDraftStart(start)
    setDraftEnd(end)
    setStartDate(start)
    setEndDate(end)
    setOffset(0)
  }

  return (
    <div className="demo-root">
      <AdminSectionNav />
      <header className="demo-head">
        <div>
          <p className="demo-kicker">Analytics</p>
          <h1>Pages and screens</h1>
          <p className="demo-sub">
            GA4 ka page path report. Har `/x/` aur `/v/` link ki views aur kamai yahin hai. Currency INR.
          </p>
        </div>
        <div className="demo-range">
          <label>
            Start
            <input type="date" value={draftStart} max={draftEnd} onChange={(e) => setDraftStart(e.target.value)} />
          </label>
          <label>
            End
            <input type="date" value={draftEnd} min={draftStart} max={isoDaysAgo(0)} onChange={(e) => setDraftEnd(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={loading}
            onClick={() => applyRange(draftStart, draftEnd)}
          >
            Apply
          </button>
        </div>
      </header>

      <div className="demo-presets">
        <button type="button" onClick={() => applyRange(isoDaysAgo(0), isoDaysAgo(0))}>Today</button>
        <button type="button" onClick={() => applyRange(isoDaysAgo(6), isoDaysAgo(0))}>Last 7 days</button>
        <button type="button" onClick={() => applyRange(isoDaysAgo(27), isoDaysAgo(0))}>Last 28 days</button>
        <span className="demo-count">{fmtInt(rowCount)} pages</span>
      </div>

      {error ? <p className="demo-error">{error}</p> : null}

      <section className="demo-card">
        <div className="demo-card__head">
          <h2>Views by page path</h2>
          <span className="demo-note">{loading ? 'Loading…' : `${startDate} to ${endDate}`}</span>
        </div>
        {data?.series?.length ? <ViewsChart series={data.series} paths={data.seriesPaths || []} /> : <p className="demo-empty">Is range par chart nahi mila.</p>}
        <ul className="demo-legend">
          {legend.map((key, index) => (
            <li key={key}><i style={{ background: COLORS[index % COLORS.length] }} />{key === 'Total' ? 'Total' : key}</li>
          ))}
        </ul>
      </section>

      <section className="demo-card">
        <div className="demo-toolbar">
          <label>
            Search page
            <input
              type="search"
              value={query}
              placeholder="/x/ ya link id"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            Rows
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                setOffset(0)
              }}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </label>
        </div>
        <div className="demo-table-wrap">
          <table className="demo-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Page path and screen class</th>
                <th>Views</th>
                <th>Active users</th>
                <th>Views per user</th>
                <th>Avg engagement</th>
                <th>Event count</th>
                <th>Key events</th>
                <th>Total revenue</th>
              </tr>
            </thead>
            <tbody>
              {totals ? (
                <tr className="demo-total">
                  <td />
                  <td>Total</td>
                  <td>{fmtInt(totals.views)}<small>100%</small></td>
                  <td>{fmtInt(totals.activeUsers)}<small>100%</small></td>
                  <td>{fmtDec(totals.viewsPerUser)}</td>
                  <td>{fmtDuration(totals.avgEngagementTime)}</td>
                  <td>{fmtInt(totals.eventCount)}<small>100%</small></td>
                  <td>{fmtInt(totals.keyEvents)}</td>
                  <td>{fmtInr(totals.totalRevenue)}<small>100%</small></td>
                </tr>
              ) : null}
              {rows.map((row, index) => (
                <tr key={row.path}>
                  <td>{offset + index + 1}</td>
                  <td>{row.path}</td>
                  <td>{fmtInt(row.views)}<small>{fmtShare(row.views, totals?.views)}</small></td>
                  <td>{fmtInt(row.activeUsers)}<small>{fmtShare(row.activeUsers, totals?.activeUsers)}</small></td>
                  <td>{fmtDec(row.viewsPerUser)}</td>
                  <td>{fmtDuration(row.avgEngagementTime)}</td>
                  <td>{fmtInt(row.eventCount)}<small>{fmtShare(row.eventCount, totals?.eventCount)}</small></td>
                  <td>{fmtInt(row.keyEvents)}</td>
                  <td>{fmtInr(row.totalRevenue)}<small>{fmtShare(row.totalRevenue, totals?.totalRevenue)}</small></td>
                </tr>
              ))}
              {!loading && !rows.length ? (
                <tr><td colSpan={9}>Is range par koi page nahi mila.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="demo-pager">
          <span className="demo-count">{offset + 1}–{Math.min(offset + rows.length, rowCount)} of {fmtInt(rowCount)}</span>
          <button type="button" disabled={offset <= 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Prev</button>
          <span className="demo-count">{page} / {pages}</span>
          <button type="button" disabled={offset + pageSize >= rowCount || loading} onClick={() => setOffset(offset + pageSize)}>Next</button>
        </div>
      </section>
    </div>
  )
}
