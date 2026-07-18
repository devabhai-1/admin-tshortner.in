import { useCallback, useEffect, useState } from 'react'
import { ref, get, update, remove } from 'firebase/database'
import { useFirebaseDb } from '../context/FirebaseProvider.jsx'
import {
  decodeEmailKey,
  formatINR,
  isZeroAmount,
  sumEarningsBetweenForDailyObj,
} from '../lib/utils.js'
import './AdminPanel.css'

function toCsvValue(v) {
  const s = String(v ?? '')
  const escaped = s.replace(/"/g, '""')
  if (/[",\n]/.test(escaped)) return `"${escaped}"`
  return escaped
}

export default function AdminPanel() {
  const { db, loading: fbLoading, error: fbError } = useFirebaseDb()

  const [adminTab, setAdminTab] = useState('overview')

  const [userSearch, setUserSearch] = useState('')
  const [userSelect, setUserSelect] = useState('')
  const [userSelectMsg, setUserSelectMsg] = useState({ text: '', error: false })

  const [totalavailable, setTotalavailable] = useState('')
  const [totalEarnings, setTotalEarnings] = useState('')
  const [todayImpressions, setTodayImpressions] = useState('')
  const [totalImpressions, setTotalImpressions] = useState('')
  const [currentCPM, setCurrentCPM] = useState('')
  const [mainStatsMsg, setMainStatsMsg] = useState({ text: '', error: false })

  const [statDate, setStatDate] = useState(() => new Date().toISOString().split('T')[0])
  const [dailyImpressions, setDailyImpressions] = useState('')
  const [dailyEarnings, setDailyEarnings] = useState('')
  const [dailyCPM, setDailyCPM] = useState('')
  const [dailyMsg, setDailyMsg] = useState({ text: '', error: false })

  const [rangeStartDate, setRangeStartDate] = useState('')
  const [rangeEndDate, setRangeEndDate] = useState('')
  const [rangeMsg, setRangeMsg] = useState({ text: '', error: false })
  const [allUsersMsg, setAllUsersMsg] = useState({ text: '', error: false })
  const [rangeTotal, setRangeTotal] = useState('₹0')
  const [rangeDaysCount, setRangeDaysCount] = useState('0')

  const [savedUserTotals, setSavedUserTotals] = useState({})
  const [userCountMsg, setUserCountMsg] = useState({ text: '', error: false })

  const [selectedEmailKey, setSelectedEmailKey] = useState(null)
  const [currentDaily, setCurrentDaily] = useState({})
  const [allUsers, setAllUsers] = useState([])

  const loadUsersList = useCallback(async () => {
    if (!db) return
    try {
      setUserSelectMsg({ text: '⏳ Loading users...', error: false })
      const snapshot = await get(ref(db, 'users'))
      const users = snapshot.val() || {}
      const keys = Object.keys(users)
      setAllUsers(keys)
      if (!keys.length) {
        setUserSelectMsg({ text: '⚠ No users found in database', error: true })
        setUserSelect('')
        return
      }
      setUserSelectMsg({ text: `✅ ${keys.length} users ready`, error: false })
    } catch (e) {
      setUserSelectMsg({
        text: '❌ Error loading users: ' + (e instanceof Error ? e.message : String(e)),
        error: true,
      })
    }
  }, [db])

  useEffect(() => {
    void loadUsersList()
  }, [loadUsersList])

  const filteredUsers = userSearch.trim()
    ? allUsers.filter((k) => decodeEmailKey(k).toLowerCase().includes(userSearch.trim().toLowerCase()))
    : allUsers

  const resetStatsInputs = () => {
    setTotalavailable('')
    setTotalEarnings('')
    setTodayImpressions('')
    setTotalImpressions('')
    setCurrentCPM('')
    setStatDate(new Date().toISOString().split('T')[0])
    setDailyImpressions('')
    setDailyEarnings('')
    setDailyCPM('')
    setCurrentDaily({})
  }

  const loadUserData = async (emailKey) => {
    if (!db || !emailKey) return
    setSelectedEmailKey(emailKey)
    try {
      const snap = await get(ref(db, `users/${emailKey}/dashboard`))
      if (!snap.exists()) {
        setMainStatsMsg({ text: '⚠ No dashboard data found for user', error: true })
        resetStatsInputs()
        setCurrentDaily({})
        return
      }
      const data = snap.val()
      setTotalavailable(data.totalavailable ?? '')
      setTotalEarnings(data.totalEarnings ?? '')
      setTodayImpressions(data.todayImpressions ?? '')
      setTotalImpressions(data.totalImpressions ?? '')
      setCurrentCPM(data.currentCPM ?? '')
      setCurrentDaily(data.dailyStats || {})
      setMainStatsMsg({ text: '', error: false })
    } catch (e) {
      setMainStatsMsg({ text: e instanceof Error ? e.message : String(e), error: true })
    }
  }

  const handleUserChange = (emailKey) => {
    setUserSelect(emailKey)
    setMainStatsMsg({ text: '', error: false })
    setDailyMsg({ text: '', error: false })
    if (!emailKey) {
      setSelectedEmailKey(null)
      resetStatsInputs()
      return
    }
    void loadUserData(emailKey)
  }

  const copySelectedEmail = async () => {
    if (!selectedEmailKey) return
    try {
      await navigator.clipboard.writeText(decodeEmailKey(selectedEmailKey))
      setUserSelectMsg({ text: '✅ Email copied', error: false })
    } catch {
      setUserSelectMsg({ text: '❌ Clipboard unavailable', error: true })
    }
  }

  const exportDailyCsv = () => {
    if (!selectedEmailKey || !Object.keys(currentDaily).length) {
      setDailyMsg({ text: '⚠ No daily rows to export', error: true })
      return
    }
    const slug = decodeEmailKey(selectedEmailKey).replace(/[^\w@.-]+/g, '_')
    const iso = new Date().toISOString().replace(/[:.]/g, '-')
    let csv = 'Date,Impressions,Earnings_INR,CPM_INR\n'
    const dates = Object.keys(currentDaily).sort((a, b) => new Date(b) - new Date(a))
    for (const d of dates) {
      const x = currentDaily[d] || {}
      csv += `${d},${x.impressions ?? 0},${x.earnings ?? 0},${x.cpm ?? 0}\n`
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `daily-stats-${slug}-${iso}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setDailyMsg({ text: '✅ Daily CSV exported', error: false })
  }

  const renderDailyTableRows = () => {
    if (!Object.keys(currentDaily).length) {
      return (
        <tr>
          <td colSpan={4} className="adm-empty-cell">
            No daily stats — pick a user with dashboard data
          </td>
        </tr>
      )
    }
    return Object.keys(currentDaily)
      .sort((a, b) => new Date(b) - new Date(a))
      .map((date) => (
        <tr key={date}>
          <td>{date}</td>
          <td>{currentDaily[date].impressions ?? 0}</td>
          <td>{formatINR(currentDaily[date].earnings ?? 0)}</td>
          <td>{formatINR(currentDaily[date].cpm ?? 0)}</td>
        </tr>
      ))
  }

  const grandTotal = Object.keys(savedUserTotals).reduce(
    (s, email) => s + Number(savedUserTotals[email] || 0),
    0,
  )

  const savedEmailsSorted = Object.keys(savedUserTotals).sort(
    (a, b) => (savedUserTotals[b] ?? 0) - (savedUserTotals[a] ?? 0),
  )

  const dailyRowCount = Object.keys(currentDaily).length

  const handleUpdateMainStats = async () => {
    if (!db || !selectedEmailKey) {
      setMainStatsMsg({ text: 'Please select a user first', error: true })
      return
    }
    try {
      await update(ref(db, `users/${selectedEmailKey}/dashboard`), {
        totalavailable: Number(totalavailable) || 0,
        totalEarnings: Number(totalEarnings) || 0,
        todayImpressions: Number(todayImpressions) || 0,
        totalImpressions: Number(totalImpressions) || 0,
        currentCPM: Number(currentCPM) || 0,
      })
      setMainStatsMsg({ text: '✅ Main stats updated successfully', error: false })
    } catch (e) {
      setMainStatsMsg({ text: e instanceof Error ? e.message : String(e), error: true })
    }
  }

  const handleAddUpdateDaily = async () => {
    if (!db || !selectedEmailKey) {
      setDailyMsg({ text: 'Please select a user first', error: true })
      return
    }
    const date = statDate
    if (!date) {
      setDailyMsg({ text: 'Please select a date', error: true })
      return
    }
    const impressionsNum = Number(dailyImpressions)
    const earningsNum = Number(dailyEarnings)
    const cpmNum = Number(dailyCPM)
    if (isNaN(impressionsNum) || isNaN(earningsNum) || isNaN(cpmNum)) {
      setDailyMsg({ text: 'Please enter valid numbers for daily stats', error: true })
      return
    }
    try {
      const next = { ...currentDaily, [date]: { impressions: impressionsNum, earnings: earningsNum, cpm: cpmNum } }
      setCurrentDaily(next)
      await update(ref(db, `users/${selectedEmailKey}/dashboard/dailyStats/${date}`), {
        impressions: impressionsNum,
        earnings: earningsNum,
        cpm: cpmNum,
      })
      setDailyMsg({ text: '✅ Daily stat added/updated successfully', error: false })
    } catch (e) {
      setDailyMsg({ text: e instanceof Error ? e.message : String(e), error: true })
    }
  }

  const handleDeleteDaily = async () => {
    if (!db || !selectedEmailKey) {
      setDailyMsg({ text: 'Please select a user first', error: true })
      return
    }
    const date = statDate
    if (!date) {
      setDailyMsg({ text: 'Please select a date', error: true })
      return
    }
    try {
      await remove(ref(db, `users/${selectedEmailKey}/dashboard/dailyStats/${date}`))
      const next = { ...currentDaily }
      delete next[date]
      setCurrentDaily(next)
      setDailyMsg({ text: '✅ Daily stat deleted successfully', error: false })
    } catch (e) {
      setDailyMsg({ text: e instanceof Error ? e.message : String(e), error: true })
    }
  }

  const handleCalcRange = () => {
    if (!selectedEmailKey) {
      setRangeMsg({ text: 'Please select a user first', error: true })
      return
    }
    const s = rangeStartDate
    const e = rangeEndDate
    if (!s || !e) {
      setRangeMsg({ text: 'Please select both Start Date and End Date', error: true })
      return
    }
    const { total, days } = sumEarningsBetweenForDailyObj(currentDaily, s, e)
    setRangeTotal(formatINR(total))
    setRangeDaysCount(String(days))
    if (days === 0)
      setRangeMsg({ text: '⚠ No earnings found in this range (missing dates skipped)', error: true })
    else setRangeMsg({ text: `✅ Done! ${days} day(s) counted (missing dates skipped).`, error: false })

    if (isZeroAmount(total)) {
      setUserCountMsg({ text: '⚠ Total is 0, so user not saved', error: true })
      return
    }
    const email = decodeEmailKey(selectedEmailKey)
    setSavedUserTotals((prev) => ({ ...prev, [email]: Number(total.toFixed(2)) }))
    setUserCountMsg({ text: `✅ Saved: ${email} (${formatINR(total)})`, error: false })
  }

  const handleCalcAllUsers = async () => {
    const s = rangeStartDate
    const e = rangeEndDate
    if (!s || !e) {
      setAllUsersMsg({ text: 'Please select both Start Date and End Date first', error: true })
      return
    }
    if (!allUsers.length) {
      setAllUsersMsg({ text: '⚠ No users loaded to count', error: true })
      return
    }
    if (!db) return

    let done = 0
    let failed = 0
    let saved = 0
    let skippedZero = 0
    const nextTotals = { ...savedUserTotals }

    setAllUsersMsg({ text: `⏳ Counting ${allUsers.length} users...`, error: false })

    for (const emailKey of allUsers) {
      try {
        const snap = await get(ref(db, `users/${emailKey}/dashboard/dailyStats`))
        const dailyObj = snap.val() || {}
        const { total } = sumEarningsBetweenForDailyObj(dailyObj, s, e)
        if (isZeroAmount(total)) skippedZero++
        else {
          const email = decodeEmailKey(emailKey)
          nextTotals[email] = Number(total.toFixed(2))
          saved++
        }
        done++
        if (done % 10 === 0 || done === allUsers.length) {
          setAllUsersMsg({ text: `⏳ Progress: ${done}/${allUsers.length} users...`, error: false })
        }
      } catch {
        failed++
      }
    }

    setSavedUserTotals(nextTotals)
    const msg = `✅ Done! Total: ${done}, Saved: ${saved}, Skipped(0): ${skippedZero}, Failed: ${failed}`
    setAllUsersMsg({ text: msg, error: failed > 0 })
    setUserCountMsg({ text: '✅ Saved/Updated users (0 totals skipped)', error: false })
  }

  const exportCsv = () => {
    const emails = Object.keys(savedUserTotals)
    if (!emails.length) {
      setUserCountMsg({ text: '⚠ No users saved to export', error: true })
      return
    }
    emails.sort((a, b) => (savedUserTotals[b] ?? 0) - (savedUserTotals[a] ?? 0))
    const start = rangeStartDate || ''
    const end = rangeEndDate || ''
    const iso = new Date().toISOString().replace(/[:.]/g, '-')
    let csv = ''
    csv += `Range Start,${toCsvValue(start)}\n`
    csv += `Range End,${toCsvValue(end)}\n\n`
    csv += 'Email,Total\n'
    let grand = 0
    for (const email of emails) {
      const total = Number(savedUserTotals[email] || 0)
      grand += total
      csv += `${toCsvValue(email)},${toCsvValue(total.toFixed(2))}\n`
    }
    csv += `\nUsers Count,${emails.length}\n`
    csv += `Grand Total,${grand.toFixed(2)}\n`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `user-earnings-${iso}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setUserCountMsg({ text: '✅ CSV exported successfully', error: false })
  }

  const resetSavedList = () => {
    setSavedUserTotals({})
    setUserCountMsg({ text: '✅ User Count list reset successfully', error: false })
  }

  const selectedEmailLabel = selectedEmailKey ? decodeEmailKey(selectedEmailKey) : ''

  return (
    <div className="adm-root">
      <header className="adm-top">
        <div>
          <p className="adm-eyebrow">Firebase RTDB · Dashboard editor</p>
          <h1 className="adm-title">Admin Command Center</h1>
          <p className="adm-sub">
            User-level totals, per-day stats, range earnings calculator — एक ही जगह।
          </p>
        </div>
        <div className="adm-top-meta">
          <span className="adm-chip">
            Users <strong>{allUsers.length}</strong>
          </span>
          <span className="adm-chip muted">
            Daily rows <strong>{dailyRowCount}</strong>
          </span>
          <button type="button" className="adm-btn-icon" disabled={fbLoading} onClick={() => void loadUsersList()}>
            ⟳ Refresh list
          </button>
        </div>
      </header>

      {fbError && <p className="adm-banner err">Firebase: {fbError}</p>}
      {fbLoading && <p className="adm-banner">Connecting to Firebase…</p>}

      <nav className="adm-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={adminTab === 'overview'}
          className={adminTab === 'overview' ? 'active' : ''}
          onClick={() => setAdminTab('overview')}
        >
          Overview &amp; totals
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={adminTab === 'daily'}
          className={adminTab === 'daily' ? 'active' : ''}
          onClick={() => setAdminTab('daily')}
        >
          Daily stats
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={adminTab === 'insights'}
          className={adminTab === 'insights' ? 'active' : ''}
          onClick={() => setAdminTab('insights')}
        >
          Range &amp; exports
        </button>
      </nav>

      <div className="adm-user-bar">
        <div className="adm-user-fields">
          <label htmlFor="userSearch">Search</label>
          <input
            type="search"
            id="userSearch"
            placeholder="Filter by email…"
            autoComplete="off"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
          />
        </div>
        <div className="adm-user-fields grow">
          <label htmlFor="userSelect">Active user</label>
          <select
            id="userSelect"
            aria-label="Select user"
            value={userSelect}
            onChange={(e) => handleUserChange(e.target.value)}
          >
            <option value="">— Select user —</option>
            {filteredUsers.map((k) => (
              <option key={k} value={k}>
                {decodeEmailKey(k)}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="adm-btn-secondary" disabled={!selectedEmailKey} onClick={() => void copySelectedEmail()}>
          Copy email
        </button>
        <div className={'adm-inline-msg' + (userSelectMsg.error ? ' err' : '')}>{userSelectMsg.text}</div>
      </div>

      {selectedEmailKey && (
        <div className="adm-kpi-strip">
          <div className="adm-kpi">
            <span>Total available</span>
            <strong>₹{Number(totalavailable) || 0}</strong>
          </div>
          <div className="adm-kpi">
            <span>Total earnings</span>
            <strong>₹{Number(totalEarnings) || 0}</strong>
          </div>
          <div className="adm-kpi">
            <span>Today imps</span>
            <strong>{Number(todayImpressions) || 0}</strong>
          </div>
          <div className="adm-kpi">
            <span>Total imps</span>
            <strong>{Number(totalImpressions) || 0}</strong>
          </div>
          <div className="adm-kpi accent">
            <span>CPM</span>
            <strong>₹{Number(currentCPM) || 0}</strong>
          </div>
        </div>
      )}

      {adminTab === 'overview' && (
        <section className="adm-panel">
          <h2 className="adm-section-title">Aggregate totals</h2>
          <p className="adm-hint">
            Selected: <code>{selectedEmailLabel || '—'}</code> — यहाँ से मुख्य डैशबोर्ड फील्ड अपडेट होती हैं।
          </p>
          <div className="adm-form-grid">
            <div className="adm-field">
              <label htmlFor="totalavailable">Total Available</label>
              <input
                type="number"
                id="totalavailable"
                step="0.01"
                value={totalavailable}
                onChange={(e) => setTotalavailable(e.target.value)}
              />
            </div>
            <div className="adm-field">
              <label htmlFor="totalEarnings">Total Earnings</label>
              <input type="number" id="totalEarnings" step="0.01" value={totalEarnings} onChange={(e) => setTotalEarnings(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="todayImpressions">Today&apos;s Impressions</label>
              <input type="number" id="todayImpressions" value={todayImpressions} onChange={(e) => setTodayImpressions(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="totalImpressions">Total Impressions</label>
              <input type="number" id="totalImpressions" value={totalImpressions} onChange={(e) => setTotalImpressions(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="currentCPM">Current CPM</label>
              <input type="number" id="currentCPM" step="0.01" value={currentCPM} onChange={(e) => setCurrentCPM(e.target.value)} />
            </div>
          </div>
          <div className="adm-actions">
            <button type="button" className="adm-btn-primary" onClick={() => void handleUpdateMainStats()}>
              Save main stats
            </button>
          </div>
          <div className={'adm-msg' + (mainStatsMsg.error ? ' err' : '')}>{mainStatsMsg.text}</div>
        </section>
      )}

      {adminTab === 'daily' && (
        <section className="adm-panel">
          <h2 className="adm-section-title">Per-day editor</h2>
          <div className="adm-form-grid">
            <div className="adm-field">
              <label htmlFor="statDate">Date</label>
              <input type="date" id="statDate" value={statDate} onChange={(e) => setStatDate(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="dailyImpressions">Impressions</label>
              <input type="number" id="dailyImpressions" value={dailyImpressions} onChange={(e) => setDailyImpressions(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="dailyEarnings">Earnings</label>
              <input type="number" id="dailyEarnings" step="0.01" value={dailyEarnings} onChange={(e) => setDailyEarnings(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="dailyCPM">CPM</label>
              <input type="number" id="dailyCPM" step="0.01" value={dailyCPM} onChange={(e) => setDailyCPM(e.target.value)} />
            </div>
          </div>
          <div className="adm-actions">
            <button type="button" className="adm-btn-primary" onClick={() => void handleAddUpdateDaily()}>
              Save daily row
            </button>
            <button type="button" className="adm-btn-danger" onClick={() => void handleDeleteDaily()}>
              Delete this date
            </button>
            <button type="button" className="adm-btn-secondary" onClick={exportDailyCsv} disabled={!dailyRowCount}>
              Export daily CSV
            </button>
          </div>
          <div className={'adm-msg' + (dailyMsg.error ? ' err' : '')}>{dailyMsg.text}</div>

          <h3 className="adm-table-title">History</h3>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Impressions</th>
                  <th>Earnings</th>
                  <th>CPM</th>
                </tr>
              </thead>
              <tbody>{renderDailyTableRows()}</tbody>
            </table>
          </div>
        </section>
      )}

      {adminTab === 'insights' && (
        <section className="adm-panel">
          <h2 className="adm-section-title">Range calculator</h2>
          <div className="adm-form-grid two">
            <div className="adm-field">
              <label htmlFor="rangeStartDate">Start</label>
              <input type="date" id="rangeStartDate" value={rangeStartDate} onChange={(e) => setRangeStartDate(e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor="rangeEndDate">End</label>
              <input type="date" id="rangeEndDate" value={rangeEndDate} onChange={(e) => setRangeEndDate(e.target.value)} />
            </div>
          </div>
          <div className="adm-actions">
            <button type="button" className="adm-btn-primary" onClick={handleCalcRange}>
              Count (selected user)
            </button>
            <button type="button" className="adm-btn-secondary" onClick={() => void handleCalcAllUsers()}>
              Count all users
            </button>
          </div>
          <div className={'adm-msg' + (rangeMsg.error ? ' err' : '')}>{rangeMsg.text}</div>
          <div className={'adm-msg' + (allUsersMsg.error ? ' err' : '')}>{allUsersMsg.text}</div>

          <div className="adm-range-result">
            <div>
              Range total: <strong>{rangeTotal}</strong>
            </div>
            <div>
              Days counted: <strong>{rangeDaysCount}</strong>
            </div>
          </div>

          <div className="adm-saved-block">
            <div className="adm-saved-head">
              <h3>Saved totals (session)</h3>
              <div className="adm-actions tight">
                <button type="button" className="adm-btn-secondary small" onClick={exportCsv}>
                  Export saved CSV
                </button>
                <button type="button" className="adm-btn-danger small" onClick={resetSavedList}>
                  Reset list
                </button>
              </div>
            </div>
            <div className={'adm-msg' + (userCountMsg.error ? ' err' : '')}>{userCountMsg.text}</div>
            <div className="adm-saved-list">
              {!savedEmailsSorted.length ? (
                <div className="adm-empty">Run “Count” to populate saved earnings per email.</div>
              ) : (
                savedEmailsSorted.map((email) => (
                  <div key={email} className="adm-saved-row">
                    <span className="adm-saved-email">{email}</span>
                    <span className="adm-saved-amt">{formatINR(savedUserTotals[email])}</span>
                  </div>
                ))
              )}
            </div>
            <div className="adm-grand">
              <span>Saved users: {savedEmailsSorted.length}</span>
              <span>Grand total: {formatINR(grandTotal)}</span>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
