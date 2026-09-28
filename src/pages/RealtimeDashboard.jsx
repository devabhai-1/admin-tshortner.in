import { useEffect, useMemo, useState } from 'react'
import { limitToLast, onValue, query, ref } from 'firebase/database'
import { useFirebaseDb } from '../context/FirebaseProvider.jsx'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './RealtimeDashboard.css'

const VIEWS = [
  { id: 'mail', label: 'Mail clicks' },
  { id: 'country', label: 'Country traffic' },
  { id: 'link', label: 'Link clicks' },
]

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function fmtInt(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(n) || 0)
}

function fmtTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: 'short',
  })
}

function pct(part, total) {
  const t = Number(total) || 0
  if (!t) return 0
  return Math.round((Number(part) / t) * 1000) / 10
}

function asRows(node, idKey) {
  if (!node || typeof node !== 'object') return []
  return Object.entries(node).map(([id, value]) => ({
    [idKey]: id,
    ...(value && typeof value === 'object' ? value : {}),
  }))
}

function nestedRows(node, idKey) {
  if (!node || typeof node !== 'object') return []
  return Object.entries(node)
    .filter(([, value]) => value && typeof value === 'object' && ('hits' in value || 'name' in value || 'email' in value || 'country' in value))
    .map(([id, value]) => ({ [idKey]: id, ...value }))
    .sort((a, b) => (b.hits || 0) - (a.hits || 0))
}

function Bar({ value, total }) {
  const share = pct(value, total)
  return (
    <div className="rt-bar" title={`${share}%`}>
      <span style={{ width: `${Math.min(100, share)}%` }} />
      <em>{share}%</em>
    </div>
  )
}

export default function RealtimeDashboard() {
  const { db, error: dbError } = useFirebaseDb()
  const [day, setDay] = useState(todayKey)
  const [view, setView] = useState('mail')
  const [totals, setTotals] = useState(null)
  const [countries, setCountries] = useState([])
  const [links, setLinks] = useState([])
  const [emails, setEmails] = useState([])
  const [events, setEvents] = useState([])
  const [queryText, setQueryText] = useState('')
  const live = day === todayKey()

  useEffect(() => {
    if (!db) return undefined
    const base = `realtimeTraffic/days/${day}`
    const unsubs = [
      onValue(ref(db, `${base}/totals`), (snap) => setTotals(snap.val() || { hits: 0, uniqueIps: 0 })),
      onValue(ref(db, `${base}/countries`), (snap) => setCountries(asRows(snap.val(), 'code'))),
      onValue(ref(db, `${base}/links`), (snap) => setLinks(asRows(snap.val(), 'code'))),
      onValue(ref(db, `${base}/emails`), (snap) => setEmails(asRows(snap.val(), 'emailKey'))),
      onValue(query(ref(db, `${base}/events`), limitToLast(80)), (snap) => {
        setEvents(asRows(snap.val(), 'id').sort((a, b) => (b.at || 0) - (a.at || 0)))
      }),
    ]
    return () => unsubs.forEach((off) => off())
  }, [db, day])

  const q = queryText.trim().toLowerCase()
  const hits = Number(totals?.hits) || 0
  const uniqueIps = Number(totals?.uniqueIps) || 0

  const emailRows = useMemo(
    () =>
      emails
        .filter((r) => !q || `${r.email || ''} ${r.emailKey || ''}`.toLowerCase().includes(q))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0)),
    [emails, q],
  )
  const countryRows = useMemo(
    () =>
      countries
        .filter((r) => !q || `${r.name || ''} ${r.code || ''}`.toLowerCase().includes(q))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0)),
    [countries, q],
  )
  const linkRows = useMemo(
    () =>
      links
        .filter((r) => !q || `${r.code || ''} ${r.email || ''} ${r.lastCountry || ''}`.toLowerCase().includes(q))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0)),
    [links, q],
  )

  return (
    <div className="rt-root">
      <AdminSectionNav />
      <header className="rt-head">
        <div>
          <p className="rt-kicker">Realtime database</p>
          <h1>Realtime traffic</h1>
          <p className="rt-sub">
            Teen views: kis mail pe kitne clicks, kis country se traffic, aur kis link pe kis mail ka click.
          </p>
        </div>
        <div className="rt-controls">
          <label>
            Date
            <input type="date" value={day} max={todayKey()} onChange={(e) => setDay(e.target.value || todayKey())} />
          </label>
          <button type="button" onClick={() => setDay(todayKey())}>Today</button>
          <span className={live ? 'rt-live' : 'rt-live off'}>{live ? 'LIVE' : 'History'}</span>
        </div>
      </header>

      {dbError ? <p className="rt-error">{dbError}</p> : null}

      <section className="rt-cards">
        <article><span>Total clicks</span><strong>{fmtInt(hits)}</strong></article>
        <article><span>Unique IPs</span><strong>{fmtInt(uniqueIps)}</strong></article>
        <article><span>Mails</span><strong>{fmtInt(emails.length)}</strong></article>
        <article><span>Countries</span><strong>{fmtInt(countries.length)}</strong></article>
        <article><span>Links</span><strong>{fmtInt(links.length)}</strong></article>
      </section>

      <div className="rt-tabs">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={view === item.id ? 'active' : ''}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search mail, country or link…"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
        />
      </div>

      {view === 'mail' ? (
        <section className="rt-card">
          <h2>Kis mail pe kitne clicks</h2>
          <p className="rt-hint">Har mail ke neeche woh countries hain jahan se us mail ke links pe click aaya.</p>
          <div className="rt-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Mail</th>
                  <th>Clicks</th>
                  <th>Share</th>
                  <th>Unique IPs</th>
                  <th>Country breakdown</th>
                </tr>
              </thead>
              <tbody>
                {emailRows.map((r, i) => {
                  const countriesForMail = nestedRows(r.byCountry, 'code')
                  return (
                    <tr key={r.emailKey}>
                      <td>{i + 1}</td>
                      <td className="rt-strong">{r.email || 'Mail not linked'}</td>
                      <td>{fmtInt(r.hits)}</td>
                      <td><Bar value={r.hits} total={hits} /></td>
                      <td>{fmtInt(r.uniqueIps)}</td>
                      <td>
                        {countriesForMail.length ? (
                          <ul className="rt-chips">
                            {countriesForMail.map((c) => (
                              <li key={c.code}>
                                {c.country || c.name || c.code}
                                <b>{fmtInt(c.hits)}</b>
                                <small>{pct(c.hits, r.hits)}%</small>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="rt-muted">Country split naye clicks ke baad dikhega</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {!emailRows.length ? <tr><td colSpan={6}>Is date pe koi mail click nahi.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {view === 'country' ? (
        <section className="rt-card">
          <h2>Kis country se traffic aa raha hai</h2>
          <p className="rt-hint">Har country ke neeche woh mails hain jinpe us country se click aaya.</p>
          <div className="rt-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Country</th>
                  <th>Clicks</th>
                  <th>Share</th>
                  <th>Unique IPs</th>
                  <th>Mails in this country</th>
                </tr>
              </thead>
              <tbody>
                {countryRows.map((r, i) => {
                  const mails = nestedRows(r.byMail, 'emailKey')
                  return (
                    <tr key={r.code}>
                      <td>{i + 1}</td>
                      <td className="rt-strong">{r.name || r.code}</td>
                      <td>{fmtInt(r.hits)}</td>
                      <td><Bar value={r.hits} total={hits} /></td>
                      <td>{fmtInt(r.uniqueIps)}</td>
                      <td>
                        {mails.length ? (
                          <ul className="rt-chips">
                            {mails.map((m) => (
                              <li key={m.emailKey}>
                                {m.email || 'Mail not linked'}
                                <b>{fmtInt(m.hits)}</b>
                                <small>{pct(m.hits, r.hits)}%</small>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="rt-muted">Mail split naye clicks ke baad dikhega</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {!countryRows.length ? <tr><td colSpan={6}>Is date pe koi country traffic nahi.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {view === 'link' ? (
        <section className="rt-card">
          <h2>Kis link pe, kis mail ka, kis country se</h2>
          <div className="rt-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Link</th>
                  <th>Mail</th>
                  <th>Clicks</th>
                  <th>Share</th>
                  <th>Unique IPs</th>
                  <th>Countries</th>
                  <th>Last hit</th>
                </tr>
              </thead>
              <tbody>
                {linkRows.map((r, i) => {
                  const linkCountries = nestedRows(r.byCountry, 'code')
                  return (
                    <tr key={r.code}>
                      <td>{i + 1}</td>
                      <td>
                        <a href={`https://teraboxlinke.com/x/${r.code}`} target="_blank" rel="noreferrer">
                          /x/{r.code}
                        </a>
                      </td>
                      <td>{r.email || 'Mail not linked'}</td>
                      <td>{fmtInt(r.hits)}</td>
                      <td><Bar value={r.hits} total={hits} /></td>
                      <td>{fmtInt(r.uniqueIps)}</td>
                      <td>
                        {linkCountries.length ? (
                          <ul className="rt-chips">
                            {linkCountries.map((c) => (
                              <li key={c.code}>
                                {c.name || c.code}
                                <b>{fmtInt(c.hits)}</b>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          r.lastCountry || '—'
                        )}
                      </td>
                      <td>{fmtTime(r.lastAt)}</td>
                    </tr>
                  )
                })}
                {!linkRows.length ? <tr><td colSpan={8}>Is date pe koi link click nahi.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="rt-card">
        <h2>Latest visits</h2>
        <div className="rt-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Mail</th>
                <th>Country</th>
                <th>Link</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {events
                .filter((r) => !q || `${r.email || ''} ${r.country || ''} ${r.code || ''} ${r.ip || ''}`.toLowerCase().includes(q))
                .map((r) => (
                  <tr key={r.id}>
                    <td>{fmtTime(r.at)}</td>
                    <td>{r.email || 'Mail not linked'}</td>
                    <td>{r.country || '—'}</td>
                    <td>/x/{r.code}</td>
                    <td>{r.ip || '—'}</td>
                  </tr>
                ))}
              {!events.length ? <tr><td colSpan={5}>Is date pe koi visit nahi.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
