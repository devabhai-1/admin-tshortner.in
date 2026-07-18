import { useCallback, useMemo, useState } from 'react'
import { ref, get, update } from 'firebase/database'
import { useFirebaseDb } from '../context/FirebaseProvider.jsx'
import { clearUsersDataCaches } from '../context/usersDataCache.js'
import { useUsersData } from '../context/usersDataContext.js'
import { usersDataSession } from '../context/usersDataSession.js'
import { summarizeOverviewRows } from '../lib/buildUserOverviewRows.js'
import { formatInt, formatUsd } from '../lib/formatMoney.js'
import { safeNum, toFixed2 } from '../lib/tshortnerSchema.js'
import { computeWithdrawalAnalysis } from '../lib/withdrawalAnalysis.js'
import { syncAllWalletBalancesFromAnalysis } from '../lib/withdrawalWalletSync.js'
import {
  formatAccountDetails,
  formatWithdrawalDate,
  parseWithdrawalRequests,
  summarizeWithdrawals,
  withdrawalStatusBucket,
  withdrawalStatusLabel,
} from '../lib/withdrawals.js'
import './WithdrawalPanel.css'
import AdminSectionNav from '../components/AdminSectionNav.jsx'

export default function WithdrawalPanel() {
  const { db, loading: fbLoading, error: fbError } = useFirebaseDb()
  const {
    withdrawalRequests,
    overviewRows,
    ready,
    sessionLoaded,
    lastSync,
    streamProgress,
    updateTick,
    refreshUser,
    refreshUsersData,
    allUsersLoaded,
  } = useUsersData()
  const isStreaming = streamProgress?.streaming === true
  const requests = withdrawalRequests
  const liveReady = ready
  const [search, setSearch] = useState('')
  const [historyFilter, setHistoryFilter] = useState('all')
  const [busyKey, setBusyKey] = useState(null)
  const [msg, setMsg] = useState({ text: '', kind: 'neutral' })
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [updateAllBusy, setUpdateAllBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState(null)
  const [showAllAnalysisUsers, setShowAllAnalysisUsers] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return requests
    return requests.filter(
      (r) =>
        r.email.toLowerCase().includes(q) ||
        String(r.method || '').toLowerCase().includes(q) ||
        String(r.account || '').toLowerCase().includes(q) ||
        String(r.requestKey || '').toLowerCase().includes(q),
    )
  }, [requests, search])

  const walletTotals = useMemo(() => summarizeOverviewRows(overviewRows), [overviewRows])

  const usersTotal = streamProgress?.total || walletTotals.users
  const usersLoadedCount = isStreaming
    ? streamProgress?.loaded || overviewRows.length
    : walletTotals.users

  const stats = useMemo(() => summarizeWithdrawals(requests), [requests])

  const analysis = useMemo(
    () => computeWithdrawalAnalysis(overviewRows, withdrawalRequests),
    [overviewRows, withdrawalRequests],
  )

  const analysisUsers = showAllAnalysisUsers ? analysis.users : analysis.mismatches

  const loadAllAnalysis = useCallback(async () => {
    setAnalysisLoading(true)
    setMsg({ text: '⏳ सभी users + withdrawal requests load…', kind: 'neutral' })
    try {
      await refreshUsersData()
      setMsg({ text: '✅ सभी users load — analysis update ho gaya', kind: 'ok' })
    } catch (e) {
      setMsg({
        text: '❌ ' + (e instanceof Error ? e.message : String(e)),
        kind: 'err',
      })
    } finally {
      setAnalysisLoading(false)
    }
  }, [refreshUsersData])

  const updateAllWallets = useCallback(async () => {
    if (!db) return
    const count = analysis.users.length
    if (!count) {
      setMsg({ text: '⚠ Pehle Load + Analysis chalao — koi user nahi', kind: 'err' })
      return
    }

    const beforeActual = analysis.global.actualAvailable
    const setTarget = analysis.global.setTotalCurrent

    const ok = window.confirm(
      `${count} users — har email par:\n` +
        `currentBalance = Earn − totalWithdrawn (REPLACE)\n\n` +
        `Abhi Actual total: ${formatUsd(beforeActual)}\n` +
        `Update ke baad hoga: ${formatUsd(setTarget)}\n` +
        `(Plus nahi — purana number badal jayega)\n\nContinue?`,
    )
    if (!ok) return

    setUpdateAllBusy(true)
    setUpdateProgress({ done: 0, total: count })
    setMsg({ text: `⏳ ${count} users wallet SET…`, kind: 'neutral' })

    try {
      clearUsersDataCaches()
      const { updated } = await syncAllWalletBalancesFromAnalysis(
        db,
        analysis.users,
        (done, total) => setUpdateProgress({ done, total }),
      )
      clearUsersDataCaches()
      await refreshUsersData()
      const after = computeWithdrawalAnalysis(
        usersDataSession.overviewRows,
        usersDataSession.withdrawalRequests,
      )
      setMsg({
        text:
          `✅ ${updated} users SET · Actual ${formatUsd(beforeActual)} → ${formatUsd(after.global.actualAvailable)} · target ${formatUsd(setTarget)}`,
        kind: 'ok',
      })
    } catch (e) {
      console.error(e)
      setMsg({
        text: '❌ Update fail: ' + (e instanceof Error ? e.message : String(e)),
        kind: 'err',
      })
    } finally {
      setUpdateAllBusy(false)
      setUpdateProgress(null)
    }
  }, [db, analysis.users, refreshUsersData])

  const totalWalletUsd = walletTotals.walletBalance + walletTotals.walletPending

  const pendingRows = useMemo(
    () => filtered.filter((r) => withdrawalStatusBucket(r.status) === 'pending'),
    [filtered],
  )

  const historyRows = useMemo(() => {
    let list = filtered.filter((r) => withdrawalStatusBucket(r.status) !== 'pending')
    if (historyFilter === 'approved') {
      list = list.filter((r) => withdrawalStatusBucket(r.status) === 'approved')
    } else if (historyFilter === 'rejected') {
      list = list.filter((r) => withdrawalStatusBucket(r.status) === 'rejected')
    }
    return list
  }, [filtered, historyFilter])

  const processRequest = useCallback(
    async (row, action) => {
      if (!db || !row?.emailKey || !row?.requestKey) return
      if (withdrawalStatusBucket(row.status) !== 'pending') {
        setMsg({ text: '⚠ यह request पहले से process हो चुकी है।', kind: 'err' })
        return
      }

      const amount = safeNum(row.amount)
      if (amount <= 0) {
        setMsg({ text: '❌ Invalid amount', kind: 'err' })
        return
      }

      const opKey = `${row.emailKey}:${row.requestKey}`
      setBusyKey(opKey)
      setMsg({ text: action === 'approve' ? '⏳ Approving…' : '⏳ Rejecting…', kind: 'neutral' })

      try {
        const walletRef = ref(db, `users/${row.emailKey}/wallet`)
        const walletSnap = await get(walletRef)
        if (!walletSnap.exists()) throw new Error('Wallet not found')

        const wallet = walletSnap.val() || {}
        const pendingBal = safeNum(wallet.pendingBalance)
        if (pendingBal + 0.001 < amount) {
          throw new Error(
            `Pending balance ($${pendingBal.toFixed(2)}) request amount ($${amount.toFixed(2)}) se kam hai`,
          )
        }

        const reqRef = ref(db, `users/${row.emailKey}/wallet/withdrawalRequests/${row.requestKey}`)
        const now = Date.now()

        if (action === 'approve') {
          await update(walletRef, {
            pendingBalance: Math.max(0, toFixed2(pendingBal - amount)),
            totalWithdrawn: toFixed2(safeNum(wallet.totalWithdrawn) + amount),
          })
          await update(reqRef, {
            status: 'paid',
            processedAt: now,
          })
          setMsg({
            text: `✅ Approved — ${row.email} · ${formatUsd(amount)}`,
            kind: 'ok',
          })
        } else {
          await update(walletRef, {
            currentBalance: toFixed2(safeNum(wallet.currentBalance) + amount),
            pendingBalance: Math.max(0, toFixed2(pendingBal - amount)),
          })
          await update(reqRef, {
            status: 'rejected',
            processedAt: now,
          })
          setMsg({
            text: `✅ Rejected — ${row.email} · ${formatUsd(amount)} wallet me wapas`,
            kind: 'ok',
          })
        }
        await refreshUser(row.emailKey)
      } catch (e) {
        console.error(e)
        setMsg({
          text: '❌ ' + (e instanceof Error ? e.message : String(e)),
          kind: 'err',
        })
      } finally {
        setBusyKey(null)
      }
    },
    [db, refreshUser],
  )

  function statusBadgeClass(status) {
    return `wd-badge ${withdrawalStatusBucket(status)}`
  }

  function renderRow(row, showActions) {
    const opKey = `${row.emailKey}:${row.requestKey}`
    const busy = busyKey === opKey
    const bucket = withdrawalStatusBucket(row.status)

    return (
      <tr key={opKey}>
        <td>{formatWithdrawalDate(row.createdAt)}</td>
        <td className="email">{row.email}</td>
        <td>
          <strong>{formatUsd(row.amount)}</strong>
          <div style={{ fontSize: '10px', color: '#94a3b8' }}>{row.currency || 'USD'}</div>
        </td>
        <td>{row.method || '—'}</td>
        <td style={{ maxWidth: 280, wordBreak: 'break-word', fontSize: '11px', color: '#cbd5e1' }}>
          {formatAccountDetails(row)}
        </td>
        <td>
          <span className={statusBadgeClass(row.status)}>{withdrawalStatusLabel(row.status)}</span>
          {row.processedAt ? (
            <div style={{ fontSize: '10px', color: '#64748b', marginTop: 4 }}>
              {formatWithdrawalDate(row.processedAt)}
            </div>
          ) : null}
        </td>
        {showActions ? (
          <td>
            <div className="wd-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void processRequest(row, 'approve')}
              >
                {busy ? '…' : 'Approve'}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void processRequest(row, 'reject')}
              >
                Reject
              </button>
            </div>
          </td>
        ) : null}
      </tr>
    )
  }

  if (fbLoading) {
    return <div className="wd-root wd-loading">Firebase connecting…</div>
  }

  return (
    <div className="wd-root">
      <header className="wd-hero">
        <div className="wd-hero-top">
          <div>
            <h1>
              Withdrawal Panel
              {isStreaming ? (
                <span className="wd-live-pill streaming">⟳ {streamProgress.loaded}/{streamProgress.total}</span>
              ) : sessionLoaded ? (
                <span className="wd-live-pill">● Saved</span>
              ) : null}
            </h1>
            <p>
              एक बार load — session में save (बार-बार refresh नहीं)
              {lastSync
                ? ` · ${new Date(lastSync).toLocaleTimeString('en-IN')}`
                : ''}
              । Approve/reject के बाद सिर्फ उसी user update।
            </p>
          </div>
          <AdminSectionNav />
        </div>
      </header>

      <div className="wd-body">
        {fbError ? (
          <p className="wd-msg err">Firebase: {fbError}</p>
        ) : null}
        {msg.text ? (
          <p className={'wd-msg ' + (msg.kind === 'ok' ? 'ok' : msg.kind === 'err' ? 'err' : '')}>
            {msg.text}
          </p>
        ) : null}

        <div className="wd-dash-kpi">
          <div
            className={
              'wd-dash-kpi-card earnings' + (isStreaming ? ' wd-dash-kpi-card--loading' : '')
            }
          >
            <span>Total earnings ($) — सभी users (Dashboard जैसा)</span>
            <strong>
              {!ready && !overviewRows.length
                ? '…'
                : formatUsd(walletTotals.totalEarnings)}
            </strong>
            <small>
              {isStreaming ? (
                <>
                  ⟳ {formatInt(usersLoadedCount)} / {formatInt(usersTotal)} users load हो
                  रहे… · ab tak ${formatUsd(walletTotals.totalEarnings).slice(1)}
                </>
              ) : allUsersLoaded ? (
                <>
                  सभी {formatInt(walletTotals.users)} users का total ·{' '}
                  {formatInt(walletTotals.totalImpressions)} impressions
                </>
              ) : ready ? (
                `${formatInt(walletTotals.users)} users · ${formatInt(walletTotals.totalImpressions)} imps`
              ) : (
                'Firebase से सभी users load…'
              )}
            </small>
          </div>
        </div>

        <div className="wd-totals-head">
          <h2>सभी users — Wallet total ($)</h2>
          <span>
            {ready
              ? `${walletTotals.users} users · session total`
              : 'Loading…'}
          </span>
        </div>

        <div className="wd-wallet-stats">
          <div className="wd-stat balance">
            <div className="wd-stat-label">Balance ($) — withdraw ready</div>
            <div className="wd-stat-count">{formatUsd(walletTotals.walletBalance)}</div>
            <div className="wd-stat-amount">currentBalance सभी users</div>
          </div>
          <div className="wd-stat pending-bal">
            <div className="wd-stat-label">Pending Balance ($)</div>
            <div className="wd-stat-count">{formatUsd(walletTotals.walletPending)}</div>
            <div className="wd-stat-amount">request hold में</div>
          </div>
          <div className="wd-stat total-bal">
            <div className="wd-stat-label">Total Balance ($)</div>
            <div className="wd-stat-count">{formatUsd(totalWalletUsd)}</div>
            <div className="wd-stat-amount">Balance + Pending</div>
          </div>
          <div className="wd-stat withdrawn">
            <div className="wd-stat-label">Total Withdrawn ($)</div>
            <div className="wd-stat-count">{formatUsd(walletTotals.totalWithdrawn)}</div>
            <div className="wd-stat-amount">paid out अब तक</div>
          </div>
        </div>

        <div className="wd-totals-head wd-totals-head--sub">
          <h2>Withdrawal requests</h2>
          <span>Pending · Approved · Rejected</span>
        </div>

        <div className="wd-stats wd-stats--requests">
          <div className="wd-stat pending">
            <div className="wd-stat-label">Pending requests</div>
            <div className="wd-stat-count">{stats.pending.count}</div>
            <div className="wd-stat-amount">{formatUsd(stats.pending.amount)}</div>
          </div>
          <div className="wd-stat approved">
            <div className="wd-stat-label">Approved</div>
            <div className="wd-stat-count">{stats.approved.count}</div>
            <div className="wd-stat-amount">{formatUsd(stats.approved.amount)}</div>
          </div>
          <div className="wd-stat rejected">
            <div className="wd-stat-label">Rejected</div>
            <div className="wd-stat-count">{stats.rejected.count}</div>
            <div className="wd-stat-amount">{formatUsd(stats.rejected.amount)}</div>
          </div>
          <div className="wd-stat total">
            <div className="wd-stat-label">Total requests</div>
            <div className="wd-stat-count">{stats.total.count}</div>
            <div className="wd-stat-amount">{formatUsd(stats.total.amount)}</div>
          </div>
        </div>

        <section className="wd-analysis">
          <div className="wd-totals-head wd-analysis__head">
            <div>
              <h2>Balance Analysis</h2>
              <p className="wd-analysis__formula">
                Har user: Earn − Withdrawn → currentBalance · Total = $1318… (REPLACE)
              </p>
            </div>
            <div className="wd-analysis__actions">
              <button
                type="button"
                className="wd-analysis__load-btn"
                disabled={analysisLoading || isStreaming || updateAllBusy}
                onClick={() => void loadAllAnalysis()}
              >
                {analysisLoading ? '⏳ Load…' : 'सभी Load + Analysis'}
              </button>
              <button
                type="button"
                className="wd-analysis__update-btn"
                disabled={
                  updateAllBusy || analysisLoading || isStreaming || !analysis.users.length
                }
                title="Sabhi users: currentBalance = Dashboard Avail − Approved WD"
                onClick={() => void updateAllWallets()}
              >
                {updateAllBusy && updateProgress
                  ? `⏳ Update ${updateProgress.done}/${updateProgress.total}`
                  : 'सभी Update'}
              </button>
            </div>
          </div>

          <div className="wd-analysis__flow">
            <div className="wd-analysis__step">
              <span>Dashboard Total Earn ($)</span>
              <strong>{formatUsd(analysis.global.totalDashboardEarn)}</strong>
              <small>RTDB dashboard · sab users</small>
            </div>
            <span className="wd-analysis__op">−</span>
            <div className="wd-analysis__step warn">
              <span>totalWithdrawn ($)</span>
              <strong>{formatUsd(analysis.global.totalWalletWithdrawn)}</strong>
              <small>
                wallet paid · requests audit {formatUsd(analysis.global.totalApprovedFromRequests)}
              </small>
            </div>
            <span className="wd-analysis__op">=</span>
            <div className="wd-analysis__step ok">
              <span>currentBalance ($) — SET total</span>
              <strong>{formatUsd(analysis.global.setTotalCurrent)}</strong>
              <small>
                Earn − Withdrawn (sab users jod) = formula {formatUsd(analysis.global.formulaBalance)}
                {Math.abs(analysis.global.formulaVsSetDiff) <= 0.02
                  ? ' · match ✓'
                  : ` · Δ ${formatUsd(analysis.global.formulaVsSetDiff)}`}
              </small>
            </div>
            <span className="wd-analysis__op">≈</span>
            <div
              className={
                'wd-analysis__step ' + (analysis.global.matches ? 'ok' : 'err')
              }
            >
              <span>Actual Wallet Avail ($)</span>
              <strong>{formatUsd(analysis.global.actualAvailable)}</strong>
              <small>
                diff {formatUsd(analysis.global.diffAvailable)} (Actual − SET total)
                {analysis.global.matches ? ' · match ✓' : ' · mismatch'}
                {' · '}
                Update: Actual {formatUsd(analysis.global.actualAvailable)} →{' '}
                {formatUsd(analysis.global.setTotalCurrent)} (REPLACE)
              </small>
            </div>
          </div>

          <div className="wd-analysis__extra">
            <div>
              <span>Actual Total Bal ($)</span>
              <strong>{formatUsd(analysis.global.actualTotalBal)}</strong>
              <small>Available + Pending hold</small>
            </div>
            <div>
              <span>Unique requests</span>
              <strong>{formatInt(analysis.uniqueRequestCount)}</strong>
              <small>duplicate hata kar</small>
            </div>
            <div>
              <span>Mismatch users</span>
              <strong>{formatInt(analysis.global.mismatchCount)}</strong>
              <small>of {formatInt(analysis.global.users)}</small>
            </div>
            <div>
              <span>Withdrawn ≠ Approved</span>
              <strong>{formatInt(analysis.global.withdrawnMismatchCount)}</strong>
              <small>wallet vs request sum</small>
            </div>
          </div>

          <div className="wd-analysis__table-head">
            <h3>User-wise check</h3>
            <label className="wd-analysis__chk">
              <input
                type="checkbox"
                checked={showAllAnalysisUsers}
                onChange={(e) => setShowAllAnalysisUsers(e.target.checked)}
              />
              sabhi users dikhao
            </label>
          </div>

          <div className="wd-analysis__table-wrap">
            <table className="wd-analysis__table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Dash Earn ($)</th>
                  <th>Withdrawn ($)</th>
                  <th>Expected ($)</th>
                  <th>Pehle ($)</th>
                  <th>Update ±</th>
                  <th>Req audit</th>
                  <th>Diff</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {!ready || analysisLoading ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      {analysisLoading
                        ? '⏳ सभी users load…'
                        : '↑ सभी Load + Analysis दबाएँ'}
                    </td>
                  </tr>
                ) : !analysisUsers.length ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      {showAllAnalysisUsers
                        ? 'Koi user nahi'
                        : 'Sab users match — koi mismatch nahi'}
                    </td>
                  </tr>
                ) : (
                  analysisUsers.map((u) => (
                    <tr key={u.emailKey} className={u.matches ? '' : 'mismatch'}>
                      <td className="email">{u.email}</td>
                      <td>{formatUsd(u.dashboardEarn)}</td>
                      <td>{formatUsd(u.walletWithdrawn)}</td>
                      <td className="ok">{formatUsd(u.expectedAvailable)}</td>
                      <td>{formatUsd(u.walletAvailable)}</td>
                      <td
                        className={
                          u.updateDelta > 0.02 ? 'plus' : u.updateDelta < -0.02 ? 'minus' : ''
                        }
                      >
                        {u.updateDelta > 0.02 ? '+' : ''}
                        {formatUsd(u.updateDelta)}
                      </td>
                      <td style={{ fontSize: 10, color: '#94a3b8' }}>
                        Appr {formatUsd(u.approvedFromRequests)} · Pend{' '}
                        {formatUsd(u.pendingFromRequests)}
                      </td>
                      <td className={u.matches ? '' : 'warn'}>{formatUsd(u.diffAvailable)}</td>
                      <td>
                        <span className={'wd-analysis__badge ' + (u.matches ? 'ok' : 'warn')}>
                          {u.matches ? 'OK' : 'Check'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {ready && analysis.users.length > 0 && !analysisLoading ? (
                <tfoot>
                  <tr>
                    <td>
                      <strong>TOTAL</strong>
                    </td>
                    <td>
                      <strong>{formatUsd(analysis.global.totalDashboardEarn)}</strong>
                    </td>
                    <td>
                      <strong>{formatUsd(analysis.global.totalWalletWithdrawn)}</strong>
                    </td>
                    <td>
                      <strong>{formatUsd(analysis.global.setTotalCurrent)}</strong>
                    </td>
                    <td>
                      <strong>{formatUsd(analysis.global.actualAvailable)}</strong>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td>
                      <strong>{formatUsd(analysis.global.diffAvailable)}</strong>
                    </td>
                    <td>
                      <span
                        className={
                          'wd-analysis__badge ' + (analysis.global.matches ? 'ok' : 'warn')
                        }
                      >
                        {analysis.global.matches ? 'OK' : 'Check'}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </section>

        <div className="wd-toolbar">
          <input
            type="search"
            placeholder="Email / method / account search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search withdrawals"
          />
          <button type="button" className="secondary" onClick={() => setSearch('')}>
            Clear
          </button>
          <button
            type="button"
            className="secondary"
            disabled={isStreaming}
            onClick={() => void refreshUsersData()}
            title="Firebase से पूरा data दोबारा load"
          >
            ↻ Reload all
          </button>
          <span className="wd-sync-line" key={updateTick}>
            {isStreaming ? (
              <>⟳ Loading {streamProgress.loaded}/{streamProgress.total}</>
            ) : sessionLoaded ? (
              <>
                ● Session · {requests.length} requests
                {lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('en-IN')}` : ''}
              </>
            ) : (
              'Connecting…'
            )}
          </span>
        </div>

        <section className="wd-section">
          <div className="wd-section-head">
            <h2>Pending requests</h2>
            <span>
              {isStreaming && streamProgress
                ? `⟳ ${streamProgress.loaded}/${streamProgress.total} users scan…`
                : liveReady && sessionLoaded
                  ? `${pendingRows.length} waiting · ${requests.length} total reqs`
                  : 'Loading…'}
            </span>
          </div>
          <div className="wd-table-wrap">
            <table className="wd-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>User</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Account / Bank</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {isStreaming && pendingRows.length > 0 ? (
                  <tr className="wd-stream-row">
                    <td colSpan={7}>
                      ⟳ और requests load हो रही हैं ({streamProgress.loaded}/
                      {streamProgress.total} users) — नीचे जितनी मिली दिख रही हैं
                    </td>
                  </tr>
                ) : null}
                {!liveReady && !pendingRows.length ? (
                  <tr className="empty">
                    <td colSpan={7}>⏳ Loading withdrawal requests…</td>
                  </tr>
                ) : !pendingRows.length ? (
                  <tr className="empty">
                    <td colSpan={7}>
                      {isStreaming ? 'अभी तक कोई pending नहीं (scan चल रहा है)…' : 'कोई pending request नहीं है।'}
                    </td>
                  </tr>
                ) : (
                  pendingRows.map((row) => renderRow(row, true))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="wd-section">
          <div className="wd-section-head">
            <h2>History</h2>
            <span>Approved + Rejected — पुरानी सभी requests</span>
          </div>
          <div className="wd-toolbar" style={{ borderTop: 'none' }}>
            <div className="wd-filter-tabs" role="tablist" aria-label="History filter">
              {[
                ['all', 'All'],
                ['approved', 'Approved'],
                ['rejected', 'Rejected'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={historyFilter === id}
                  className={historyFilter === id ? 'active' : ''}
                  onClick={() => setHistoryFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="wd-table-wrap">
            <table className="wd-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>User</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Account / Bank</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {isStreaming && historyRows.length > 0 ? (
                  <tr className="wd-stream-row">
                    <td colSpan={6}>⟳ History भी load हो रही है…</td>
                  </tr>
                ) : null}
                {!liveReady && !historyRows.length ? (
                  <tr className="empty">
                    <td colSpan={6}>⏳ Loading history…</td>
                  </tr>
                ) : !historyRows.length ? (
                  <tr className="empty">
                    <td colSpan={6}>इस filter में कोई history नहीं।</td>
                  </tr>
                ) : (
                  historyRows.map((row) => renderRow(row, false))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
