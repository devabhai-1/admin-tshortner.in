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
        let cfg

        // 1. Try single environment variable containing the JSON config
        const envCfg = import.meta.env.VITE_FIREBASE_CONFIG
        if (envCfg) {
          try {
            cfg = JSON.parse(envCfg)
          } catch (err) {
            console.error('Failed to parse VITE_FIREBASE_CONFIG environment variable:', err)
          }
        }

        // 2. Try individual environment variables
        if (!cfg) {
          const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
          const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
          const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL
          const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
          const storageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET
          const messagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID
          const appId = import.meta.env.VITE_FIREBASE_APP_ID

          if (apiKey && databaseURL && projectId) {
            cfg = {
              apiKey,
              authDomain,
              databaseURL,
              projectId,
              storageBucket,
              messagingSenderId,
              appId,
            }
          }
        }

        // 3. Fallback to fetching key.json
        if (!cfg) {
          const res = await fetch('/key.json', { cache: 'default' })
          if (!res.ok) {
            throw new Error(
              'Cannot load Firebase configuration. Please configure VITE_FIREBASE_CONFIG env variable in Vercel or place key.json in your public/ folder.',
            )
          }
          cfg = await res.json()
        }

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
