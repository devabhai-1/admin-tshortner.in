import { useCallback, useEffect, useMemo, useState } from 'react'
import { ref, get, update, remove, onValue } from 'firebase/database'
import { useFirebaseDb } from '../context/FirebaseProvider.jsx'
import {
  computeSummaryFromDaily,
  decodeEmailKey,
  encodeEmailKey,
  safeNum,
  toFixed2,
} from '../lib/utils.js'
import {
  dashboardSummary,
  hasMeaningfulDashboardData,
  isSafeToRemoveDashboard,
} from '../lib/dashboardActivity.js'
import './ProfessionalDashboard.css'

/** Total Earnings इस राशि से कम वाले dashboards बल्क डिलीट (exclusive: ₹10 रहेगा) */
const MIN_EARNINGS_DELETE_RUPEES = 10

function buildSortedUserRows(users) {
  const u = users || {}
  const list = Object.keys(u).map((key) => ({
    key,
    email: decodeEmailKey(key),
    dashboard: u[key]?.dashboard || null,
  }))
  list.sort((a, b) => {
    const eb = dashboardSummary(b.dashboard).totalEarnings
    const ea = dashboardSummary(a.dashboard).totalEarnings
    return eb - ea
  })
  return list
}

export default function ProfessionalDashboard() {
  const { db, loading: fbLoading, error: fbErr } = useFirebaseDb()

  const [rows, setRows] = useState([])
  const [listMsg, setListMsg] = useState({ text: '', kind: 'neutral' })
  const [search, setSearch] = useState('')
  const [hideZeroRows, setHideZeroRows] = useState(false)
  /** Sirf 0 impression / 0 earning (खाली dashboard) वाले — बटन से ऑटो ऑन होता है */
  const [onlyZeroDashboards, setOnlyZeroDashboards] = useState(false)

  const [selectedEmail, setSelectedEmail] = useState(null)
  const [fbDate, setFbDate] = useState(() => new Date().toISOString().split('T')[0])
  const [fbImpressions, setFbImpressions] = useState('')
  const [fbEarnings, setFbEarnings] = useState('')
  const [fbCPM, setFbCPM] = useState('')
  const [currentDailyStats, setCurrentDailyStats] = useState({})
  const [fbExistingMsg, setFbExistingMsg] = useState({ text: '', kind: 'neutral' })
  const [fbMsg, setFbMsg] = useState({ text: '', kind: 'neutral' })
  const [pruneMsg, setPruneMsg] = useState({ text: '', kind: 'neutral' })
  const [pruning, setPruning] = useState(false)
  /** लाइव प्रगति: कितने हटे, अभी किस बैच पर, हाल के ईमेल */
  const [pruneLive, setPruneLive] = useState(null)
  /** 'zero' = खाली zero user पूरा हटाना · 'below10' = ₹10 से कम earnings वाला पूरा user */
  const [pruneKind, setPruneKind] = useState(null)
  const [seeding, setSeeding] = useState(false)
  /** आंशिक सीड फेल होने पर सफल keys — इन्हें एक बार में dashboard remove से वापस लिया जा सकता है */
  const [seedUndoKeys, setSeedUndoKeys] = useState(null)

  const refreshUsers = useCallback(async () => {
    if (!db) return
    try {
      setListMsg({ text: 'Syncing…', kind: 'neutral' })
      const snap = await get(ref(db, 'users'))
      const users = snap.val() || {}
      const list = buildSortedUserRows(users)
      setRows(list)
      setListMsg({ text: `✅ Synced · ${list.length} users`, kind: 'ok' })
    } catch (e) {
      setListMsg({
        text: '❌ ' + (e instanceof Error ? e.message : String(e)),
        kind: 'err',
      })
    }
  }, [db])

  useEffect(() => {
    if (!db) return
    const usersRef = ref(db, 'users')
    const unsub = onValue(
      usersRef,
      (snap) => {
        const users = snap.val() || {}
        setRows(buildSortedUserRows(users))
        setListMsg({ text: `✅ Live · ${Object.keys(users).length} users`, kind: 'ok' })
      },
      (err) => {
        setListMsg({
          text: '❌ ' + (err instanceof Error ? err.message : String(err)),
          kind: 'err',
        })
      },
    )
    return unsub
  }, [db])

  const visibleRows = useMemo(() => {
    let out = rows
    const q = search.trim().toLowerCase()
    if (q) out = out.filter((r) => r.email.toLowerCase().includes(q))
    if (hideZeroRows) out = out.filter((r) => hasMeaningfulDashboardData(r.dashboard))
    if (onlyZeroDashboards) out = out.filter((r) => !hasMeaningfulDashboardData(r.dashboard))
    return out
  }, [rows, search, hideZeroRows, onlyZeroDashboards])

  const kpiTotals = useMemo(() => {
    let ti = 0,
      te = 0,
      tt = 0,
      ta = 0
    let cpmNum = 0,
      cpmW = 0
    for (const r of visibleRows) {
      const s = dashboardSummary(r.dashboard)
      ti += s.totalImpressions
      te += s.totalEarnings
      tt += s.todayImpressions
      ta += s.totalAvailable
      if (s.totalImpressions > 0 && s.totalEarnings > 0) {
        cpmNum += s.currentCPM * s.totalImpressions
        cpmW += s.totalImpressions
      }
    }
    const avgCpm = cpmW > 0 ? cpmNum / cpmW : 0
    return {
      totalImpressions: ti,
      totalEarnings: te,
      todayImpressions: tt,
      totalAvailable: ta,
      currentCPM: avgCpm,
    }
  }, [visibleRows])

  /** कोई भी रियल डेटा नहीं = dashboard नहीं या सब 0 (Active ~70, बाकी Zero) */
  const zeroCount = useMemo(
    () => rows.filter((r) => !hasMeaningfulDashboardData(r.dashboard)).length,
    [rows],
  )

  /** सिर्फ जिनके पास RTDB में dashboard ऑब्जेक्ट है और खाली है — इन्हीं को हटाया जा सकता है */
  const prunableZeroCount = useMemo(
    () => rows.filter((r) => isSafeToRemoveDashboard(r.dashboard)).length,
    [rows],
  )

  /** Total Earnings < ₹10 और dashboard नोड मौजूद */
  const belowTenDashboardCount = useMemo(
    () =>
      rows.filter((r) => {
        const d = r.dashboard
        if (!d || typeof d !== 'object') return false
        return dashboardSummary(d).totalEarnings < MIN_EARNINGS_DELETE_RUPEES
      }).length,
    [rows],
  )

  const activeCount = useMemo(
    () => rows.filter((r) => hasMeaningfulDashboardData(r.dashboard)).length,
    [rows],
  )

  const loadUserDashboard = useCallback(
    async (email) => {
      if (!db || !email) {
        setCurrentDailyStats({})
        return {}
      }
      try {
        const k = encodeEmailKey(email)
        const snap = await get(ref(db, `users/${k}/dashboard`))
        if (!snap.exists()) {
          setCurrentDailyStats({})
          return {}
        }
        const data = snap.val() || {}
        const daily = data.dailyStats || {}
        setCurrentDailyStats(daily)
        return daily
      } catch (e) {
        console.error(e)
        setCurrentDailyStats({})
        return {}
      }
    },
    [db],
  )

  const selectUser = useCallback(
    async (email) => {
      setFbExistingMsg({ text: '', kind: 'neutral' })
      setFbMsg({ text: '', kind: 'neutral' })
      if (!email) {
        setSelectedEmail(null)
        setCurrentDailyStats({})
        return
      }
      setSelectedEmail(email)
      const dailyData = await loadUserDashboard(email)
      const todayIso = new Date().toISOString().split('T')[0]
      const dateKey = fbDate || todayIso
      const forDay = dailyData[dateKey]
      if (forDay) {
        setFbImpressions(String(forDay.impressions ?? ''))
        setFbEarnings(String(forDay.earnings ?? ''))
        setFbCPM(String(forDay.cpm ?? ''))
        setFbExistingMsg({
          text: `Existing: imps=${safeNum(forDay.impressions)}, earnings=₹${toFixed2(forDay.earnings)}, cpm=₹${toFixed2(forDay.cpm)}`,
          kind: 'ok',
        })
      } else {
        setFbImpressions('')
        setFbEarnings('')
        setFbCPM('')
        setFbExistingMsg({
          text: 'इस date पर कोई daily stat नहीं — नई एंट्री सेव कर सकते हो।',
          kind: 'neutral',
        })
      }
    },
    [loadUserDashboard, fbDate],
  )

  const loadDailyFromFirebase = useCallback(
    async (dateOverride) => {
      if (!selectedEmail) {
        setFbExistingMsg({ text: 'No email selected.', kind: 'neutral' })
        return
      }
      const date = dateOverride ?? fbDate
      if (!date) {
        setFbExistingMsg({ text: 'Select a date.', kind: 'neutral' })
        return
      }
      const local = currentDailyStats[date]
      if (local) {
        setFbImpressions(String(local.impressions ?? ''))
        setFbEarnings(String(local.earnings ?? ''))
        setFbCPM(String(local.cpm ?? ''))
        setFbExistingMsg({
          text: `Existing: imps=${safeNum(local.impressions)}, earnings=₹${toFixed2(local.earnings)}, cpm=₹${toFixed2(local.cpm)}`,
          kind: 'ok',
        })
        return
      }
      if (!db) return
      try {
        const k = encodeEmailKey(selectedEmail)
        const snap = await get(ref(db, `users/${k}/dashboard/dailyStats/${date}`))
        if (!snap.exists()) {
          setFbExistingMsg({ text: 'No daily stat for this date.', kind: 'neutral' })
          return
        }
        const d = snap.val() || {}
        setCurrentDailyStats((prev) => ({ ...prev, [date]: d }))
        setFbImpressions(String(d.impressions ?? ''))
        setFbEarnings(String(d.earnings ?? ''))
        setFbCPM(String(d.cpm ?? ''))
        setFbExistingMsg({
          text: `Existing: imps=${safeNum(d.impressions)}, earnings=₹${toFixed2(d.earnings)}, cpm=₹${toFixed2(d.cpm)}`,
          kind: 'ok',
        })
      } catch (e) {
        setFbExistingMsg({
          text: 'Error: ' + (e instanceof Error ? e.message : String(e)),
          kind: 'err',
        })
      }
    },
    [db, selectedEmail, fbDate, currentDailyStats],
  )

  const saveDailyToFirebase = async () => {
    if (!db) return setFbMsg({ text: 'Firebase not ready', kind: 'err' })
    if (!selectedEmail) return setFbMsg({ text: 'Select a user from the table.', kind: 'err' })
    const date = fbDate
    if (!date) return setFbMsg({ text: 'Pick a date.', kind: 'err' })
    let imps = safeNum(fbImpressions)
    let earn = toFixed2(fbEarnings)
    let cpm = safeNum(fbCPM)
    if (!cpm && imps > 0 && earn > 0) {
      cpm = toFixed2((earn / imps) * 1000)
      setFbCPM(String(cpm))
    }
    try {
      setFbMsg({ text: 'Saving…', kind: 'neutral' })
      const nextDaily = { ...currentDailyStats, [date]: { impressions: imps, earnings: earn, cpm } }
      const sum = computeSummaryFromDaily(nextDaily)
      setCurrentDailyStats(nextDaily)
      const k = encodeEmailKey(selectedEmail)
      await update(ref(db, `users/${k}/dashboard`), {
        totalavailable: sum.totalAvailable,
        totalEarnings: sum.totalEarnings,
        todayImpressions: sum.todayImpressions,
        totalImpressions: sum.totalImpressions,
        currentCPM: sum.currentCPM,
        dailyStats: nextDaily,
      })
      setFbMsg({ text: '✅ Saved.', kind: 'ok' })
    } catch (e) {
      setFbMsg({ text: '❌ ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    }
  }

  const deleteDailyFromFirebase = async () => {
    if (!db || !selectedEmail) return setFbMsg({ text: 'Select user.', kind: 'err' })
    const date = fbDate
    if (!date) return setFbMsg({ text: 'Pick a date.', kind: 'err' })
    try {
      setFbMsg({ text: 'Deleting…', kind: 'neutral' })
      const k = encodeEmailKey(selectedEmail)
      await remove(ref(db, `users/${k}/dashboard/dailyStats/${date}`))
      const nextDaily = { ...currentDailyStats }
      delete nextDaily[date]
      const sum = computeSummaryFromDaily(nextDaily)
      setCurrentDailyStats(nextDaily)
      await update(ref(db, `users/${k}/dashboard`), {
        totalavailable: sum.totalAvailable,
        totalEarnings: sum.totalEarnings,
        todayImpressions: sum.todayImpressions,
        totalImpressions: sum.totalImpressions,
        currentCPM: sum.currentCPM,
      })
      setFbMsg({ text: '✅ Deleted.', kind: 'ok' })
    } catch (e) {
      setFbMsg({ text: '❌ ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    }
  }

  const handlePruneEmptyDashboards = async () => {
    if (!db) return
    const allZeroNoData = rows.filter((r) => !hasMeaningfulDashboardData(r.dashboard))
    const targets = rows.filter((r) => isSafeToRemoveDashboard(r.dashboard))
    if (!targets.length) {
      if (allZeroNoData.length > 0) {
        setPruneMsg({
          text:
            `${allZeroNoData.length} Zero users दिख रहे हैं, लेकिन किसी के पास Firebase में dashboard नोड नहीं है ` +
            `(पहले से खाली) — हटाने को कुछ नहीं। इसलिए संख्या नहीं घटती।`,
          kind: 'neutral',
        })
      } else {
        setPruneMsg({ text: 'कोई हटाने योग्य खाली dashboard नहीं।', kind: 'neutral' })
      }
      return
    }
    const noNode = allZeroNoData.length - targets.length
    const ok = window.confirm(
      `${targets.length} users — पूरा Firebase user हटेगा (email key): dashboard, shortner, telegram सब।\n\n` +
        (noNode > 0
          ? `नोट: ${noNode} Zero users बिना dashboard नोड — यहाँ गिने नहीं।\n\n`
          : '') +
        `जिनमें impressions/earnings > 0 है वो इस सूची में नहीं आते। वापसी नहीं।`,
    )
    if (!ok) return
    const work = targets
    const total = work.length
    const CHUNK = 20
    try {
      setPruning(true)
      setPruneKind('zero')
      setPruneLive({ removed: 0, total, batchEmails: [], recent: [] })
      setPruneMsg({
        text: `${total} पूरे user (email) हटा रहे हैं…`,
        kind: 'neutral',
      })
      let removed = 0
      const recent = []
      for (let i = 0; i < work.length; i += CHUNK) {
        const slice = work.slice(i, i + CHUNK)
        const batchEmails = slice.map((r) => r.email)
        setPruneLive({
          removed,
          total,
          batchEmails,
          recent: recent.slice(-18),
        })
        const results = await Promise.allSettled(
          slice.map((r) => remove(ref(db, `users/${r.key}`))),
        )
        for (let j = 0; j < results.length; j++) {
          const rj = results[j]
          if (rj.status === 'rejected') {
            const r = slice[j]
            const msg = rj.reason instanceof Error ? rj.reason.message : String(rj.reason)
            setPruneMsg({
              text: `❌ ${removed} user हट चुके, फिर (${r.email}): ${msg} · बाकी नहीं छुए।`,
              kind: 'err',
            })
            setPruneLive((prev) =>
              prev
                ? { ...prev, removed, total, batchEmails: [r.email], recent: recent.slice(-18) }
                : prev,
            )
            return
          }
          removed++
          recent.push(slice[j].email)
          if (recent.length > 40) recent.splice(0, recent.length - 25)
        }
        setPruneLive({ removed, total, batchEmails, recent: recent.slice(-18) })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      setPruneMsg({
        text: `✅ ${removed} पूरे user (email) RTDB से हट गए। लिस्ट Live से अपडेट होगी।`,
        kind: 'ok',
      })
      if (selectedEmail && targets.some((t) => t.email === selectedEmail)) {
        setSelectedEmail(null)
        setCurrentDailyStats({})
      }
      setOnlyZeroDashboards(false)
    } catch (e) {
      setPruneMsg({ text: '❌ ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    } finally {
      setPruning(false)
      window.setTimeout(() => {
        setPruneLive(null)
        setPruneKind(null)
      }, 4000)
    }
  }

  /** Total Earnings < ₹10 — पूरा user (email) नोड हटाएँ */
  const handleDeleteBelowTenRupees = async () => {
    if (!db) return
    const targets = rows.filter((r) => {
      const d = r.dashboard
      if (!d || typeof d !== 'object') return false
      return dashboardSummary(d).totalEarnings < MIN_EARNINGS_DELETE_RUPEES
    })
    if (!targets.length) {
      setPruneMsg({
        text: `कोई user नहीं जिसके Total Earnings ₹${MIN_EARNINGS_DELETE_RUPEES} से कम हों और dashboard नोड हो।`,
        kind: 'neutral',
      })
      return
    }
    const ok = window.confirm(
      `${targets.length} users — Total Earnings ₹${MIN_EARNINGS_DELETE_RUPEES} से कम।\n\n` +
        `पूरा user हटेगा: dashboard + shortner + सब कुछ (वापस नहीं)। ₹${MIN_EARNINGS_DELETE_RUPEES}+ वाले नहीं छुए जाएंगे।\n\n` +
        'जारी रखें?',
    )
    if (!ok) return
    const work = targets
    const total = work.length
    const CHUNK = 20
    try {
      setPruning(true)
      setPruneKind('below10')
      setPruneLive({ removed: 0, total, batchEmails: [], recent: [] })
      setPruneMsg({
        text: `₹${MIN_EARNINGS_DELETE_RUPEES} से कम वाले ${total} पूरे user हटा रहे हैं…`,
        kind: 'neutral',
      })
      let removed = 0
      const recent = []
      for (let i = 0; i < work.length; i += CHUNK) {
        const slice = work.slice(i, i + CHUNK)
        const batchEmails = slice.map((r) => r.email)
        setPruneLive({
          removed,
          total,
          batchEmails,
          recent: recent.slice(-18),
        })
        const results = await Promise.allSettled(
          slice.map((r) => remove(ref(db, `users/${r.key}`))),
        )
        for (let j = 0; j < results.length; j++) {
          const rj = results[j]
          if (rj.status === 'rejected') {
            const r = slice[j]
            const msg = rj.reason instanceof Error ? rj.reason.message : String(rj.reason)
            setPruneMsg({
              text: `❌ ${removed} user हट चुके, फिर (${r.email}): ${msg}`,
              kind: 'err',
            })
            setPruneLive((prev) =>
              prev
                ? { ...prev, removed, total, batchEmails: [r.email], recent: recent.slice(-18) }
                : prev,
            )
            return
          }
          removed++
          recent.push(slice[j].email)
          if (recent.length > 40) recent.splice(0, recent.length - 25)
        }
        setPruneLive({ removed, total, batchEmails, recent: recent.slice(-18) })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      setPruneMsg({
        text: `✅ ₹${MIN_EARNINGS_DELETE_RUPEES} से कम वाले ${removed} पूरे user हट गए।`,
        kind: 'ok',
      })
      if (selectedEmail && targets.some((t) => t.email === selectedEmail)) {
        setSelectedEmail(null)
        setCurrentDailyStats({})
      }
      setOnlyZeroDashboards(false)
    } catch (e) {
      setPruneMsg({ text: '❌ ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    } finally {
      setPruning(false)
      window.setTimeout(() => {
        setPruneLive(null)
        setPruneKind(null)
      }, 4000)
    }
  }

  /** टेबल में सिर्फ डिलीट-योग्य खाली dashboards दिखें, फिर कन्फर्म पर सब डिलीट */
  const handlePruneButtonClick = () => {
    setHideZeroRows(false)
    setOnlyZeroDashboards(true)
    setSearch('')
    window.setTimeout(() => {
      void handlePruneEmptyDashboards()
    }, 150)
  }

  /** सभी Zero users: आज की date पर 10 impressions + ₹1 earnings (starter डेटा) */
  const handleSeedZerosToTenOne = async () => {
    if (!db) return
    const targets = rows.filter((r) => !hasMeaningfulDashboardData(r.dashboard))
    if (!targets.length) {
      setPruneMsg({ text: 'कोई Zero user नहीं।', kind: 'neutral' })
      return
    }
    const ok = window.confirm(
      `${targets.length} Zero users को आज की date पर सेट करें:\n` +
        `10 impressions, ₹1 earnings (CPM auto)?\n\n` +
        `पहले से Active users नहीं बदलेंगे।`,
    )
    if (!ok) return
    const todayIso = new Date().toISOString().split('T')[0]
    const imps = 10
    const earn = 1
    const cpm = toFixed2((earn / imps) * 1000)
    const dailyStats = { [todayIso]: { impressions: imps, earnings: earn, cpm } }
    const sum = computeSummaryFromDaily(dailyStats)
    try {
      setSeeding(true)
      setSeedUndoKeys(null)
      setPruneMsg({ text: `0/${targets.length} पर सीड लग रहा है…`, kind: 'neutral' })
      let done = 0
      const seededKeys = []
      for (const r of targets) {
        if (hasMeaningfulDashboardData(r.dashboard)) continue
        try {
          await update(ref(db, `users/${r.key}/dashboard`), {
            totalavailable: sum.totalAvailable,
            totalEarnings: sum.totalEarnings,
            todayImpressions: sum.todayImpressions,
            totalImpressions: sum.totalImpressions,
            currentCPM: sum.currentCPM,
            dailyStats,
          })
          seededKeys.push(r.key)
          done++
          if (done % 50 === 0 || done === targets.length) {
            setPruneMsg({ text: `${done}/${targets.length} सीड हो गया…`, kind: 'neutral' })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setPruneMsg({
            text:
              `❌ ${seededKeys.length} users पर सीड हो चुका, फिर एरर (${r.email}): ${msg} · नीचे「सफल सीड हटाएँ」से अब तक का वापस ले सकते हो।`,
            kind: 'err',
          })
          setSeedUndoKeys(seededKeys)
          return
        }
      }
      setPruneMsg({ text: `✅ ${done} users पर 10 imps + ₹1 सेट हो गया।`, kind: 'ok' })
      setOnlyZeroDashboards(false)
      setSeedUndoKeys(null)
    } catch (e) {
      setPruneMsg({ text: '❌ ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    } finally {
      setSeeding(false)
    }
  }

  const undoSuccessfulSeed = async () => {
    if (!db || !seedUndoKeys?.length) return
    const keys = [...seedUndoKeys]
    try {
      setSeeding(true)
      setPruneMsg({ text: `${keys.length} users का सीड वापस हटा रहे हैं…`, kind: 'neutral' })
      for (const key of keys) {
        await remove(ref(db, `users/${key}/dashboard`))
      }
      setSeedUndoKeys(null)
      setPruneMsg({ text: `✅ ${keys.length} users पर लगा सीड हटा दिया।`, kind: 'ok' })
      if (selectedEmail) {
        const k = encodeEmailKey(selectedEmail)
        if (keys.includes(k)) {
          setSelectedEmail(null)
          setCurrentDailyStats({})
        }
      }
    } catch (e) {
      setPruneMsg({ text: '❌ ' + (e instanceof Error ? e.message : String(e)), kind: 'err' })
    } finally {
      setSeeding(false)
    }
  }

  const summary = useMemo(
    () => computeSummaryFromDaily(currentDailyStats),
    [currentDailyStats],
  )

  const dailySortedKeys = Object.keys(currentDailyStats || {}).sort(
    (a, b) => new Date(b) - new Date(a),
  )

  const msgClass = (k) => 'pro-msg ' + (k || 'neutral')

  return (
    <div className="pro-dash">
      <header>
        <div>
          <h1>
            Earnings Dashboard <span className="badge">Live</span>
          </h1>
          <p className="sub">
            सभी Firebase users की mail + टोटल stats। रो सेलेक्ट करके नीचे दाईं तरफ उसी email की{' '}
            <strong>Daily Stat</strong> एडिट करें।             पूरी तरह 0 वाले या{' '}
            <strong>Total Earnings ₹{MIN_EARNINGS_DELETE_RUPEES} से कम</strong> वाले — पूरा user (email) RTDB
            से हटता है (shortner सहित)। ₹{MIN_EARNINGS_DELETE_RUPEES}+ वाले नहीं छुए जाते।
          </p>
        </div>
      </header>

      <div className="pro-inner">
        {fbErr && (
          <p className="pro-msg err" style={{ marginBottom: 12 }}>
            {fbErr}
          </p>
        )}

        <div className="pro-kpi-grid">
          <div className="pro-kpi">
            <label>Total Impressions (visible)</label>
            <strong>{kpiTotals.totalImpressions.toLocaleString('en-IN')}</strong>
          </div>
          <div className="pro-kpi">
            <label>Total Earnings (₹)</label>
            <strong>₹{kpiTotals.totalEarnings.toFixed(2)}</strong>
          </div>
          <div className="pro-kpi">
            <label>Today Impressions</label>
            <strong>{kpiTotals.todayImpressions.toLocaleString('en-IN')}</strong>
          </div>
          <div className="pro-kpi">
            <label>Current CPM (₹) weighted</label>
            <strong>₹{kpiTotals.currentCPM.toFixed(2)}</strong>
          </div>
          <div className="pro-kpi">
            <label>Total Available (₹)</label>
            <strong>₹{kpiTotals.totalAvailable.toFixed(2)}</strong>
          </div>
        </div>

        <div className="pro-toolbar">
          <input
            type="search"
            placeholder="Search email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search users"
          />
          <label className="chk">
            <input
              type="checkbox"
              checked={hideZeroRows}
              onChange={(e) => {
                const v = e.target.checked
                setHideZeroRows(v)
                if (v) setOnlyZeroDashboards(false)
              }}
            />
            सिर्फ active users
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={onlyZeroDashboards}
              onChange={(e) => {
                const v = e.target.checked
                setOnlyZeroDashboards(v)
                if (v) setHideZeroRows(false)
              }}
            />
            खाली dashboards टैब ({zeroCount})
          </label>
          <button
            type="button"
            className="ghost"
            disabled={fbLoading}
            title="एक बार मैन्युअल sync — लिस्ट पहले से Live अपडेट हो रही है"
            onClick={() => void refreshUsers()}
          >
            Refresh
          </button>
          <button
            type="button"
            className="ghost"
            disabled={seeding || pruning || fbLoading || !db || zeroCount === 0}
            onClick={() => void handleSeedZerosToTenOne()}
            title="हर Zero user: आज 10 impressions + ₹1 earnings"
          >
            Zero → 10 imps + ₹1 ({zeroCount})
          </button>
          <button
            type="button"
            className="prune"
            disabled={seeding || pruning || fbLoading || !db || prunableZeroCount === 0}
            onClick={() => handlePruneButtonClick()}
            title={
              prunableZeroCount === 0 && zeroCount > 0
                ? 'इन Zero users में dashboard नोड नहीं — हटाने को कुछ नहीं'
                : 'पूरा user (email) RTDB से — dashboard + shortner सब'
            }
          >
            Zero dashboards हटाएँ ({prunableZeroCount})
          </button>
          <button
            type="button"
            className="earnings-below"
            disabled={seeding || pruning || fbLoading || !db || belowTenDashboardCount === 0}
            onClick={() => void handleDeleteBelowTenRupees()}
            title={`Total Earnings ₹${MIN_EARNINGS_DELETE_RUPEES} से कम — पूरा user (email) RTDB से हटाएँ`}
          >
            ₹{MIN_EARNINGS_DELETE_RUPEES} से कम हटाएँ ({belowTenDashboardCount})
          </button>
        </div>
        <div className={msgClass(pruneMsg.kind)} style={{ marginBottom: 10 }}>
          {pruneMsg.text}
          {seedUndoKeys?.length > 0 && (
            <span style={{ marginLeft: 12, display: 'inline-block', verticalAlign: 'middle' }}>
              <button
                type="button"
                className="ghost danger"
                disabled={seeding || pruning || fbLoading || !db}
                onClick={() => void undoSuccessfulSeed()}
              >
                सफल सीड हटाएँ ({seedUndoKeys.length})
              </button>
            </span>
          )}
        </div>
        {pruneLive && (
          <div className="pro-prune-live" aria-live="polite">
            <div className="pro-prune-live-head">
              <strong>
              {pruning
                ? pruneKind === 'below10'
                  ? `Total Earnings < ₹${MIN_EARNINGS_DELETE_RUPEES} — पूरे user हट रहे हैं…`
                  : 'खाली Zero — पूरे user हट रहे हैं…'
                : 'आखिरी रन'}
            </strong>
              <span className="pro-prune-count">
                {pruneLive.removed.toLocaleString('en-IN')} / {pruneLive.total.toLocaleString('en-IN')}
              </span>
            </div>
            <progress
              className="pro-prune-progress"
              value={pruneLive.removed}
              max={Math.max(pruneLive.total, 1)}
            />
            {pruneLive.batchEmails?.length > 0 && (
              <div className="pro-prune-batch">
                <span className="pro-prune-label">इस बैच में ({pruneLive.batchEmails.length}):</span>
                <span className="pro-prune-emails">
                  {pruneLive.batchEmails.slice(0, 6).join(' · ')}
                  {pruneLive.batchEmails.length > 6
                    ? ` · +${pruneLive.batchEmails.length - 6} और`
                    : ''}
                </span>
              </div>
            )}
            {pruneLive.recent?.length > 0 && (
              <div className="pro-prune-recent">
                <span className="pro-prune-label">हाल ही में हटाए गए (नया → पुराना):</span>
                <ul>
                  {pruneLive.recent
                    .slice()
                    .reverse()
                    .map((em, idx) => (
                      <li key={`${em}-${idx}`}>{em}</li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className={msgClass(listMsg.kind)} style={{ marginBottom: 14 }}>
          {listMsg.text} · Active: {activeCount} · Zero: {zeroCount}
          {prunableZeroCount !== zeroCount && (
            <span style={{ color: '#fdba74', marginLeft: 6 }}>
              · हटाने योग्य (पूरा user): {prunableZeroCount}
            </span>
          )}
          {' '}
          · दिख रहे: {visibleRows.length} / {rows.length}
          {onlyZeroDashboards && (
            <span style={{ color: '#fdba74', marginLeft: 8 }}>
              · Zero टैब — सीड सभी Zero पर; डिलीट पूरा user ({prunableZeroCount})
            </span>
          )}
        </div>

        <div className="pro-split">
          <div className="pro-table-wrap">
            <div className="pro-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Total Impressions</th>
                    <th>Total Earnings (₹)</th>
                    <th>Today Impressions</th>
                    <th>CPM (₹)</th>
                    <th>Total Available (₹)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!visibleRows.length ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                        {fbLoading ? 'Loading…' : 'कोई user नहीं मिला।'}
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((r) => {
                      const s = dashboardSummary(r.dashboard)
                      const active = hasMeaningfulDashboardData(r.dashboard)
                      const sel = selectedEmail === r.email
                      return (
                        <tr
                          key={r.key}
                          className={(sel ? 'selected ' : '') + (onlyZeroDashboards ? 'zero-batch ' : '')}
                          onClick={() => void selectUser(r.email)}
                        >
                          <td className="email">{r.email}</td>
                          <td>{s.totalImpressions}</td>
                          <td>₹{s.totalEarnings.toFixed(2)}</td>
                          <td>{s.todayImpressions}</td>
                          <td>₹{s.currentCPM.toFixed(2)}</td>
                          <td>₹{s.totalAvailable.toFixed(2)}</td>
                          <td>
                            <span className={'pro-tag ' + (active ? 'active' : 'zero')}>
                              {active ? 'Active' : 'Zero'}
                            </span>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="pro-daily">
            <h2>Daily Stat (email + date)</h2>
            <p className="hint">
              टेबल से email चुनें। चुना हुआ: <strong>{selectedEmail || '—'}</strong>
            </p>

            <div className="pro-summary-mini">
              <div>
                Total Impressions: <span>{summary.totalImpressions}</span>
              </div>
              <div>
                Total Earnings (₹): <span>₹{summary.totalEarnings.toFixed(2)}</span>
              </div>
              <div>
                Today Impressions: <span>{summary.todayImpressions}</span>
              </div>
              <div>
                Current CPM (₹): <span>₹{summary.currentCPM.toFixed(2)}</span>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                Total Available (₹): <span>₹{summary.totalAvailable.toFixed(2)}</span>
              </div>
            </div>

            <div className="pro-field">
              <label htmlFor="fbDate">Date</label>
              <input
                type="date"
                id="fbDate"
                value={fbDate}
                onChange={(e) => {
                  const v = e.target.value
                  setFbDate(v)
                  if (selectedEmail) void loadDailyFromFirebase(v)
                }}
              />
            </div>
            <div className="pro-row">
              <div className="pro-field">
                <label>Impressions</label>
                <input
                  type="number"
                  value={fbImpressions}
                  onChange={(e) => setFbImpressions(e.target.value)}
                />
              </div>
              <div className="pro-field">
                <label>Earnings (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  value={fbEarnings}
                  onChange={(e) => setFbEarnings(e.target.value)}
                />
              </div>
            </div>
            <div className="pro-field">
              <label>CPM (₹)</label>
              <input
                type="number"
                step="0.01"
                placeholder="Auto if खाली"
                value={fbCPM}
                onChange={(e) => setFbCPM(e.target.value)}
              />
            </div>

            <div className={msgClass(fbExistingMsg.kind)}>{fbExistingMsg.text}</div>

            <div className="pro-actions">
              <button type="button" onClick={() => void saveDailyToFirebase()}>
                Save to Firebase
              </button>
              <button type="button" className="danger" onClick={() => void deleteDailyFromFirebase()}>
                Delete daily
              </button>
              <button type="button" className="secondary" onClick={() => void loadDailyFromFirebase()}>
                Reload
              </button>
            </div>
            <div className={msgClass(fbMsg.kind)}>{fbMsg.text}</div>

            <h3 style={{ margin: '16px 0 8px', fontSize: 13 }}>Daily history</h3>
            <div className="pro-small-table-wrap">
              <table className="pro-small-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Impressions</th>
                    <th>Earnings</th>
                    <th>CPM</th>
                  </tr>
                </thead>
                <tbody>
                  {!dailySortedKeys.length ? (
                    <tr>
                      <td colSpan={4}>No rows</td>
                    </tr>
                  ) : (
                    dailySortedKeys.map((d) => {
                      const x = currentDailyStats[d] || {}
                      return (
                        <tr key={d}>
                          <td>{d}</td>
                          <td>{safeNum(x.impressions)}</td>
                          <td>₹{toFixed2(x.earnings).toFixed(2)}</td>
                          <td>₹{toFixed2(x.cpm).toFixed(2)}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
