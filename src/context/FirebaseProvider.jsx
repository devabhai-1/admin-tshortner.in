import { createContext, useContext, useState } from 'react'
import { getApps, initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { FIREBASE_WEB_CONFIG } from '../lib/firebaseWebConfig.js'

const FirebaseContext = createContext({
  db: null,
  loading: true,
  error: null,
})

function configFromEnv() {
  const envCfg = import.meta.env.VITE_FIREBASE_CONFIG
  if (envCfg && String(envCfg).trim()) {
    try {
      return JSON.parse(String(envCfg))
    } catch (err) {
      console.error('Failed to parse VITE_FIREBASE_CONFIG:', err)
    }
  }

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
  return null
}

/** Sync config only — never block on /key.json network fetch. */
function resolveFirebaseConfigSync() {
  return configFromEnv() || FIREBASE_WEB_CONFIG
}

function initDb(cfg) {
  const app = getApps().length ? getApps()[0] : initializeApp(cfg)
  return getDatabase(app)
}

export function FirebaseProvider({ children }) {
  const [state] = useState(() => {
    try {
      const cfg = resolveFirebaseConfigSync()
      return { db: initDb(cfg), loading: false, error: null }
    } catch (e) {
      return {
        db: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })

  return <FirebaseContext.Provider value={state}>{children}</FirebaseContext.Provider>
}

export function useFirebaseDb() {
  return useContext(FirebaseContext)
}
