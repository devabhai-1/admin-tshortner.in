import { useEffect, useMemo, useState } from 'react'
import { limitToLast, onValue, query, ref } from 'firebase/database'
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
    .filter(([, value]) => value && typeof value === 'object')
    .map(([id, value]) => ({ [idKey]: id, ...value }))
    .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0))
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
  const [mode, setMode] = useState('total')
  const [day, setDay] = useState(todayKey)
  const [mailKey, setMailKey] = useState('')
  const [totals, setTotals] = useState(null)
  const [emails, setEmails] = useState([])
  const [countriesAll, setCountriesAll] = useState([])
  const [links, setLinks] = useState([])
  const [events, setEvents] = useState([])
  const live = day === todayKey()

  useEffect(() => {
    if (!db) return undefined
    const base = `realtimeTraffic/days/${day}`
    const unsubs = [
      onValue(ref(db, `${base}/totals`), (snap) => setTotals(snap.val() || { hits: 0, uniqueIps: 0 })),
      onValue(ref(db, `${base}/emails`), (snap) => {
        const rows = asRows(snap.val(), 'emailKey').sort((a, b) => (b.hits || 0) - (a.hits || 0))
        setEmails(rows)
      }),
      onValue(ref(db, `${base}/countries`), (snap) => {
        setCountriesAll(asRows(snap.val(), 'code').sort((a, b) => (b.hits || 0) - (a.hits || 0)))
      }),
      onValue(ref(db, `${base}/links`), (snap) => {
        setLinks(asRows(snap.val(), 'code').sort((a, b) => (b.hits || 0) - (a.hits || 0)))
      }),
      onValue(query(ref(db, `${base}/events`), limitToLast(200)), (snap) => {
        setEvents(asRows(snap.val(), 'id').sort((a, b) => (b.at || 0) - (a.at || 0)))
      }),
    ]
    return () => unsubs.forEach((off) => off())
  }, [db, day])

  useEffect(() => {
    if (mailKey && !emails.some((row) => row.emailKey === mailKey)) setMailKey('')
  }, [emails, mailKey])

  const selected = useMemo(
    () => emails.find((row) => row.emailKey === mailKey) || null,
    [emails, mailKey],
  )

  const countries = useMemo(
    () => (selected ? nestedRows(selected.byCountry, 'code') : []),
    [selected],
  )

  const mailLinks = useMemo(() => {
    if (!selected) return []
    const email = (selected.email || '').toLowerCase()
    return links
      .filter((row) => row.emailKey === selected.emailKey || (email && String(row.email || '').toLowerCase() === email))
      .sort((a, b) => (b.hits || 0) - (a.hits || 0))
  }, [links, selected])

  const mailEvents = useMemo(() => {
    if (!selected) return []
    const email = (selected.email || '').toLowerCase()
    return events.filter(
      (row) => String(row.email || '').toLowerCase() === email,
    )
  }, [events, selected])

  const mailHits = Number(selected?.hits) || 0

  return (
    <div className="rt-root">
      <AdminSectionNav />
      <header className="rt-head">
        <div>
          <p className="rt-kicker">Realtime database</p>
          <h1>{mode === 'total' ? 'Total dashboard' : 'Special dashboard'}</h1>
          <p className="rt-sub">
            {mode === 'total'
              ? 'Saari mails, countries aur links ka combined traffic.'
              : 'Ek mail select karo. Sirf us mail ka country traffic dikhega.'}
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

      <div className="rt-modes" role="tablist">
        <button type="button" className={mode === 'total' ? 'active' : ''} onClick={() => setMode('total')}>
          Total dashboard
        </button>
        <button type="button" className={mode === 'special' ? 'active' : ''} onClick={() => setMode('special')}>
          Special dashboard
        </button>
      </div>

      {mode === 'total' ? (
        <>
          <section className="rt-cards">
            <article><span>Total clicks</span><strong>{fmtInt(totals?.hits)}</strong></article>
            <article><span>Unique IPs</span><strong>{fmtInt(totals?.uniqueIps)}</strong></article>
            <article><span>Mails</span><strong>{fmtInt(emails.length)}</strong></article>
            <article><span>Countries</span><strong>{fmtInt(countriesAll.length)}</strong></article>
            <article><span>Links</span><strong>{fmtInt(links.length)}</strong></article>
          </section>

          <section className="rt-card">
            <h2>Saari mails</h2>
            <div className="rt-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Mail</th>
                    <th>Clicks</th>
                    <th>Share</th>
                    <th>Unique IPs</th>
                    <th>Countries</th>
                  </tr>
                </thead>
                <tbody>
                  {emails.map((row, index) => (
                    <tr key={row.emailKey}>
                      <td>{index + 1}</td>
                      <td className="rt-strong">{row.email || 'Mail not linked'}</td>
                      <td>{fmtInt(row.hits)}</td>
                      <td><Bar value={row.hits} total={totals?.hits} /></td>
                      <td>{fmtInt(row.uniqueIps)}</td>
                      <td>
                        <ul className="rt-chips">
                          {nestedRows(row.byCountry, 'code').map((country) => (
                            <li key={country.code}>
                              {country.country || country.name || country.code}
                              <b>{fmtInt(country.hits)}</b>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                  {!emails.length ? <tr><td colSpan={6}>Is date pe koi mail nahi.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rt-card">
            <h2>Saare countries</h2>
            <div className="rt-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Country</th>
                    <th>Clicks</th>
                    <th>Share</th>
                    <th>Unique IPs</th>
                    <th>Mails</th>
                  </tr>
                </thead>
                <tbody>
                  {countriesAll.map((row, index) => (
                    <tr key={row.code}>
                      <td>{index + 1}</td>
                      <td className="rt-strong">{row.name || row.code}</td>
                      <td>{fmtInt(row.hits)}</td>
                      <td><Bar value={row.hits} total={totals?.hits} /></td>
                      <td>{fmtInt(row.uniqueIps)}</td>
                      <td>
                        <ul className="rt-chips">
                          {nestedRows(row.byMail, 'emailKey').map((mail) => (
                            <li key={mail.emailKey}>
                              {mail.email || 'Mail not linked'}
                              <b>{fmtInt(mail.hits)}</b>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                  {!countriesAll.length ? <tr><td colSpan={6}>Is date pe koi country nahi.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {mode === 'special' ? (
      <>
      <section className="rt-picker">
        <label htmlFor="mail-select">Select mail</label>
        <select
          id="mail-select"
          value={mailKey}
          onChange={(e) => setMailKey(e.target.value)}
        >
          <option value="">— Mail choose karo —</option>
          {emails.map((row) => (
            <option key={row.emailKey} value={row.emailKey}>
              {(row.email || 'Mail not linked')} · {fmtInt(row.hits)} clicks
            </option>
          ))}
        </select>
        <span className="rt-muted">{fmtInt(emails.length)} mails on this date</span>
      </section>

      {!selected ? (
        <section className="rt-card">
          <p className="rt-hint">Upar se ek mail select karo. Uske countries, clicks aur links yahin khulenge.</p>
        </section>
      ) : (
        <>
          <section className="rt-cards">
            <article>
              <span>Selected mail</span>
              <strong className="rt-mail">{selected.email || 'Mail not linked'}</strong>
            </article>
            <article>
              <span>Clicks</span>
              <strong>{fmtInt(mailHits)}</strong>
            </article>
            <article>
              <span>Unique IPs</span>
              <strong>{fmtInt(selected.uniqueIps)}</strong>
            </article>
            <article>
              <span>Countries</span>
              <strong>{fmtInt(countries.length)}</strong>
            </article>
            <article>
              <span>Links</span>
              <strong>{fmtInt(mailLinks.length)}</strong>
            </article>
          </section>

          <section className="rt-card">
            <h2>Is mail pe kis country se traffic</h2>
            <div className="rt-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Country</th>
                    <th>Clicks</th>
                    <th>Share of this mail</th>
                    <th>Unique IPs</th>
                  </tr>
                </thead>
                <tbody>
                  {countries.map((row, index) => (
                    <tr key={row.code}>
                      <td>{index + 1}</td>
                      <td className="rt-strong">{row.country || row.name || row.code}</td>
                      <td>{fmtInt(row.hits)}</td>
                      <td><Bar value={row.hits} total={mailHits} /></td>
                      <td>{fmtInt(row.uniqueIps)}</td>
                    </tr>
                  ))}
                  {!countries.length ? (
                    <tr>
                      <td colSpan={5}>Is mail ka country split abhi nahi mila. Naya click aane ke baad yahan dikhega.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rt-card">
            <h2>Is mail ke links</h2>
            <div className="rt-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Link</th>
                    <th>Clicks</th>
                    <th>Unique IPs</th>
                    <th>Countries</th>
                    <th>Last hit</th>
                  </tr>
                </thead>
                <tbody>
                  {mailLinks.map((row) => {
                    const linkCountries = nestedRows(row.byCountry, 'code')
                    return (
                      <tr key={row.code}>
                        <td>
                          <a href={`https://teraboxlinke.com/x/${row.code}`} target="_blank" rel="noreferrer">
                            /x/{row.code}
                          </a>
                        </td>
                        <td>{fmtInt(row.hits)}</td>
                        <td>{fmtInt(row.uniqueIps)}</td>
                        <td>
                          {linkCountries.length ? (
                            <ul className="rt-chips">
                              {linkCountries.map((country) => (
                                <li key={country.code}>
                                  {country.name || country.code}
                                  <b>{fmtInt(country.hits)}</b>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            row.lastCountry || '—'
                          )}
                        </td>
                        <td>{fmtTime(row.lastAt)}</td>
                      </tr>
                    )
                  })}
                  {!mailLinks.length ? <tr><td colSpan={5}>Is mail ka koi link is date pe nahi mila.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rt-card">
            <h2>Is mail ki latest visits</h2>
            <div className="rt-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Country</th>
                    <th>Link</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {mailEvents.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtTime(row.at)}</td>
                      <td>{row.country || '—'}</td>
                      <td>/x/{row.code}</td>
                      <td>{row.ip || '—'}</td>
                    </tr>
                  ))}
                  {!mailEvents.length ? <tr><td colSpan={4}>Is mail ki recent visit list khali hai.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      </>
      ) : null}
    </div>
  )
}
