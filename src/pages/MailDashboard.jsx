import { useDeferredValue, useMemo, useState } from 'react'
import { useUsersData } from '../context/usersDataContext.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import { readDailyMap } from '../lib/tshortnerSchema.js'
import {
  formatAccountDetails,
  parseWithdrawalRequests,
  withdrawalStatusBucket,
  withdrawalStatusLabel,
} from '../lib/withdrawals.js'

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
import AdminSectionNav from '../components/AdminSectionNav.jsx'
import './MailDashboard.css'

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
    ready,
    sessionLoaded,
    lastSync,
    streamProgress,
    allUsersLoaded,
    fbConnecting,
    refreshUsersData,
    reloadBusy,
  } = useUsersData()

  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const deferredSearch = useDeferredValue(search)

  const isStreaming = streamProgress?.streaming === true

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

  const withdrawals = useMemo(() => {
    const list = parseWithdrawalRequests(wallet.withdrawalRequests)
    return [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }, [wallet.withdrawalRequests])

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
            onClick={() => refreshUsersData()}
            disabled={reloadBusy || fbConnecting}
          >
            {reloadBusy ? 'Reloading…' : 'Reload'}
          </button>
        </div>
        <div className="mail-dash__picker-meta">
          <span>{ready ? `${formatInt(overviewRows.length)} mails` : '…'}</span>
          {lastSync ? <span>Synced {formatSyncTime(lastSync)}</span> : null}
          {allUsersLoaded ? <span>All loaded</span> : null}
        </div>
      </div>

      {!selectedKey ? (
        <div className="mail-dash__empty">
          <strong>Koi mail select nahi hua</strong>
          <p>Upar se email choose karo — uska poora profile, dashboard aur withdrawals yahan dikhenge.</p>
        </div>
      ) : !rawUser && !selectedRow ? (
        <div className="mail-dash__empty">
          <strong>User data nahi mila</strong>
          <p>Is mail ke liye Firebase me node nahi hai ya abhi load nahi hua.</p>
        </div>
      ) : (
        <>
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
              <strong>{formatUsd(selectedRow?.totalEarnings ?? dashboard.totalEarning)}</strong>
              <small>dashboard total</small>
            </div>
            <div className="mail-dash__kpi-card">
              <span>Impressions</span>
              <strong>{formatInt(selectedRow?.totalImpressions ?? dashboard.totalImpressions)}</strong>
              <small>today {formatInt(selectedRow?.todayImpressions)}</small>
            </div>
            <div className="mail-dash__kpi-card">
              <span>CPM</span>
              <strong>{formatUsd(selectedRow?.currentCPM ?? dashboard.overallCPM)}</strong>
              <small>overall</small>
            </div>
            <div className="mail-dash__kpi-card ok">
              <span>Wallet available</span>
              <strong>{formatUsd(wallet.currentBalance ?? selectedRow?.currentBalance)}</strong>
              <small>current balance</small>
            </div>
            <div className="mail-dash__kpi-card warn">
              <span>Pending WD</span>
              <strong>{formatUsd(wallet.pendingBalance ?? selectedRow?.pendingBalance)}</strong>
              <small>{formatInt(selectedRow?.withdrawalPending || 0)} requests</small>
            </div>
            <div className="mail-dash__kpi-card">
              <span>Total withdrawn</span>
              <strong>{formatUsd(wallet.totalWithdrawn ?? selectedRow?.totalWithdrawn)}</strong>
              <small>
                {formatInt(selectedRow?.withdrawalApproved || 0)} paid ·{' '}
                {formatInt(selectedRow?.withdrawalRejected || 0)} rejected
              </small>
            </div>
          </div>

          <div className="mail-dash__grid">
            <section className="mail-dash__panel">
              <h3>
                Withdrawals
                <span>{formatInt(withdrawals.length)}</span>
              </h3>
              {withdrawals.length === 0 ? (
                <p className="mail-dash__panel-empty">Is mail ne abhi koi withdrawal request nahi ki.</p>
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
                <p className="mail-dash__panel-empty">Is mail ka daily dashboard data abhi empty hai.</p>
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
                <p className="mail-dash__panel-empty">Koi Telegram link nahi.</p>
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
                <p className="mail-dash__panel-empty">Koi website link nahi.</p>
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
                <dt>Total earning</dt>
                <dd>{formatUsd(dashboard.totalEarning ?? dashboard.totalEarnings)}</dd>
              </div>
              <div>
                <dt>Total impressions</dt>
                <dd>{formatInt(dashboard.totalImpressions)}</dd>
              </div>
              <div>
                <dt>Overall CPM</dt>
                <dd>{formatUsd(dashboard.overallCPM ?? dashboard.currentCPM)}</dd>
              </div>
              <div>
                <dt>Withdrawn (dash)</dt>
                <dd>{formatUsd(dashboard.withdrawnAmount)}</dd>
              </div>
              <div>
                <dt>Available (dash)</dt>
                <dd>{formatUsd(dashboard.totalavailable ?? dashboard.totalAvailable)}</dd>
              </div>
              <div>
                <dt>Wallet current</dt>
                <dd>{formatUsd(wallet.currentBalance)}</dd>
              </div>
              <div>
                <dt>Wallet pending</dt>
                <dd>{formatUsd(wallet.pendingBalance)}</dd>
              </div>
              <div>
                <dt>Wallet withdrawn</dt>
                <dd>{formatUsd(wallet.totalWithdrawn)}</dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </div>
  )
}
