import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import { formatInt } from '../lib/formatMoney.js'
import './PlayerApiCallDashboard.css'

const FB_BASE =
  import.meta.env.VITE_FIREBASE_DATABASE_URL ||
  'https://tshortner-in-default-rtdb.asia-southeast1.firebasedatabase.app'

const PLAYER_API_BASE =
  import.meta.env.VITE_PLAYER_API_BASE || 'https://www.tshortner.in'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'events', label: 'By Event' },
  { id: 'ads', label: 'Ads' },
  { id: 'links', label: 'Links' },
  { id: 'mails', label: 'Mails' },
  { id: 'ips', label: 'IPs' },
  { id: 'raw', label: 'Raw events' },
]

function isoToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function addDaysIso(iso, delta) {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

function daysBetween(start, end) {
  const out = []
  let cur = start
  while (cur && cur <= end && out.length < 90) {
    out.push(cur)
    cur = addDaysIso(cur, 1)
  }
  return out
}

async function loadDayEvents(day) {
  const res = await fetch(`${FB_BASE}/playerAnalytics/events/${day}.json`, {
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) return []
  const data = await res.json()
  if (!data || typeof data !== 'object') return []
  return Object.entries(data).map(([key, val]) => ({
    id: key,
    ...(val && typeof val === 'object' ? val : {}),
  }))
}

function buildStats(rows) {
  const byEvent = {}
  const byAd = {}
  const byLink = {}
  const byMail = {}
  const byIp = {}
  const sessions = new Set()
  let touches = 0
  let playerClicks = 0
  let playlineClicks = 0
  let adContinues = 0
  let redirects = 0
  let pageViews = 0

  for (const row of rows) {
    const ev = row.event || 'unknown'
    byEvent[ev] = (byEvent[ev] || 0) + 1
    if (row.sessionId) sessions.add(row.sessionId)
    if (row.ip) byIp[row.ip] = (byIp[row.ip] || 0) + 1

    if (row.linkId) {
      if (!byLink[row.linkId]) {
        byLink[row.linkId] = {
          linkId: row.linkId,
          ownerEmail: row.ownerEmail || '',
          events: 0,
          player_click: 0,
          playline_click: 0,
          ad_continue: 0,
          page_view: 0,
          redirect: 0,
        }
      }
      const L = byLink[row.linkId]
      L.events += 1
      if (ev in L) L[ev] += 1
      if (row.ownerEmail) L.ownerEmail = row.ownerEmail
    }

    const mail = row.ownerEmail || 'Mail not linked'
    if (!byMail[mail]) {
      byMail[mail] = {
        email: mail,
        events: 0,
        player_click: 0,
        playline_click: 0,
        ad_continue: 0,
        page_view: 0,
        uniqueLinks: new Set(),
      }
    }
    const M = byMail[mail]
    M.events += 1
    if (ev in M) M[ev] += 1
    if (row.linkId) M.uniqueLinks.add(row.linkId)

    if (row.adSlot || row.adUnit) {
      const key = row.adSlot || row.adUnit || 'unknown'
      if (!byAd[key]) {
        byAd[key] = {
          adSlot: key,
          adUnit: row.adUnit || '',
          impressions: 0,
          clicks: 0,
          continues: 0,
        }
      }
      const A = byAd[key]
      if (ev === 'ad_impression' || ev === 'ad_shown') A.impressions += 1
      if (ev === 'ad_click') A.clicks += 1
      if (ev === 'ad_continue' || ev === 'ad_close') A.continues += 1
    }

    if (ev === 'touch') touches += 1
    if (ev === 'player_click') playerClicks += 1
    if (ev === 'playline_click') playlineClicks += 1
    if (ev === 'ad_continue' || ev === 'ad_close') adContinues += 1
    if (ev === 'redirect') redirects += 1
    if (ev === 'page_view') pageViews += 1
  }

  return {
    totalEvents: rows.length,
    sessions: sessions.size,
    touches,
    playerClicks,
    playlineClicks,
    adContinues,
    redirects,
    pageViews,
    byEvent,
    byAd: Object.values(byAd).sort(
      (a, b) => b.impressions + b.clicks - (a.impressions + a.clicks),
    ),
    byLink: Object.values(byLink).sort((a, b) => b.events - a.events),
    byMail: Object.values(byMail)
      .map((m) => ({
        email: m.email,
        events: m.events,
        player_click: m.player_click,
        playline_click: m.playline_click,
        ad_continue: m.ad_continue,
        page_view: m.page_view,
        uniqueLinks: m.uniqueLinks.size,
      }))
      .sort((a, b) => b.events - a.events),
    topIps: Object.entries(byIp)
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count),
  }
}

export default function PlayerApiCallDashboard() {
  const today = isoToday()
  const [rangeFrom, setRangeFrom] = useState(() => addDaysIso(today, -6))
  const [rangeTo, setRangeTo] = useState(today)
  const [tab, setTab] = useState('overview')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [health, setHealth] = useState(null)
  const deferredSearch = useDeferredValue(search)

  const from = rangeFrom <= rangeTo ? rangeFrom : rangeTo
  const to = rangeFrom <= rangeTo ? rangeTo : rangeFrom

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const days = daysBetween(from, to)
      const chunks = await Promise.all(days.map((day) => loadDayEvents(day)))
      const all = chunks.flat().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
      setRows(all)
    } catch (err) {
      setError(err?.message || 'Load failed')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${PLAYER_API_BASE}/api/player/health`, {
          signal: AbortSignal.timeout(8000),
        })
        const data = await res.json()
        if (!cancelled) setHealth(data)
      } catch {
        if (!cancelled) setHealth({ ok: false })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => buildStats(rows), [rows])
  const q = deferredSearch.trim().toLowerCase()

  const filteredRaw = useMemo(() => {
    if (!q) return rows.slice(0, 500)
    return rows
      .filter((r) => {
        const hay = [
          r.event,
          r.linkId,
          r.ownerEmail,
          r.ip,
          r.adSlot,
          r.pageUrl,
          r.playerHost,
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .slice(0, 500)
  }, [rows, q])

  const filteredLinks = useMemo(() => {
    if (!q) return stats.byLink
    return stats.byLink.filter(
      (r) =>
        r.linkId.toLowerCase().includes(q) ||
        String(r.ownerEmail || '')
          .toLowerCase()
          .includes(q),
    )
  }, [stats.byLink, q])

  const filteredMails = useMemo(() => {
    if (!q) return stats.byMail
    return stats.byMail.filter((r) => r.email.toLowerCase().includes(q))
  }, [stats.byMail, q])

  const filteredIps = useMemo(() => {
    if (!q) return stats.topIps
    return stats.topIps.filter((r) => r.ip.toLowerCase().includes(q))
  }, [stats.topIps, q])

  const setPreset = (n) => {
    setRangeFrom(addDaysIso(today, -(n - 1)))
    setRangeTo(today)
  }

  return (
    <div className="api-call">
      <header className="api-call__hero">
        <div>
          <h1>
            API Call
            <span className={'api-call__pill ' + (health?.ok ? 'on' : loading ? 'load' : '')}>
              {loading ? '⟳ Loading' : health?.ok ? '● API Live' : '○ …'}
            </span>
          </h1>
          <p>
            Player analytics system — IP, touch, Click to View, Playline, ads, link + mail. Source:{' '}
            <code>playerAnalytics</code> · API: <code>{PLAYER_API_BASE}</code>
            {health?.allowedPlayerHosts?.length
              ? ` · Allowed: ${health.allowedPlayerHosts.join(', ')}`
              : ''}
          </p>
        </div>
        <AdminSectionNav />
      </header>

      <div className="api-call__toolbar">
        <label>
          <span>From</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setRangeFrom(e.target.value)}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setRangeTo(e.target.value)}
          />
        </label>
        <div className="api-call__presets">
          <button type="button" onClick={() => setPreset(1)}>
            Today
          </button>
          <button type="button" onClick={() => setPreset(7)}>
            7d
          </button>
          <button type="button" onClick={() => setPreset(30)}>
            30d
          </button>
        </div>
        <label className="api-call__search">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="mail / link / ip / event…"
          />
        </label>
        <button type="button" className="api-call__refresh" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="api-call__err">⚠ {error}</p> : null}

      <div className="api-call__kpi">
        <div className="api-call__kpi-card highlight">
          <span>Total events</span>
          <strong>{formatInt(stats.totalEvents)}</strong>
        </div>
        <div className="api-call__kpi-card">
          <span>Page views</span>
          <strong>{formatInt(stats.pageViews)}</strong>
        </div>
        <div className="api-call__kpi-card">
          <span>Player clicks</span>
          <strong>{formatInt(stats.playerClicks)}</strong>
        </div>
        <div className="api-call__kpi-card">
          <span>Playline clicks</span>
          <strong>{formatInt(stats.playlineClicks)}</strong>
        </div>
        <div className="api-call__kpi-card">
          <span>Ad continue</span>
          <strong>{formatInt(stats.adContinues)}</strong>
        </div>
        <div className="api-call__kpi-card">
          <span>Redirects</span>
          <strong>{formatInt(stats.redirects)}</strong>
        </div>
        <div className="api-call__kpi-card">
          <span>Touches</span>
          <strong>{formatInt(stats.touches)}</strong>
        </div>
        <div className="api-call__kpi-card ok">
          <span>Sessions</span>
          <strong>{formatInt(stats.sessions)}</strong>
        </div>
      </div>

      <div className="api-call__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="api-call__panel">
        {tab === 'overview' ? (
          <div className="api-call__overview">
            <section>
              <h2>System options</h2>
              <ul>
                <li>
                  <strong>page_view</strong> — page open + IP
                </li>
                <li>
                  <strong>touch</strong> — screen touch/click (x,y)
                </li>
                <li>
                  <strong>player_click</strong> — Click to View
                </li>
                <li>
                  <strong>playline_click</strong> — Play Line button
                </li>
                <li>
                  <strong>ad_impression / ad_shown / ad_click</strong> — ad slots
                </li>
                <li>
                  <strong>ad_continue / ad_close</strong> — interstitial continue
                </li>
                <li>
                  <strong>redirect</strong> — open.tshortner hop
                </li>
                <li>
                  <strong>linkId + ownerEmail</strong> — kaunsi mail ki link
                </li>
              </ul>
            </section>
            <section>
              <h2>Endpoints</h2>
              <ul>
                <li>
                  <code>POST {PLAYER_API_BASE}/api/player/event</code>
                </li>
                <li>
                  <code>GET {PLAYER_API_BASE}/api/player/health</code>
                </li>
                <li>
                  <code>GET {PLAYER_API_BASE}/api/player/stats</code>
                </li>
              </ul>
              <p className="api-call__note">
                Events sirf <strong>teraboxlinke.com</strong> / <strong>www.teraboxlinke.com</strong>{' '}
                se accept hote hain.
              </p>
            </section>
          </div>
        ) : null}

        {tab === 'events' ? (
          <table className="api-call__table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.byEvent)
                .sort((a, b) => b[1] - a[1])
                .map(([ev, count]) => (
                  <tr key={ev}>
                    <td>
                      <code>{ev}</code>
                    </td>
                    <td className="num">{formatInt(count)}</td>
                  </tr>
                ))}
              {!Object.keys(stats.byEvent).length ? (
                <tr>
                  <td colSpan={2} className="empty">
                    Is range me koi event nahi.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'ads' ? (
          <table className="api-call__table">
            <thead>
              <tr>
                <th>Ad slot</th>
                <th>Unit</th>
                <th>Impressions</th>
                <th>Clicks</th>
                <th>Continue</th>
              </tr>
            </thead>
            <tbody>
              {stats.byAd.map((row) => (
                <tr key={row.adSlot}>
                  <td>
                    <code>{row.adSlot}</code>
                  </td>
                  <td className="small">{row.adUnit || '—'}</td>
                  <td className="num">{formatInt(row.impressions)}</td>
                  <td className="num">{formatInt(row.clicks)}</td>
                  <td className="num">{formatInt(row.continues)}</td>
                </tr>
              ))}
              {!stats.byAd.length ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No ad data in range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'links' ? (
          <table className="api-call__table">
            <thead>
              <tr>
                <th>Link ID</th>
                <th>Mail</th>
                <th>Events</th>
                <th>Player</th>
                <th>Playline</th>
                <th>Views</th>
                <th>Redirect</th>
              </tr>
            </thead>
            <tbody>
              {filteredLinks.slice(0, 300).map((row) => (
                <tr key={row.linkId}>
                  <td>
                    <code>{row.linkId}</code>
                  </td>
                  <td className="mail">{row.ownerEmail || '—'}</td>
                  <td className="num">{formatInt(row.events)}</td>
                  <td className="num">{formatInt(row.player_click)}</td>
                  <td className="num">{formatInt(row.playline_click)}</td>
                  <td className="num">{formatInt(row.page_view)}</td>
                  <td className="num">{formatInt(row.redirect)}</td>
                </tr>
              ))}
              {!filteredLinks.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No links in range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'mails' ? (
          <table className="api-call__table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Events</th>
                <th>Player clicks</th>
                <th>Playline</th>
                <th>Page views</th>
                <th>Unique links</th>
              </tr>
            </thead>
            <tbody>
              {filteredMails.slice(0, 300).map((row) => (
                <tr key={row.email}>
                  <td className="mail">{row.email}</td>
                  <td className="num">{formatInt(row.events)}</td>
                  <td className="num">{formatInt(row.player_click)}</td>
                  <td className="num">{formatInt(row.playline_click)}</td>
                  <td className="num">{formatInt(row.page_view)}</td>
                  <td className="num">{formatInt(row.uniqueLinks)}</td>
                </tr>
              ))}
              {!filteredMails.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No mails in range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'ips' ? (
          <table className="api-call__table">
            <thead>
              <tr>
                <th>#</th>
                <th>IP</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {filteredIps.slice(0, 200).map((row, i) => (
                <tr key={row.ip}>
                  <td>{i + 1}</td>
                  <td>
                    <code>{row.ip}</code>
                  </td>
                  <td className="num">{formatInt(row.count)}</td>
                </tr>
              ))}
              {!filteredIps.length ? (
                <tr>
                  <td colSpan={3} className="empty">
                    No IPs in range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'raw' ? (
          <table className="api-call__table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Link</th>
                <th>Mail</th>
                <th>IP</th>
                <th>Ad</th>
                <th>Host</th>
              </tr>
            </thead>
            <tbody>
              {filteredRaw.map((row) => (
                <tr key={row.id}>
                  <td className="small">{String(row.ts || '').replace('T', ' ').slice(0, 19)}</td>
                  <td>
                    <code>{row.event}</code>
                  </td>
                  <td className="small">
                    <code>{row.linkId || '—'}</code>
                  </td>
                  <td className="mail small">{row.ownerEmail || '—'}</td>
                  <td>
                    <code>{row.ip || '—'}</code>
                  </td>
                  <td className="small">{row.adSlot || '—'}</td>
                  <td className="small">{row.playerHost || '—'}</td>
                </tr>
              ))}
              {!filteredRaw.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No raw events.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
