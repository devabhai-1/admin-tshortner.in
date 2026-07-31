import { createContext, useContext, useEffect, useState } from 'react'
import { getApps, initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { FIREBASE_WEB_CONFIG } from '../lib/firebaseWebConfig.js'

const FirebaseContext = createContext({
  db: null,
  loading: true,
  error: null,
})

async function loadFirebaseConfig() {
  // 1) Vercel build-time env (optional override)
  const envCfg = import.meta.env.VITE_FIREBASE_CONFIG
  if (envCfg && String(envCfg).trim()) {
    try {
      return JSON.parse(String(envCfg))
    } catch (err) {
      console.error('Failed to parse VITE_FIREBASE_CONFIG:', err)
    }
  }

  // 2) Individual env vars
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
  const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  if (apiKey && databaseURL && projectId) {
    return {
      apiKey,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || undefined,
      databaseURL,
      projectId,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || undefined,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || undefined,
      appId: import.meta.env.VITE_FIREBASE_APP_ID || undefined,
    }
  }

  // 3) Local public/key.json (dev only — often missing on Vercel)
  try {
    const res = await fetch('/key.json', { cache: 'default' })
    const contentType = res.headers.get('content-type') || ''
    const text = await res.text()
    if (res.ok && !contentType.includes('text/html') && !text.trimStart().startsWith('<!')) {
      return JSON.parse(text)
    }
  } catch {
    /* ignore */
  }

  // 4) Built-in public web config — works on Vercel without env
  return FIREBASE_WEB_CONFIG
}

export function FirebaseProvider({ children }) {
  const [state, setState] = useState({ db: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cfg = await loadFirebaseConfig()
        const app = getApps().length ? getApps()[0] : initializeApp(cfg)
        const db = getDatabase(app)
        if (!cancelled) setState({ db, loading: false, error: null })
      } catch (e) {
        if (!cancelled)
          setState({ db: null, loading: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return <FirebaseContext.Provider value={state}>{children}</FirebaseContext.Provider>
}

export function useFirebaseDb() {
  return useContext(FirebaseContext)
}
