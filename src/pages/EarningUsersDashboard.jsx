import { useDeferredValue, useMemo, useState } from 'react'
import { useUsersData } from '../context/usersDataContext.js'
import {
  ELIGIBLE_MIN_EARNING_USD,
  filterEligibleEarningUsers,
  sortByTotalEarningsDesc,
  summarizeOverviewRows,
} from '../lib/buildUserOverviewRows.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import { safeNum } from '../lib/tshortnerSchema.js'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './EarningUsersDashboard.css'

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

function rowTotalBalance(row) {
  return safeNum(row.currentBalance) + safeNum(row.pendingBalance)
}

export default function EarningUsersDashboard() {
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
  const [onlyPendingWd, setOnlyPendingWd] = useState(false)
  const [onlyEarnOver1, setOnlyEarnOver1] = useState(false)
  const deferredSearch = useDeferredValue(search)

  const isStreaming = streamProgress?.streaming === true

  const allUsersSorted = useMemo(
    () => sortByTotalEarningsDesc(overviewRows),
    [overviewRows],
  )

  const earnOver1Count = useMemo(
    () => filterEligibleEarningUsers(overviewRows).length,
    [overviewRows],
  )

  const filtered = useMemo(() => {
    let list = allUsersSorted
    if (onlyEarnOver1) list = list.filter((r) => safeNum(r.totalEarnings) > ELIGIBLE_MIN_EARNING_USD)
    const q = deferredSearch.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (r) =>
          r.email.toLowerCase().includes(q) ||
          String(r.name).toLowerCase().includes(q),
      )
    }
    if (onlyPendingWd) list = list.filter((r) => r.withdrawalPending > 0)
    return list
  }, [allUsersSorted, deferredSearch, onlyPendingWd, onlyEarnOver1])

  const kpi = useMemo(() => summarizeOverviewRows(overviewRows), [overviewRows])
  const kpiFiltered = useMemo(() => summarizeOverviewRows(filtered), [filtered])
  const earnMinusWd = kpiFiltered.totalEarnings - kpiFiltered.totalWithdrawn

  const streamLabel =
    isStreaming && streamProgress
      ? `${formatInt(streamProgress.loaded)} / ${formatInt(streamProgress.total)} users`
      : ''

  return (
    <div className="earn-dash">
      <header className="earn-dash__hero">
        <div>
          <h1>
            All Users — Earnings &amp; Wallet
            <span className={'earn-dash__pill ' + (sessionLoaded && !isStreaming ? 'on' : '')}>
              {isStreaming ? '⟳ Loading' : sessionLoaded ? '● Ready' : '○ …'}
            </span>
          </h1>
          <p>
            Sabhi {formatInt(overviewRows.length)} users — zyada earn wale upar. Har mail: Earn −
            Withdrawn = Available. {formatInt(earnOver1Count)} users &gt; ${ELIGIBLE_MIN_EARNING_USD} earn.
            {isStreaming ? ` Abhi: ${streamLabel}…` : ''}
          </p>
        </div>
        <AdminSectionNav />
      </header>

      <div className="earn-dash__kpi">
        <div className="earn-dash__kpi-card highlight">
          <span>Total users</span>
          <strong>{ready ? formatInt(kpi.users) : '…'}</strong>
          <small>
            {ready ? `${formatInt(earnOver1Count)} earn &gt; $${ELIGIBLE_MIN_EARNING_USD}` : 'loading'}
          </small>
        </div>
        <div className="earn-dash__kpi-card">
          <span>Total earnings ($)</span>
          <strong>{ready ? formatUsd(kpi.totalEarnings) : '…'}</strong>
          <small>{ready ? `${formatInt(kpi.totalImpressions)} impressions` : '—'}</small>
        </div>
        <div className="earn-dash__kpi-card ok">
          <span>Available balance ($)</span>
          <strong>{ready ? formatUsd(kpi.walletBalance) : '…'}</strong>
          <small>currentBalance — withdraw ready</small>
        </div>
        <div className="earn-dash__kpi-card warn">
          <span>Withdrawal pending ($)</span>
          <strong>{ready ? formatUsd(kpi.walletPending) : '…'}</strong>
          <small>hold in requests</small>
        </div>
        <div className="earn-dash__kpi-card">
          <span>Total balance ($)</span>
          <strong>{ready ? formatUsd(kpi.walletBalance + kpi.walletPending) : '…'}</strong>
          <small>available + pending</small>
        </div>
        <div className="earn-dash__kpi-card">
          <span>Total withdrawn ($)</span>
          <strong>{ready ? formatUsd(kpi.totalWithdrawn) : '…'}</strong>
          <small>paid out</small>
        </div>
        <div className="earn-dash__kpi-card wd">
          <span>WD requests (pending)</span>
          <strong>{ready ? formatInt(kpi.pendingWithdrawals) : '…'}</strong>
          <small>{ready ? formatUsd(kpi.pendingWithdrawalAmt) : '—'}</small>
        </div>
      </div>

      <div className="earn-dash__toolbar">
        <input
          type="search"
          placeholder="Email / name search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search users"
        />
        <label className="earn-dash__chk">
          <input
            type="checkbox"
            checked={onlyEarnOver1}
            onChange={(e) => setOnlyEarnOver1(e.target.checked)}
          />
          sirf earn &gt; ${ELIGIBLE_MIN_EARNING_USD}
        </label>
        <label className="earn-dash__chk">
          <input
            type="checkbox"
            checked={onlyPendingWd}
            onChange={(e) => setOnlyPendingWd(e.target.checked)}
          />
          sirf pending withdrawal
        </label>
        <button type="button" className="earn-dash__btn" onClick={() => void refreshUsersData()}>
          ↻ Reload
        </button>
        <span className="earn-dash__sync">
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

      {ready ? (
        <p className="earn-dash__filter-note">
          Shown total: Earn {formatUsd(kpiFiltered.totalEarnings)} − Withdrawn{' '}
          {formatUsd(kpiFiltered.totalWithdrawn)} = {formatUsd(earnMinusWd)} · Available jod{' '}
          {formatUsd(kpiFiltered.walletBalance)}
          {Math.abs(earnMinusWd - kpiFiltered.walletBalance) > 0.02
            ? ` · diff ${formatUsd(kpiFiltered.walletBalance - earnMinusWd)}`
            : ' · match ✓'}
        </p>
      ) : null}

      <div className="earn-dash__table-wrap">
        <table className="earn-dash__table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>TG @user</th>
              <th>Total Earn ($)</th>
              <th>Available ($)</th>
              <th>WD Pending ($)</th>
              <th>Total Bal ($)</th>
              <th>Withdrawn ($)</th>
              <th>Dash Avail ($)</th>
              <th>WD Total</th>
              <th>WD Pending</th>
              <th>WD Pending $</th>
              <th>WD Approved</th>
              <th>WD Rejected</th>
              <th>Imps</th>
              <th>CPM ($)</th>
              <th>Today Imps</th>
              <th>TG</th>
              <th>Web</th>
              <th>Last login</th>
            </tr>
          </thead>
          <tbody>
            {isStreaming && overviewRows.length > 0 ? (
              <tr className="earn-dash__stream-row">
                <td colSpan={20}>⟳ {streamLabel} — list update ho rahi hai</td>
              </tr>
            ) : null}
            {!ready && fbConnecting ? (
              <tr className="empty">
                <td colSpan={20}>⏳ Firebase connect…</td>
              </tr>
            ) : !ready ? (
              <tr className="empty">
                <td colSpan={20}>⏳ Data load…</td>
              </tr>
            ) : !filtered.length ? (
              <tr className="empty">
                <td colSpan={20}>
                  {overviewRows.length === 0
                    ? 'Koi user nahi — pehle Load dabao.'
                    : 'Is filter me koi user nahi.'}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr
                  key={r.emailKey}
                  className={
                    (r.withdrawalPending > 0 ? 'row-pending-wd ' : '') +
                    (safeNum(r.totalEarnings) <= ELIGIBLE_MIN_EARNING_USD ? 'row-low-earn' : '')
                  }
                >
                  <td className="email">{r.email}</td>
                  <td>{r.name}</td>
                  <td className="email">{r.telegramUsername !== '—' ? `@${r.telegramUsername}` : '—'}</td>
                  <td>
                    <strong className="earn-val">{formatUsd(r.totalEarnings)}</strong>
                  </td>
                  <td
                    className={
                      'money ' + (safeNum(r.currentBalance) < 0 ? 'neg' : 'ok')
                    }
                  >
                    {formatUsd(r.currentBalance)}
                  </td>
                  <td className="money warn">{formatUsd(r.pendingBalance)}</td>
                  <td className="money">{formatUsd(rowTotalBalance(r))}</td>
                  <td>{formatUsd(r.totalWithdrawn)}</td>
                  <td>{formatUsd(r.totalAvailable)}</td>
                  <td>{r.withdrawalTotal}</td>
                  <td>
                    {r.withdrawalPending > 0 ? (
                      <strong className="wd-pending">{r.withdrawalPending}</strong>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td>{formatUsd(r.withdrawalPendingAmt)}</td>
                  <td>{r.withdrawalApproved}</td>
                  <td>{r.withdrawalRejected}</td>
                  <td>{formatInt(r.totalImpressions)}</td>
                  <td>{formatUsd(r.currentCPM)}</td>
                  <td>{formatInt(r.todayImpressions)}</td>
                  <td>{r.telegramLinks}</td>
                  <td>{r.websiteLinks}</td>
                  <td>{formatLogin(r.lastLogin)}</td>
                </tr>
              ))
            )}
          </tbody>
          {ready && filtered.length > 0 ? (
            <tfoot>
              <tr className="earn-dash__total-row">
                <td colSpan={3}>
                  <strong>TOTAL</strong>
                  <div className="earn-dash__total-sub">
                    {formatInt(kpiFiltered.users)} users
                    {filtered.length !== overviewRows.length
                      ? ` · filter on`
                      : ` · sabhi ${formatInt(overviewRows.length)}`}
                  </div>
                </td>
                <td>
                  <strong>{formatUsd(kpiFiltered.totalEarnings)}</strong>
                </td>
                <td className="money ok">
                  <strong>{formatUsd(kpiFiltered.walletBalance)}</strong>
                </td>
                <td className="money warn">
                  <strong>{formatUsd(kpiFiltered.walletPending)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiFiltered.totalBalance)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiFiltered.totalWithdrawn)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiFiltered.totalAvailable)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.withdrawalTotalCount)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.pendingWithdrawals)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiFiltered.pendingWithdrawalAmt)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.withdrawalApprovedCount)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.withdrawalRejectedCount)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.totalImpressions)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiFiltered.avgCPM)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.todayImpressions)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.telegramLinks)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiFiltered.websiteLinks)}</strong>
                </td>
                <td>—</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  )
}
