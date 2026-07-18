import { useDeferredValue, useMemo, useState } from 'react'
import { useUsersData } from '../context/usersDataContext.js'
import { formatInt } from '../lib/formatMoney.js'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './TelegramIdsDashboard.css'

function formatLogin(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSyncTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function hasTelegramUsername(row) {
  return Boolean(row.telegramUsername && row.telegramUsername !== '—')
}

function sortTelegramRows(rows) {
  return [...rows].sort((a, b) => {
    const aHas = hasTelegramUsername(a)
    const bHas = hasTelegramUsername(b)
    if (aHas !== bHas) return aHas ? -1 : 1
    if (aHas && bHas) {
      const atDiff = (b.telegramUsernameAt || 0) - (a.telegramUsernameAt || 0)
      if (atDiff !== 0) return atDiff
      return String(a.telegramUsername).localeCompare(String(b.telegramUsername))
    }
    return String(a.email).localeCompare(String(b.email))
  })
}

export default function TelegramIdsDashboard() {
  const {
    overviewRows,
    ready,
    sessionLoaded,
    lastSync,
    streamProgress,
    allUsersLoaded,
    fbConnecting,
    refreshUsersData,
  } = useUsersData()

  const [search, setSearch] = useState('')
  const [onlyWithUsername, setOnlyWithUsername] = useState(false)
  const [onlyMissingUsername, setOnlyMissingUsername] = useState(false)
  const deferredSearch = useDeferredValue(search)

  const isStreaming = streamProgress?.streaming === true

  const sortedRows = useMemo(() => sortTelegramRows(overviewRows), [overviewRows])

  const withUsernameCount = useMemo(
    () => overviewRows.filter(hasTelegramUsername).length,
    [overviewRows],
  )

  const filtered = useMemo(() => {
    let list = sortedRows
    if (onlyWithUsername) list = list.filter(hasTelegramUsername)
    if (onlyMissingUsername) list = list.filter((r) => !hasTelegramUsername(r))
    const q = deferredSearch.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (r) =>
          r.email.toLowerCase().includes(q) ||
          String(r.name).toLowerCase().includes(q) ||
          String(r.telegramUsername).toLowerCase().includes(q),
      )
    }
    return list
  }, [sortedRows, deferredSearch, onlyWithUsername, onlyMissingUsername])

  const streamLabel =
    isStreaming && streamProgress
      ? `${formatInt(streamProgress.loaded)} / ${formatInt(streamProgress.total)} users`
      : ''

  return (
    <div className="tg-ids-dash">
      <header className="tg-ids-dash__hero">
        <div>
          <h1>
            Telegram IDs
            <span className={'tg-ids-dash__pill ' + (sessionLoaded && !isStreaming ? 'on' : '')}>
              {isStreaming ? '⟳ Loading' : sessionLoaded ? '● Ready' : '○ …'}
            </span>
          </h1>
          <p>
            Har user ka email aur Telegram username — dashboard popup se save hua data yahan dikhega.
            {withUsernameCount > 0
              ? ` ${formatInt(withUsernameCount)} / ${formatInt(overviewRows.length)} users ne username diya.`
              : ''}
            {isStreaming ? ` Abhi: ${streamLabel}…` : ''}
          </p>
        </div>
        <AdminSectionNav />
      </header>

      <div className="tg-ids-dash__kpi">
        <div className="tg-ids-dash__kpi-card highlight">
          <span>Total users</span>
          <strong>{ready ? formatInt(overviewRows.length) : '…'}</strong>
        </div>
        <div className="tg-ids-dash__kpi-card ok">
          <span>With Telegram @</span>
          <strong>{ready ? formatInt(withUsernameCount) : '…'}</strong>
          <small>username saved</small>
        </div>
        <div className="tg-ids-dash__kpi-card warn">
          <span>Missing Telegram @</span>
          <strong>{ready ? formatInt(overviewRows.length - withUsernameCount) : '…'}</strong>
          <small>abhi tak nahi diya</small>
        </div>
        <div className="tg-ids-dash__kpi-card">
          <span>Shown</span>
          <strong>{ready ? formatInt(filtered.length) : '…'}</strong>
          <small>current filter</small>
        </div>
      </div>

      <div className="tg-ids-dash__toolbar">
        <input
          type="search"
          placeholder="Email / name / @username search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search telegram ids"
        />
        <label className="tg-ids-dash__chk">
          <input
            type="checkbox"
            checked={onlyWithUsername}
            onChange={(e) => {
              setOnlyWithUsername(e.target.checked)
              if (e.target.checked) setOnlyMissingUsername(false)
            }}
          />
          sirf username wale
        </label>
        <label className="tg-ids-dash__chk">
          <input
            type="checkbox"
            checked={onlyMissingUsername}
            onChange={(e) => {
              setOnlyMissingUsername(e.target.checked)
              if (e.target.checked) setOnlyWithUsername(false)
            }}
          />
          sirf missing username
        </label>
        <button type="button" className="tg-ids-dash__btn" onClick={() => void refreshUsersData()}>
          ↻ Reload
        </button>
        <span className="tg-ids-dash__sync">
          {isStreaming ? (
            <span className="streaming">⟳ {streamLabel}</span>
          ) : (
            <>
              {filtered.length} / {overviewRows.length} shown
              {allUsersLoaded && lastSync ? ` · ${formatSyncTime(lastSync)}` : ''}
            </>
          )}
        </span>
      </div>

      <div className="tg-ids-dash__table-wrap">
        <table className="tg-ids-dash__table">
          <thead>
            <tr>
              <th>#</th>
              <th>Email</th>
              <th>Name</th>
              <th>Telegram @username</th>
              <th>Saved at</th>
            </tr>
          </thead>
          <tbody>
            {isStreaming && overviewRows.length > 0 ? (
              <tr className="tg-ids-dash__stream-row">
                <td colSpan={5}>⟳ {streamLabel} — list update ho rahi hai</td>
              </tr>
            ) : null}
            {!ready && fbConnecting ? (
              <tr className="empty">
                <td colSpan={5}>⏳ Firebase connect…</td>
              </tr>
            ) : !ready ? (
              <tr className="empty">
                <td colSpan={5}>⏳ Data load…</td>
              </tr>
            ) : !filtered.length ? (
              <tr className="empty">
                <td colSpan={5}>
                  {overviewRows.length === 0
                    ? 'Koi user nahi — pehle data load karein.'
                    : 'Is filter me koi user nahi.'}
                </td>
              </tr>
            ) : (
              filtered.map((r, idx) => (
                <tr
                  key={r.emailKey}
                  className={hasTelegramUsername(r) ? 'row-has-tg' : 'row-missing-tg'}
                >
                  <td>{idx + 1}</td>
                  <td className="email">{r.email}</td>
                  <td>{r.name}</td>
                  <td className="tg-user">
                    {hasTelegramUsername(r) ? (
                      <a
                        href={`https://t.me/${r.telegramUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        @{r.telegramUsername}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{formatLogin(r.telegramUsernameAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
