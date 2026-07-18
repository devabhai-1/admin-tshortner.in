import { useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUsersData } from '../context/usersDataContext.js'
import { summarizeOverviewRows } from '../lib/buildUserOverviewRows.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import './MainDashboard.css'

function formatLogin(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

function formatSyncTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function MainDashboard() {
  const {
    overviewRows,
    ready,
    fromCache,
    sessionLoaded,
    lastSync,
    updateTick,
    fbConnecting,
    streamProgress,
    allUsersLoaded,
  } = useUsersData()
  const [search, setSearch] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [onlyPendingWd, setOnlyPendingWd] = useState(false)

  const deferredSearch = useDeferredValue(search)

  const filtered = useMemo(() => {
    let list = overviewRows
    const q = deferredSearch.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (r) =>
          r.email.toLowerCase().includes(q) ||
          String(r.name).toLowerCase().includes(q),
      )
    }
    if (onlyActive) list = list.filter((r) => r.isActive)
    if (onlyPendingWd) list = list.filter((r) => r.withdrawalPending > 0)
    return list
  }, [overviewRows, deferredSearch, onlyActive, onlyPendingWd])

  const kpi = useMemo(() => summarizeOverviewRows(overviewRows), [overviewRows])
  const kpiVisible = useMemo(() => summarizeOverviewRows(filtered), [filtered])

  const isStreaming = streamProgress?.streaming === true
  const showTable = ready && overviewRows.length > 0
  const loadingFirst = !ready && fbConnecting
  const streamLabel =
    isStreaming && streamProgress
      ? `लोड हो रहा ${streamProgress.loaded.toLocaleString('en-IN')} / ${streamProgress.total.toLocaleString('en-IN')}`
      : ''

  return (
    <div className="main-dash">
      <header className="main-dash__hero">
        <div>
          <h1>
            Users Dashboard
            <span
              className={'main-dash__live ' + (sessionLoaded ? 'on' : '')}
              key={updateTick}
              title={lastSync ? `Loaded ${formatSyncTime(lastSync)}` : 'Connecting…'}
            >
              {sessionLoaded ? '● Saved' : isStreaming ? '⟳ Loading' : '○ …'}
            </span>
          </h1>
          <p>
            एक बार Firebase से load — data session में save रहेगा (page change / refresh पर दोबारा load नहीं).
            {isStreaming ? ` अभी: ${streamLabel}…` : ''}
            {sessionLoaded && !isStreaming ? ' · npm run dev बंद करने तक same data.' : ''}
          </p>
        </div>
        <div className="main-dash__quick-links">
          <Link to="/ga4" className="main-dash__panel-btn ga4">
            GA4 Analysis
          </Link>
          <Link to="/earning-users" className="main-dash__panel-btn earn">
            All Users
          </Link>
          <Link to="/telegram-ids" className="main-dash__panel-btn tg">
            Telegram IDs
          </Link>
          <Link to="/withdrawals" className="main-dash__panel-btn wd">
            Withdrawals
            {kpi.pendingWithdrawals > 0 ? (
              <span className="main-dash__panel-count">{kpi.pendingWithdrawals}</span>
            ) : null}
          </Link>
        </div>
      </header>

      <div className="main-dash__kpi">
        <div className="main-dash__kpi-card">
          <span>Total users</span>
          <strong>{ready ? formatInt(kpi.users) : '…'}</strong>
          <small>{ready ? `${formatInt(kpi.active)} active` : 'loading'}</small>
        </div>
        <div className="main-dash__kpi-card warn">
          <span>Pending withdrawals</span>
          <strong>{ready ? formatInt(kpi.pendingWithdrawals) : '…'}</strong>
          <small>{ready ? formatUsd(kpi.pendingWithdrawalAmt) : '—'}</small>
        </div>
        <div className="main-dash__kpi-card">
          <span>Total earnings ($) — सभी users</span>
          <strong>{ready ? formatUsd(kpi.totalEarnings) : '…'}</strong>
          <small>
            {isStreaming && streamProgress
              ? `⟳ ${formatInt(streamProgress.loaded)}/${formatInt(streamProgress.total)} users`
              : allUsersLoaded
                ? `${formatInt(kpi.users)} users · ${formatInt(kpi.totalImpressions)} imps`
                : ready
                  ? `${formatInt(kpi.totalImpressions)} imps`
                  : '—'}
          </small>
        </div>
        <div className="main-dash__kpi-card">
          <span>Wallet pending (USD)</span>
          <strong>{ready ? formatUsd(kpi.walletPending) : '…'}</strong>
          <small>{ready ? `Bal ${formatUsd(kpi.walletBalance)}` : '—'}</small>
        </div>
        <div className="main-dash__kpi-card ok">
          <span>Total withdrawn (USD)</span>
          <strong>{ready ? formatUsd(kpi.totalWithdrawn) : '…'}</strong>
          <small>all users</small>
        </div>
      </div>

      <div className="main-dash__toolbar">
        <input
          type="search"
          placeholder="Email या name search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search users"
        />
        <label className="main-dash__chk">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          सिर्फ active
        </label>
        <label className="main-dash__chk">
          <input
            type="checkbox"
            checked={onlyPendingWd}
            onChange={(e) => setOnlyPendingWd(e.target.checked)}
          />
          सिर्फ pending withdrawal
        </label>
        <span className="main-dash__sync">
          {loadingFirst ? (
            '⏳ Firebase connect…'
          ) : (
            <>
              {isStreaming ? (
                <span className="sync-streaming">⟳ {streamLabel}</span>
              ) : (
                <span className={sessionLoaded ? 'sync-live' : ''}>
                  {sessionLoaded ? '● Session' : '○'}
                </span>
              )}
              {' '}
              {filtered.length} / {overviewRows.length} users
              {streamProgress?.total && isStreaming
                ? ` (${Math.round((streamProgress.loaded / streamProgress.total) * 100)}%)`
                : ''}
              {lastSync && !isStreaming ? ` · ${formatSyncTime(lastSync)}` : ''}
              {fromCache && !isStreaming ? ' · saved' : ''}
            </>
          )}
        </span>
      </div>

      <div className="main-dash__table-wrap">
        <table className="main-dash__table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>TG @user</th>
              <th>Status</th>
              <th>Total Imps</th>
              <th>Total Earn ($)</th>
              <th>Today Imps</th>
              <th>CPM ($)</th>
              <th>Avail ($)</th>
              <th>Balance $</th>
              <th>Pending $</th>
              <th>Withdrawn $</th>
              <th>WD Total</th>
              <th>WD Pending</th>
              <th>WD Approved</th>
              <th>WD Rejected</th>
              <th>TG Links</th>
              <th>Web Links</th>
              <th>Last login</th>
            </tr>
          </thead>
          <tbody>
            {isStreaming && showTable ? (
              <tr className="main-dash__stream-row">
                <td colSpan={19}>⟳ {streamLabel} — जितना load हुआ उतना नीचे दिख रहा है</td>
              </tr>
            ) : null}
            {loadingFirst && !showTable ? (
              <tr className="empty">
                <td colSpan={19}>⏳ Firebase connect…</td>
              </tr>
            ) : !showTable && !ready ? (
              <tr className="empty">
                <td colSpan={19}>⏳ Data load…</td>
              </tr>
            ) : !showTable && ready ? (
              <tr className="empty">
                <td colSpan={19}>कोई user नहीं मिला।</td>
              </tr>
            ) : !filtered.length ? (
              <tr className="empty">
                <td colSpan={19}>कोई user इस filter में नहीं।</td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.emailKey} className={r.withdrawalPending > 0 ? 'row-pending-wd' : ''}>
                  <td className="email">{r.email}</td>
                  <td>{r.name}</td>
                  <td className="email">{r.telegramUsername !== '—' ? `@${r.telegramUsername}` : '—'}</td>
                  <td>
                    <span className={'main-dash__tag ' + (r.isActive ? 'active' : 'zero')}>
                      {r.isActive ? 'Active' : 'Zero'}
                    </span>
                  </td>
                  <td>{formatInt(r.totalImpressions)}</td>
                  <td>{formatUsd(r.totalEarnings)}</td>
                  <td>{formatInt(r.todayImpressions)}</td>
                  <td>{formatUsd(r.currentCPM)}</td>
                  <td>{formatUsd(r.totalAvailable)}</td>
                  <td>{formatUsd(r.currentBalance)}</td>
                  <td>{formatUsd(r.pendingBalance)}</td>
                  <td>{formatUsd(r.totalWithdrawn)}</td>
                  <td>{r.withdrawalTotal}</td>
                  <td>
                    {r.withdrawalPending > 0 ? (
                      <strong className="wd-pending">
                        {r.withdrawalPending} · {formatUsd(r.withdrawalPendingAmt)}
                      </strong>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td>{r.withdrawalApproved}</td>
                  <td>{r.withdrawalRejected}</td>
                  <td>{r.telegramLinks}</td>
                  <td>{r.websiteLinks}</td>
                  <td>{formatLogin(r.lastLogin)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
