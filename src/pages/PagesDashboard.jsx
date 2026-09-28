import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './DemographicDashboard.css'

function isoDaysAgo(n) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const [y, m, d] = parts.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - n)
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
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

function cpmOf(revenue, views) {
  const count = Number(views) || 0
  if (!count) return 0
  return ((Number(revenue) || 0) / count) * 1000
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
  const [startDate, setStartDate] = useState(isoDaysAgo(0))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [draftStart, setDraftStart] = useState(isoDaysAgo(0))
  const [draftEnd, setDraftEnd] = useState(isoDaysAgo(0))
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [mailQuery, setMailQuery] = useState('')
  const [mailSort, setMailSort] = useState('cpm')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const ctrl = new AbortController()
    let stop = false
    async function loadAll() {
      setLoading(true)
      setError('')
      setLoaded(0)
      setData(null)
      const allRows = []
      let offset = 0
      const limit = 2000
      let last = null
      try {
        while (!stop) {
          const params = new URLSearchParams({
            start_date: startDate,
            end_date: endDate,
            limit: String(limit),
            offset: String(offset),
          })
          if (search) params.set('q', search)
          const res = await apiFetch(`/api/analytics/pages?${params}`, { signal: ctrl.signal })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || 'Pages report nahi aaya')
          const batch = body.rows || []
          allRows.push(...batch)
          last = body
          offset += batch.length
          setLoaded(allRows.length)
          setData({ ...body, rows: allRows.slice() })
          const total = Number(body.rowCount || 0)
          if (!batch.length || offset >= total) break
        }
      } catch (err) {
        if (err.name === 'AbortError' || stop) return
        setError(err.message || 'Pages report nahi aaya')
        if (last) setData({ ...last, rows: allRows.slice() })
      } finally {
        if (!stop) setLoading(false)
      }
    }
    loadAll()
    return () => {
      stop = true
      ctrl.abort()
    }
  }, [startDate, endDate, search])

  const totals = data?.totals
  const rows = data?.rows || []
  const mailSearch = mailQuery.trim().toLowerCase()
  const mails = useMemo(() => {
    const map = new Map()
    for (const row of data?.rows || []) {
      const owners = row.emails?.length ? row.emails : ['Mail not linked']
      const share = owners.length
      for (const email of owners) {
        if (!map.has(email)) map.set(email, { email, pages: 0, views: 0, activeUsers: 0, totalRevenue: 0 })
        const item = map.get(email)
        item.pages += 1
        item.views += (Number(row.views) || 0) / share
        item.activeUsers += (Number(row.activeUsers) || 0) / share
        item.totalRevenue += (Number(row.totalRevenue) || 0) / share
      }
    }
    const list = Array.from(map.values()).filter((row) => {
      if (!mailSearch) return true
      return String(row.email || '').toLowerCase().includes(mailSearch)
    })
    const value = (row) => {
      if (mailSort === 'views') return Number(row.views) || 0
      if (mailSort === 'cpm') return cpmOf(row.totalRevenue, row.views)
      return Number(row.totalRevenue) || 0
    }
    return list.sort((a, b) => value(b) - value(a))
  }, [data, mailSearch, mailSort])
  const rowCount = Number(data?.rowCount || 0)
  const allLoaded = rowCount > 0 && loaded >= rowCount
  const legend = useMemo(() => ['Total', ...(data?.seriesPaths || [])], [data])

  const applyRange = (start, end) => {
    setDraftStart(start)
    setDraftEnd(end)
    setStartDate(start)
    setEndDate(end)
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
        <span className="demo-count">
          {loading ? `Rows ${fmtInt(loaded)} / ${fmtInt(rowCount || loaded)}` : `${fmtInt(rows.length)} / ${fmtInt(rowCount)} rows loaded`}
        </span>
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
        <div className="demo-card__head">
          <h2>Mail wise views aur kamai</h2>
          <span className="demo-note">{fmtInt(mails.length)} mails</span>
        </div>
        {data?.mailWarning ? <p className="demo-error">{data.mailWarning}</p> : null}
        <div className="demo-toolbar">
          <label>
            Search mail
            <input
              type="search"
              value={mailQuery}
              placeholder="mail type karo"
              onChange={(e) => setMailQuery(e.target.value)}
            />
          </label>
          <label>
            Hisaab
            <select value={mailSort} onChange={(e) => setMailSort(e.target.value)}>
              <option value="cpm">CPM ke hisaab se</option>
              <option value="revenue">Kamai ke hisaab se</option>
              <option value="views">Views ke hisaab se</option>
            </select>
          </label>
        </div>
        <p className="demo-note">CPM = kamai ÷ views × 1000. Yeh 1000 views par kitni kamai hai, rupee mein.</p>
        <div className="demo-table-wrap">
          <table className="demo-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Mail</th>
                <th>Pages</th>
                <th>Total views</th>
                <th>Share</th>
                <th>Active users</th>
                <th>Total revenue</th>
                <th>CPM</th>
              </tr>
            </thead>
            <tbody>
              {totals ? (
                <tr className="demo-total">
                  <td />
                  <td>Total</td>
                  <td>{fmtInt(rows.length)}</td>
                  <td>{fmtInt(totals.views)}</td>
                  <td>100%</td>
                  <td>{fmtInt(totals.activeUsers)}</td>
                  <td>{fmtInr(totals.totalRevenue)}</td>
                  <td>{fmtInr(cpmOf(totals.totalRevenue, totals.views))}</td>
                </tr>
              ) : null}
              {mails.map((row, index) => (
                <tr key={row.email}>
                  <td>{index + 1}</td>
                  <td>{row.email}</td>
                  <td>{fmtInt(row.pages)}</td>
                  <td>{fmtInt(row.views)}<small>{fmtShare(row.views, totals?.views)}</small></td>
                  <td>{fmtShare(row.views, totals?.views)}</td>
                  <td>{fmtInt(row.activeUsers)}</td>
                  <td>{fmtInr(row.totalRevenue)}<small>{fmtShare(row.totalRevenue, totals?.totalRevenue)}</small></td>
                  <td>{fmtInr(cpmOf(row.totalRevenue, row.views))}</td>
                </tr>
              ))}
              {!loading && !mails.length ? (
                <tr><td colSpan={8}>Is range par koi mail nahi mili.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
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
          <span className="demo-note">{allLoaded ? 'Is date ki saari rows load ho gayi.' : 'Saari rows load ho rahi hain.'}</span>
        </div>
        <div className="demo-table-wrap">
          <table className="demo-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Page path and screen class</th>
                <th>Mail</th>
                <th>Views</th>
                <th>Active users</th>
                <th>Views per user</th>
                <th>Avg engagement</th>
                <th>Event count</th>
                <th>Key events</th>
                <th>Total revenue</th>
                <th>CPM</th>
              </tr>
            </thead>
            <tbody>
              {totals ? (
                <tr className="demo-total">
                  <td />
                  <td>Total</td>
                  <td />
                  <td>{fmtInt(totals.views)}<small>100%</small></td>
                  <td>{fmtInt(totals.activeUsers)}<small>100%</small></td>
                  <td>{fmtDec(totals.viewsPerUser)}</td>
                  <td>{fmtDuration(totals.avgEngagementTime)}</td>
                  <td>{fmtInt(totals.eventCount)}<small>100%</small></td>
                  <td>{fmtInt(totals.keyEvents)}</td>
                  <td>{fmtInr(totals.totalRevenue)}<small>100%</small></td>
                  <td>{fmtInr(cpmOf(totals.totalRevenue, totals.views))}</td>
                </tr>
              ) : null}
              {rows.map((row, index) => (
                <tr key={row.path}>
                  <td>{index + 1}</td>
                  <td>{row.path}</td>
                  <td>{row.emails?.length ? row.emails.join(', ') : '—'}</td>
                  <td>{fmtInt(row.views)}<small>{fmtShare(row.views, totals?.views)}</small></td>
                  <td>{fmtInt(row.activeUsers)}<small>{fmtShare(row.activeUsers, totals?.activeUsers)}</small></td>
                  <td>{fmtDec(row.viewsPerUser)}</td>
                  <td>{fmtDuration(row.avgEngagementTime)}</td>
                  <td>{fmtInt(row.eventCount)}<small>{fmtShare(row.eventCount, totals?.eventCount)}</small></td>
                  <td>{fmtInt(row.keyEvents)}</td>
                  <td>{fmtInr(row.totalRevenue)}<small>{fmtShare(row.totalRevenue, totals?.totalRevenue)}</small></td>
                  <td>{fmtInr(cpmOf(row.totalRevenue, row.views))}</td>
                </tr>
              ))}
              {!loading && !rows.length ? (
                <tr><td colSpan={11}>Is range par koi page nahi mila.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="demo-count">
          {fmtInt(rows.length)} rows dikh rahi hain
          {rowCount ? ` / ${fmtInt(rowCount)} total` : ''}
          {allLoaded ? ' · complete' : ''}
        </p>
      </section>
    </div>
  )
}
