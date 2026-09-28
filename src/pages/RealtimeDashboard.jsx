import { useEffect, useMemo, useState } from 'react'
import { onValue, query, ref, limitToLast } from 'firebase/database'
import { useFirebaseDb } from '../context/FirebaseProvider.jsx'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './RealtimeDashboard.css'

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

function asRows(node, idKey) {
  if (!node || typeof node !== 'object') return []
  return Object.entries(node).map(([id, value]) => ({
    [idKey]: id,
    ...(value && typeof value === 'object' ? value : {}),
  }))
}

export default function RealtimeDashboard() {
  const { db, error: dbError } = useFirebaseDb()
  const [day, setDay] = useState(todayKey)
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
        const rows = asRows(snap.val(), 'id').sort((a, b) => (b.at || 0) - (a.at || 0))
        setEvents(rows)
      }),
    ]
    return () => unsubs.forEach((off) => off())
  }, [db, day])

  const q = queryText.trim().toLowerCase()
  const match = (parts) => !q || parts.join(' ').toLowerCase().includes(q)

  const countryRows = useMemo(
    () =>
      countries
        .filter((r) => match([r.name, r.code]))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0)),
    [countries, q],
  )
  const linkRows = useMemo(
    () =>
      links
        .filter((r) => match([r.code, r.email, r.lastCountry]))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0)),
    [links, q],
  )
  const emailRows = useMemo(
    () =>
      emails
        .filter((r) => match([r.email, r.emailKey]))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0)),
    [emails, q],
  )
  const eventRows = useMemo(
    () => events.filter((r) => match([r.ip, r.country, r.code, r.email])),
    [events, q],
  )

  const hits = Number(totals?.hits) || 0
  const uniqueIps = Number(totals?.uniqueIps) || 0

  return (
    <div className="rt-root">
      <AdminSectionNav />
      <header className="rt-head">
        <div>
          <p className="rt-kicker">Realtime database</p>
          <h1>Realtime traffic</h1>
          <p className="rt-sub">
            open.tshortner.in pe har visit: IP count, country, short link, aur us link ka owner mail.
            Aaj ka data live update hota hai.
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
        <article>
          <span>Hits</span>
          <strong>{fmtInt(hits)}</strong>
        </article>
        <article>
          <span>Unique IPs</span>
          <strong>{fmtInt(uniqueIps)}</strong>
        </article>
        <article>
          <span>Countries</span>
          <strong>{fmtInt(countries.length)}</strong>
        </article>
        <article>
          <span>Links</span>
          <strong>{fmtInt(links.length)}</strong>
        </article>
        <article>
          <span>Mails</span>
          <strong>{fmtInt(emails.length)}</strong>
        </article>
      </section>

      <div className="rt-search">
        <input
          type="search"
          placeholder="Search IP, country, link or mail…"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
        />
      </div>

      <section className="rt-grid">
        <div className="rt-card">
          <h2>Country</h2>
          <div className="rt-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Country</th>
                  <th>Hits</th>
                  <th>Unique IPs</th>
                </tr>
              </thead>
              <tbody>
                {countryRows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.name || r.code}</td>
                    <td>{fmtInt(r.hits)}</td>
                    <td>{fmtInt(r.uniqueIps)}</td>
                  </tr>
                ))}
                {!countryRows.length ? <tr><td colSpan={3}>Abhi koi traffic nahi.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rt-card">
          <h2>Mail</h2>
          <div className="rt-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Hits</th>
                  <th>Unique IPs</th>
                </tr>
              </thead>
              <tbody>
                {emailRows.map((r) => (
                  <tr key={r.emailKey}>
                    <td>{r.email || '—'}</td>
                    <td>{fmtInt(r.hits)}</td>
                    <td>{fmtInt(r.uniqueIps)}</td>
                  </tr>
                ))}
                {!emailRows.length ? <tr><td colSpan={3}>Abhi koi mail nahi.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="rt-card">
        <h2>Link + owner mail</h2>
        <div className="rt-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th>Mail</th>
                <th>Hits</th>
                <th>Unique IPs</th>
                <th>Last country</th>
                <th>Last hit</th>
              </tr>
            </thead>
            <tbody>
              {linkRows.map((r) => (
                <tr key={r.code}>
                  <td>
                    <a href={`https://teraboxlinke.com/x/${r.code}`} target="_blank" rel="noreferrer">
                      /x/{r.code}
                    </a>
                  </td>
                  <td>{r.email || '—'}</td>
                  <td>{fmtInt(r.hits)}</td>
                  <td>{fmtInt(r.uniqueIps)}</td>
                  <td>{r.lastCountry || '—'}</td>
                  <td>{fmtTime(r.lastAt)}</td>
                </tr>
              ))}
              {!linkRows.length ? <tr><td colSpan={6}>Abhi koi link hit nahi.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rt-card">
        <h2>Latest visits</h2>
        <div className="rt-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>IP</th>
                <th>Country</th>
                <th>Link</th>
                <th>Mail</th>
                <th>New IP</th>
              </tr>
            </thead>
            <tbody>
              {eventRows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtTime(r.at)}</td>
                  <td>{r.ip || '—'}</td>
                  <td>{r.country || '—'}</td>
                  <td>/x/{r.code}</td>
                  <td>{r.email || '—'}</td>
                  <td>{r.newIp ? 'Yes' : 'Repeat'}</td>
                </tr>
              ))}
              {!eventRows.length ? <tr><td colSpan={6}>Is date pe koi visit nahi.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
