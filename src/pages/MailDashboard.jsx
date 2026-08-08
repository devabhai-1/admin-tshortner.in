import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useUsersData } from '../context/usersDataContext.js'
import { dashboardSummary } from '../lib/dashboardActivity.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import { readDailyMap, safeNum } from '../lib/tshortnerSchema.js'
import {
  formatAccountDetails,
  parseWithdrawalRequests,
  withdrawalStatusBucket,
  withdrawalStatusLabel,
} from '../lib/withdrawals.js'
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './MailDashboard.css'

function isBankMethod(method) {
  const m = String(method || '').toLowerCase()
  return m === 'bank' || m.includes('bank')
}

function WithdrawalAccountCell({ w }) {
  const bank =
    isBankMethod(w.method) ||
    Boolean(w.bankName || w.accountNumber || w.ifscCode || w.accountHolderName)

  if (!bank) {
    return <span>{w.account || formatAccountDetails(w) || '—'}</span>
  }

  return (
    <div className="mail-dash__bank">
      <strong>{formatAccountDetails(w)}</strong>
      <dl>
        {w.accountHolderName ? (
          <div>
            <dt>Holder</dt>
            <dd>{w.accountHolderName}</dd>
          </div>
        ) : null}
        {w.bankName ? (
          <div>
            <dt>Bank</dt>
            <dd>{w.bankName}</dd>
          </div>
        ) : null}
        {w.accountNumber ? (
          <div>
            <dt>A/C No</dt>
            <dd className="mono">{w.accountNumber}</dd>
          </div>
        ) : null}
        {w.ifscCode ? (
          <div>
            <dt>IFSC</dt>
            <dd className="mono">{w.ifscCode}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}

function formatTs(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
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

function linkList(channel) {
  if (!channel) return []
  const list = channel.list
  if (Array.isArray(list)) return list.filter(Boolean)
  if (list && typeof list === 'object') return Object.values(list).filter(Boolean)
  return []
}

function statusClass(status) {
  const b = withdrawalStatusBucket(status)
  if (b === 'approved') return 'ok'
  if (b === 'rejected') return 'bad'
  return 'warn'
}

export default function MailDashboard() {
  const {
    usersVal,
    overviewRows,
    withdrawalRequests,
    ready,
    sessionLoaded,
    lastSync,
    streamProgress,
    allUsersLoaded,
    fbConnecting,
    refreshUsersData,
    refreshUser,
    reloadBusy,
  } = useUsersData()

  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const deferredSearch = useDeferredValue(search)

  const isStreaming = streamProgress?.streaming === true

  // Cache me full usersVal nahi hota — mail select par Firebase se poora node lao
  useEffect(() => {
    if (!selectedKey) {
      setDetailLoading(false)
      setDetailError('')
      return undefined
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError('')
    void (async () => {
      try {
        await refreshUser(selectedKey)
        if (!cancelled) setDetailLoading(false)
      } catch (err) {
        if (!cancelled) {
          setDetailLoading(false)
          setDetailError(err?.message || 'User detail load fail')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedKey, refreshUser])

  const emailOptions = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    let list = overviewRows
    if (q) {
      list = list.filter(
        (r) =>
          r.email.toLowerCase().includes(q) ||
          String(r.name).toLowerCase().includes(q) ||
          String(r.telegramUsername).toLowerCase().includes(q),
      )
    }
    return list
  }, [overviewRows, deferredSearch])

  const selectedRow = useMemo(
    () => overviewRows.find((r) => r.emailKey === selectedKey) || null,
    [overviewRows, selectedKey],
  )

  const rawUser = useMemo(() => {
    if (!selectedKey || !usersVal) return null
    return usersVal[selectedKey] || null
  }, [usersVal, selectedKey])

  const profile = rawUser?.profile || {}
  const dashboard = rawUser?.dashboard || {}
  const wallet = rawUser?.wallet || {}
  const links = rawUser?.links || {}

  const dailyRows = useMemo(() => {
    const map = readDailyMap(dashboard)
    return Object.entries(map)
      .map(([date, row]) => ({ date, ...row }))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [dashboard])

  const dashSum = useMemo(() => dashboardSummary(dashboard), [dashboard])

  const storedEarnMismatch = useMemo(() => {
    if (!dashSum.fromDaily) return null
    const stored = Math.max(
      safeNum(dashboard.totalEarning ?? dashboard.totalEarnings),
      safeNum(dashboard.totalavailable ?? dashboard.totalAvailable),
    )
    const dailyEarn = safeNum(dashSum.totalEarnings)
    if (Math.abs(stored - dailyEarn) <= 0.05) return null
    return { stored, dailyEarn }
  }, [dashSum, dashboard])

  const withdrawals = useMemo(() => {
    const fromWallet = parseWithdrawalRequests(wallet.withdrawalRequests)
    if (fromWallet.length > 0) {
      return [...fromWallet].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    }
    // Fallback: flat list from cache/session (emailKey filter)
    return withdrawalRequests
      .filter((r) => r.emailKey === selectedKey)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }, [wallet.withdrawalRequests, withdrawalRequests, selectedKey])

  const tgLinks = useMemo(() => linkList(links.telegram), [links.telegram])
  const webLinks = useMemo(() => linkList(links.website), [links.website])

  const streamLabel =
    isStreaming && streamProgress
      ? `${formatInt(streamProgress.loaded)} / ${formatInt(streamProgress.total)} users`
      : ''

  return (
    <div className="mail-dash">
      <header className="mail-dash__hero">
        <div>
          <h1>
            Mail Dashboard
            <span className={'mail-dash__pill ' + (sessionLoaded && !isStreaming ? 'on' : '')}>
              {isStreaming ? '⟳ Loading' : sessionLoaded ? '● Ready' : '○ …'}
            </span>
          </h1>
          <p>
            Mail select karo — us user ka name, Telegram, wallet, withdrawals, earnings aur links sab ek jagah.
            {isStreaming ? ` Abhi: ${streamLabel}…` : ''}
          </p>
        </div>
        <AdminSectionNav />
      </header>

      <div className="mail-dash__picker">
        <div className="mail-dash__picker-tools">
          <input
            type="search"
            placeholder="Email / name / @telegram search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search mails"
          />
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            aria-label="Select mail"
            disabled={!ready}
          >
            <option value="">
              {ready ? `Select mail (${formatInt(emailOptions.length)})` : 'Loading users…'}
            </option>
            {emailOptions.map((r) => (
              <option key={r.emailKey} value={r.emailKey}>
                {r.email}
                {r.name && r.name !== '—' ? ` — ${r.name}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mail-dash__reload"
            onClick={() => {
              if (selectedKey) void refreshUser(selectedKey)
              else void refreshUsersData()
            }}
            disabled={reloadBusy || fbConnecting || detailLoading}
          >
            {detailLoading || reloadBusy ? 'Loading…' : selectedKey ? 'Refresh mail' : 'Reload'}
          </button>
        </div>
        <div className="mail-dash__picker-meta">
          <span>{ready ? `${formatInt(overviewRows.length)} mails` : '…'}</span>
          {lastSync ? <span>Synced {formatSyncTime(lastSync)}</span> : null}
          {allUsersLoaded ? <span>All loaded</span> : null}
          {detailLoading ? <span>Fetching full user…</span> : null}
          {detailError ? <span className="mail-dash__err">{detailError}</span> : null}
        </div>
      </div>

      {!selectedKey ? (
        <div className="mail-dash__empty">
          <strong>Koi mail select nahi hua</strong>
          <p>Upar se email choose karo — uska poora profile, dashboard aur withdrawals yahan dikhenge.</p>
        </div>
      ) : !rawUser && !selectedRow && !detailLoading ? (
        <div className="mail-dash__empty">
          <strong>User data nahi mila</strong>
          <p>Is mail ke liye Firebase me node nahi hai ya abhi load nahi hua.</p>
        </div>
      ) : (
        <>
          {detailLoading && !rawUser ? (
            <div className="mail-dash__empty">
              <strong>User detail load ho raha hai…</strong>
              <p>Firebase se withdrawals, daily earnings aur links fetch kiye ja rahe hain.</p>
            </div>
          ) : null}

          <section className="mail-dash__profile">
            <div className="mail-dash__profile-main">
              <h2>{profile.name || selectedRow?.name || '—'}</h2>
              <p className="mail-dash__email">{profile.email || selectedRow?.email || '—'}</p>
              <div className="mail-dash__tags">
                {(profile.telegramUsername || selectedRow?.telegramUsername) &&
                (profile.telegramUsername || selectedRow?.telegramUsername) !== '—' ? (
                  <span className="mail-dash__tag tg">
                    @{String(profile.telegramUsername || selectedRow.telegramUsername).replace(/^@/, '')}
                  </span>
                ) : (
                  <span className="mail-dash__tag muted">No Telegram @</span>
                )}
                {profile.country ? <span className="mail-dash__tag">{profile.country}</span> : null}
                {selectedRow?.isActive ? (
                  <span className="mail-dash__tag ok">Active</span>
                ) : (
                  <span className="mail-dash__tag muted">Inactive</span>
                )}
              </div>
            </div>
            <dl className="mail-dash__meta-grid">
              <div>
                <dt>UID</dt>
                <dd>{profile.uid || '—'}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatTs(profile.createdAt)}</dd>
              </div>
              <div>
                <dt>Last login</dt>
                <dd>{formatTs(profile.lastLogin || selectedRow?.lastLogin)}</dd>
              </div>
              <div>
                <dt>TG saved at</dt>
                <dd>{formatTs(profile.telegramUsernameAt || selectedRow?.telegramUsernameAt)}</dd>
              </div>
              <div>
                <dt>Email key</dt>
                <dd className="mono">{selectedKey}</dd>
              </div>
            </dl>
          </section>

          <div className="mail-dash__kpi">
            <div className="mail-dash__kpi-card highlight">
              <span>Total earnings</span>
              <strong>{formatUsd(dashSum.totalEarnings)}</strong>
              <small>
                {dashSum.fromDaily
                  ? `daily rows sum · ${formatInt(dailyRows.length)} days`
                  : 'dashboard total'}
              </small>
            </div>
            <div className="mail-dash__kpi-card">
              <span>Impressions</span>
              <strong>{formatInt(dashSum.totalImpressions)}</strong>
              <small>today {formatInt(dashSum.todayImpressions)}</small>
            </div>
            <div className="mail-dash__kpi-card">
              <span>CPM</span>
              <strong>{formatUsd(dashSum.currentCPM)}</strong>
              <small>overall from daily</small>
            </div>
            <div className="mail-dash__kpi-card ok">
              <span>Wallet available</span>
              <strong>
                {formatUsd(
                  wallet.currentBalance != null ? wallet.currentBalance : selectedRow?.currentBalance,
                )}
              </strong>
              <small>current balance</small>
            </div>
            <div className="mail-dash__kpi-card warn">
              <span>Pending WD</span>
              <strong>
                {formatUsd(
                  wallet.pendingBalance != null ? wallet.pendingBalance : selectedRow?.pendingBalance,
                )}
              </strong>
              <small>{formatInt(selectedRow?.withdrawalPending || withdrawals.filter((w) => statusClass(w.status) === 'warn').length)} requests</small>
            </div>
            <div className="mail-dash__kpi-card">
              <span>Total withdrawn</span>
              <strong>
                {formatUsd(
                  wallet.totalWithdrawn != null ? wallet.totalWithdrawn : selectedRow?.totalWithdrawn,
                )}
              </strong>
              <small>
                {formatInt(selectedRow?.withdrawalApproved || 0)} paid ·{' '}
                {formatInt(selectedRow?.withdrawalRejected || 0)} rejected
              </small>
            </div>
          </div>

          {storedEarnMismatch ? (
            <div className="mail-dash__mismatch" role="status">
              <strong>⚠ Stale dashboard total</strong>
              <span>
                Daily sum = {formatUsd(storedEarnMismatch.dailyEarn)} · Firebase stored Available/Earn
                = {formatUsd(storedEarnMismatch.stored)} — galat bada number. Sahi earn daily sum hai.
                Withdrawals → Load + Analysis → सभी Update se wallet + summary repair ho jayega.
              </span>
            </div>
          ) : null}

          <div className="mail-dash__grid">
            <section className="mail-dash__panel">
              <h3>
                Withdrawals
                <span>{formatInt(withdrawals.length)}</span>
              </h3>
              {withdrawals.length === 0 ? (
                <p className="mail-dash__panel-empty">
                  {detailLoading
                    ? 'Withdrawals load ho rahe hain…'
                    : 'Is mail ne abhi koi withdrawal request nahi ki.'}
                </p>
              ) : (
                <div className="mail-dash__table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Amount</th>
                        <th>Method</th>
                        <th>Account</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {withdrawals.map((w) => (
                        <tr key={w.requestKey}>
                          <td>{formatTs(w.createdAt)}</td>
                          <td>{formatUsd(w.amount)}</td>
                          <td>{w.method || '—'}</td>
                          <td className="mail-dash__account">
                            <WithdrawalAccountCell w={w} />
                          </td>
                          <td>
                            <span className={'mail-dash__status ' + statusClass(w.status)}>
                              {withdrawalStatusLabel(w.status)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="mail-dash__panel">
              <h3>
                Daily earnings
                <span>{formatInt(dailyRows.length)} days</span>
              </h3>
              {dailyRows.length === 0 ? (
                <p className="mail-dash__panel-empty">
                  {detailLoading
                    ? 'Daily data load ho raha hai…'
                    : 'Is mail ka daily dashboard data abhi empty hai.'}
                </p>
              ) : (
                <div className="mail-dash__table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Impressions</th>
                        <th>CPM</th>
                        <th>Earning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyRows.map((d) => (
                        <tr key={d.date}>
                          <td>{d.date}</td>
                          <td>{formatInt(d.impressions)}</td>
                          <td>{formatUsd(d.cpm)}</td>
                          <td>{formatUsd(d.earning)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="mail-dash__panel">
              <h3>
                Telegram links
                <span>{formatInt(tgLinks.length)}</span>
              </h3>
              {tgLinks.length === 0 ? (
                <p className="mail-dash__panel-empty">
                  {detailLoading ? 'Links load ho rahe hain…' : 'Koi Telegram link nahi.'}
                </p>
              ) : (
                <ul className="mail-dash__links">
                  {tgLinks.map((item, i) => (
                    <li key={item.id || item.url || i}>
                      <strong>{item.title || item.name || item.shortCode || `Link ${i + 1}`}</strong>
                      <span>{item.url || item.originalUrl || item.shortUrl || '—'}</span>
                      <small>
                        clicks {formatInt(item.clicks ?? item.totalClicks)} · status{' '}
                        {item.status || (item.active === false ? 'inactive' : 'active')}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              {links.telegram ? (
                <p className="mail-dash__link-summary">
                  Channel total: {formatInt(links.telegram.totalLinks)} links ·{' '}
                  {formatInt(links.telegram.activeLinks)} active ·{' '}
                  {formatInt(links.telegram.totalClicks)} clicks
                </p>
              ) : null}
            </section>

            <section className="mail-dash__panel">
              <h3>
                Website links
                <span>{formatInt(webLinks.length)}</span>
              </h3>
              {webLinks.length === 0 ? (
                <p className="mail-dash__panel-empty">
                  {detailLoading ? 'Links load ho rahe hain…' : 'Koi website link nahi.'}
                </p>
              ) : (
                <ul className="mail-dash__links">
                  {webLinks.map((item, i) => (
                    <li key={item.id || item.url || i}>
                      <strong>{item.title || item.name || item.shortCode || `Link ${i + 1}`}</strong>
                      <span>{item.url || item.originalUrl || item.shortUrl || '—'}</span>
                      <small>
                        clicks {formatInt(item.clicks ?? item.totalClicks)} · status{' '}
                        {item.status || (item.active === false ? 'inactive' : 'active')}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              {links.website ? (
                <p className="mail-dash__link-summary">
                  Channel total: {formatInt(links.website.totalLinks)} links ·{' '}
                  {formatInt(links.website.activeLinks)} active ·{' '}
                  {formatInt(links.website.totalClicks)} clicks
                </p>
              ) : null}
            </section>
          </div>

          <section className="mail-dash__panel mail-dash__raw">
            <h3>Dashboard snapshot</h3>
            <dl className="mail-dash__snap">
              <div>
                <dt>Daily earning</dt>
                <dd>{formatUsd(dashboard.dailyEarning)}</dd>
              </div>
              <div>
                <dt>Daily CPM</dt>
                <dd>{formatUsd(dashboard.dailyCPM)}</dd>
              </div>
              <div>
                <dt>Total earning (daily sum)</dt>
                <dd>{formatUsd(dashSum.totalEarnings)}</dd>
              </div>
              <div>
                <dt>Stored totalEarning</dt>
                <dd>
                  {formatUsd(dashboard.totalEarning ?? dashboard.totalEarnings)}
                  {storedEarnMismatch ? ' ⚠' : ''}
                </dd>
              </div>
              <div>
                <dt>Total impressions</dt>
                <dd>{formatInt(dashSum.totalImpressions)}</dd>
              </div>
              <div>
                <dt>Overall CPM</dt>
                <dd>{formatUsd(dashSum.currentCPM)}</dd>
              </div>
              <div>
                <dt>Withdrawn (dash)</dt>
                <dd>{formatUsd(dashboard.withdrawnAmount ?? selectedRow?.withdrawnAmount)}</dd>
              </div>
              <div>
                <dt>Available stored</dt>
                <dd>
                  {formatUsd(
                    dashboard.totalavailable ?? dashboard.totalAvailable ?? selectedRow?.totalAvailable,
                  )}
                  {storedEarnMismatch ? ' ⚠ stale' : ''}
                </dd>
              </div>
              <div>
                <dt>Expected bal (Earn−WD−Pend)</dt>
                <dd>
                  {formatUsd(
                    safeNum(dashSum.totalEarnings) -
                      safeNum(wallet.totalWithdrawn) -
                      safeNum(wallet.pendingBalance),
                  )}
                </dd>
              </div>
              <div>
                <dt>Wallet current</dt>
                <dd>
                  {formatUsd(
                    wallet.currentBalance != null ? wallet.currentBalance : selectedRow?.currentBalance,
                  )}
                </dd>
              </div>
              <div>
                <dt>Wallet pending</dt>
                <dd>
                  {formatUsd(
                    wallet.pendingBalance != null ? wallet.pendingBalance : selectedRow?.pendingBalance,
                  )}
                </dd>
              </div>
              <div>
                <dt>Wallet withdrawn</dt>
                <dd>
                  {formatUsd(
                    wallet.totalWithdrawn != null ? wallet.totalWithdrawn : selectedRow?.totalWithdrawn,
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </div>
  )
}
