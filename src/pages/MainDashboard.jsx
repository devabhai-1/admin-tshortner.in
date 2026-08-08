import { useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUsersData } from '../context/usersDataContext.js'
import {
  isNegativeBalanceUser,
  rowBalanceComparison,
  sortDashboardRows,
  summarizeOverviewRows,
} from '../lib/buildUserOverviewRows.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import { safeNum } from '../lib/tshortnerSchema.js'
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
  const [onlyMismatch, setOnlyMismatch] = useState(false)
  const [onlyNegative, setOnlyNegative] = useState(false)

  const deferredSearch = useDeferredValue(search)

  const sortedRows = useMemo(() => sortDashboardRows(overviewRows), [overviewRows])

  const negativeStats = useMemo(() => {
    const negRows = overviewRows
      .filter((r) => isNegativeBalanceUser(r))
      .sort((a, b) => safeNum(a.currentBalance) - safeNum(b.currentBalance))
    let sum = 0
    const emails = []
    for (const r of negRows) {
      sum += safeNum(r.currentBalance)
      if (emails.length < 8) {
        emails.push(`${r.email} (${formatUsd(r.currentBalance)})`)
      }
    }
    return { count: negRows.length, sum, emails }
  }, [overviewRows])

  const filtered = useMemo(() => {
    let list = sortedRows
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
    if (onlyMismatch) list = list.filter((r) => !rowBalanceComparison(r).matches)
    if (onlyNegative) list = list.filter((r) => isNegativeBalanceUser(r))
    // Filter ke baad bhi Total Bal$ minus wale top pe
    return sortDashboardRows(list)
  }, [sortedRows, deferredSearch, onlyActive, onlyPendingWd, onlyMismatch, onlyNegative])

  const kpi = useMemo(() => summarizeOverviewRows(overviewRows), [overviewRows])
  const kpiVisible = useMemo(() => summarizeOverviewRows(filtered), [filtered])

  const balanceCmp = useMemo(() => {
    const expected = kpiVisible.totalEarnings - kpiVisible.totalWithdrawn
    const diff = kpiVisible.walletBalance - expected
    let mismatchUsers = 0
    for (const r of filtered) {
      if (!rowBalanceComparison(r).matches) mismatchUsers += 1
    }
    return {
      expected,
      diff,
      matches: Math.abs(diff) <= 0.02,
      mismatchUsers,
    }
  }, [kpiVisible, filtered])

  const isStreaming = streamProgress?.streaming === true
  const showTable = ready && overviewRows.length > 0
  const loadingFirst = !ready && fbConnecting
  const streamLabel =
    isStreaming && streamProgress
      ? `लोड हो रहा ${streamProgress.loaded.toLocaleString('en-IN')} / ${streamProgress.total.toLocaleString('en-IN')}`
      : ''
  const filterOn = Boolean(
    search.trim() || onlyActive || onlyPendingWd || onlyMismatch || onlyNegative,
  )

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
            Total Bal $ minus wali mails list ke top pe · phir zyada views.
            {isStreaming ? ` अभी: ${streamLabel}…` : ''}
            {sessionLoaded && !isStreaming ? ' · session saved.' : ''}
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
          <Link to="/mail" className="main-dash__panel-btn mail">
            Mail Dashboard
          </Link>
          <Link to="/withdrawals" className="main-dash__panel-btn wd">
            Withdrawals
            {kpi.pendingWithdrawals > 0 ? (
              <span className="main-dash__panel-count">{kpi.pendingWithdrawals}</span>
            ) : null}
          </Link>
        </div>
      </header>

      {ready && negativeStats.count > 0 ? (
        <div className="main-dash__neg-alert" role="status">
          <strong>
            ⚠ Total Bal $ minus: {formatInt(negativeStats.count)} mails · sum{' '}
            {formatUsd(negativeStats.sum)}
          </strong>
          <span>
            {negativeStats.emails.join(' · ')}
            {negativeStats.count > negativeStats.emails.length
              ? ` · +${negativeStats.count - negativeStats.emails.length} more`
              : ''}
          </span>
          <button
            type="button"
            className="main-dash__neg-btn"
            onClick={() => setOnlyNegative(true)}
          >
            Sirf minus Total Bal
          </button>
        </div>
      ) : null}

      <div className="main-dash__kpi">
        <div className="main-dash__kpi-card">
          <span>Total users</span>
          <strong>{ready ? formatInt(kpi.users) : '…'}</strong>
          <small>{ready ? `${formatInt(kpi.active)} active` : 'loading'}</small>
        </div>
        <div className="main-dash__kpi-card">
          <span>Total views (imps)</span>
          <strong>{ready ? formatInt(kpi.totalImpressions) : '…'}</strong>
          <small>
            {isStreaming && streamProgress
              ? `⟳ ${formatInt(streamProgress.loaded)}/${formatInt(streamProgress.total)}`
              : allUsersLoaded
                ? `${formatInt(kpi.users)} users`
                : ready
                  ? 'impressions sum'
                  : '—'}
          </small>
        </div>
        <div className="main-dash__kpi-card">
          <span>Total earnings ($)</span>
          <strong>{ready ? formatUsd(kpi.totalEarnings) : '…'}</strong>
          <small>सभी users</small>
        </div>
        <div className="main-dash__kpi-card ok">
          <span>Total balance ($)</span>
          <strong>{ready ? formatUsd(kpi.walletBalance) : '…'}</strong>
          <small>currentBalance sum</small>
        </div>
        <div className="main-dash__kpi-card bad">
          <span>Total Bal $ minus</span>
          <strong>{ready ? formatUsd(negativeStats.sum) : '…'}</strong>
          <small>
            {ready
              ? negativeStats.count > 0
                ? `${formatInt(negativeStats.count)} mails — table top pe`
                : 'koi minus Total Bal nahi'
              : '—'}
          </small>
        </div>
        <div className="main-dash__kpi-card warn">
          <span>Pending balance ($)</span>
          <strong>{ready ? formatUsd(kpi.walletPending) : '…'}</strong>
          <small>
            {ready
              ? `${formatInt(kpi.pendingWithdrawals)} WD · ${formatUsd(kpi.pendingWithdrawalAmt)}`
              : '—'}
          </small>
        </div>
        <div className="main-dash__kpi-card">
          <span>Total withdrawn ($)</span>
          <strong>{ready ? formatUsd(kpi.totalWithdrawn) : '…'}</strong>
          <small>paid out sum</small>
        </div>
      </div>

      {ready ? (
        <div className={'main-dash__balance-cmp ' + (balanceCmp.matches ? 'ok' : 'bad')}>
          <span>Balance comparison (shown rows):</span>
          <strong>
            Earn {formatUsd(kpiVisible.totalEarnings)} − WD {formatUsd(kpiVisible.totalWithdrawn)} ={' '}
            {formatUsd(balanceCmp.expected)}
          </strong>
          <strong>Wallet bal {formatUsd(kpiVisible.walletBalance)}</strong>
          <strong>
            Pending {formatUsd(kpiVisible.walletPending)} · Bal+Pending{' '}
            {formatUsd(kpiVisible.totalBalance)}
          </strong>
          <strong className={balanceCmp.matches ? 'match' : 'diff'}>
            {balanceCmp.matches
              ? '✓ Match'
              : `✗ Diff ${formatUsd(balanceCmp.diff)} · ${formatInt(balanceCmp.mismatchUsers)} users`}
          </strong>
        </div>
      ) : null}

      {ready && filterOn ? (
        <div className="main-dash__kpi-filter">
          <span>Filter totals:</span>
          <strong>Views {formatInt(kpiVisible.totalImpressions)}</strong>
          <strong>Bal {formatUsd(kpiVisible.walletBalance)}</strong>
          <strong className="warn">Pending {formatUsd(kpiVisible.walletPending)}</strong>
          <strong className="accent">Total {formatUsd(kpiVisible.totalBalance)}</strong>
          <strong>Withdrawn {formatUsd(kpiVisible.totalWithdrawn)}</strong>
          <em>{formatInt(kpiVisible.users)} users</em>
        </div>
      ) : null}

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
        <label className="main-dash__chk">
          <input
            type="checkbox"
            checked={onlyMismatch}
            onChange={(e) => setOnlyMismatch(e.target.checked)}
          />
          सिर्फ balance mismatch
        </label>
        <label className="main-dash__chk">
          <input
            type="checkbox"
            checked={onlyNegative}
            onChange={(e) => setOnlyNegative(e.target.checked)}
          />
          सिर्फ minus balance
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
              )}{' '}
              {filtered.length} / {overviewRows.length} users · minus pehle · views ↓
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
              <th>#</th>
              <th>Email</th>
              <th>Name</th>
              <th>TG @user</th>
              <th>Status</th>
              <th>Total Views</th>
              <th>Total Earn ($)</th>
              <th>Today Views</th>
              <th>CPM ($)</th>
              <th>Expected $</th>
              <th title="currentBalance — minus wale top pe">Total Bal $ ↓</th>
              <th>Pending Bal $</th>
              <th>Withdrawn $</th>
              <th>Diff $</th>
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
                <td colSpan={21}>⟳ {streamLabel} — जितना load हुआ उतना नीचे दिख रहा है</td>
              </tr>
            ) : null}
            {loadingFirst && !showTable ? (
              <tr className="empty">
                <td colSpan={21}>⏳ Firebase connect…</td>
              </tr>
            ) : !showTable && !ready ? (
              <tr className="empty">
                <td colSpan={21}>⏳ Data load…</td>
              </tr>
            ) : !showTable && ready ? (
              <tr className="empty">
                <td colSpan={21}>कोई user नहीं मिला।</td>
              </tr>
            ) : !filtered.length ? (
              <tr className="empty">
                <td colSpan={21}>कोई user इस filter में नहीं।</td>
              </tr>
            ) : (
              filtered.map((r, i) => {
                const cmp = rowBalanceComparison(r)
                const isNeg = isNegativeBalanceUser(r)
                return (
                  <tr
                    key={r.emailKey}
                    className={
                      (r.withdrawalPending > 0 ? 'row-pending-wd ' : '') +
                      (isNeg ? 'row-neg-bal ' : '') +
                      (cmp.matches ? '' : 'row-bal-mismatch')
                    }
                  >
                    <td className="rank">{i + 1}</td>
                    <td className="email">{r.email}</td>
                    <td>{r.name}</td>
                    <td className="email">
                      {r.telegramUsername !== '—' ? `@${r.telegramUsername}` : '—'}
                    </td>
                    <td>
                      <span className={'main-dash__tag ' + (r.isActive ? 'active' : 'zero')}>
                        {r.isActive ? 'Active' : 'Zero'}
                      </span>
                    </td>
                    <td>
                      <strong className="views-val">{formatInt(r.totalImpressions)}</strong>
                    </td>
                    <td>{formatUsd(r.totalEarnings)}</td>
                    <td>{formatInt(r.todayImpressions)}</td>
                    <td>{formatUsd(r.currentCPM)}</td>
                    <td title="Earn − Withdrawn">{formatUsd(cmp.expectedAvailable)}</td>
                    <td
                      className={
                        'money ' +
                        (isNeg ? 'neg' : cmp.matches ? 'ok' : '')
                      }
                    >
                      {isNeg ? (
                        <strong className="neg-flag">{formatUsd(r.currentBalance)}</strong>
                      ) : (
                        formatUsd(r.currentBalance)
                      )}
                    </td>
                    <td className="money warn">{formatUsd(r.pendingBalance)}</td>
                    <td>{formatUsd(r.totalWithdrawn)}</td>
                    <td className={cmp.matches ? 'diff-ok' : 'diff-bad'}>
                      {cmp.matches ? '✓' : formatUsd(cmp.diff)}
                    </td>
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
                )
              })
            )}
          </tbody>
          {showTable && filtered.length > 0 ? (
            <tfoot>
              <tr className="main-dash__totals-row">
                <td colSpan={5}>
                  TOTAL ({formatInt(kpiVisible.users)} users
                  {filterOn ? ' — filtered' : ''} · minus pehle · views ↓)
                </td>
                <td>
                  <strong>{formatInt(kpiVisible.totalImpressions)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiVisible.totalEarnings)}</strong>
                </td>
                <td>
                  <strong>{formatInt(kpiVisible.todayImpressions)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiVisible.avgCPM)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(balanceCmp.expected)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiVisible.walletBalance)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiVisible.walletPending)}</strong>
                </td>
                <td>
                  <strong>{formatUsd(kpiVisible.totalWithdrawn)}</strong>
                </td>
                <td className={balanceCmp.matches ? 'diff-ok' : 'diff-bad'}>
                  <strong>
                    {balanceCmp.matches ? '✓' : formatUsd(balanceCmp.diff)}
                  </strong>
                </td>
                <td colSpan={7}>
                  <strong className="main-dash__total-combo">
                    Bal + Pending = {formatUsd(kpiVisible.totalBalance)}
                  </strong>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  )
}
