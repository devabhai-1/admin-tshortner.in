import { createContext, useContext, useEffect, useState } from 'react'
import { getApps, initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

const FirebaseContext = createContext({
  db: null,
  loading: true,
  error: null,
})

export function FirebaseProvider({ children }) {
  const [state, setState] = useState({ db: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/key.json', { cache: 'default' })
        if (!res.ok) throw new Error('Cannot load /key.json — copy key.json into public/')
        const cfg = await res.json()
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
