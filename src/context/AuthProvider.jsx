import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  apiFetch,
  apiUrl,
  clearStoredToken,
  getStoredToken,
  setStoredToken,
} from '../lib/api.js'
import { clearUsersDataCaches } from './usersDataCache.js'

const AuthContext = createContext({
  ready: false,
  isAuthenticated: false,
  user: null,
  login: async () => ({ ok: false }),
  logout: async () => {},
})

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [user, setUser] = useState(null)

  const syncSession = useCallback(async () => {
    const token = getStoredToken()
    if (!token) {
      setIsAuthenticated(false)
      setUser(null)
      setReady(true)
      return
    }

    try {
      const res = await fetch(apiUrl('/api/auth/me'), {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Admin-Token': token,
        },
      })
      if (!res.ok) {
        clearStoredToken()
        setIsAuthenticated(false)
        setUser(null)
        setReady(true)
        return
      }
      const data = await res.json()
      if (data?.authenticated) {
        setIsAuthenticated(true)
        setUser(data.user || 'admin')
      } else {
        clearStoredToken()
        setIsAuthenticated(false)
        setUser(null)
      }
    } catch {
      // Offline / API down: keep local token so UI can retry after API starts
      setIsAuthenticated(Boolean(token))
      setUser(token ? 'admin' : null)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    syncSession()
  }, [syncSession])

  const login = useCallback(async (username, password) => {
    const res = await fetch(apiUrl('/api/login'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (!res.ok || !data?.success || !data?.token) {
      return {
        ok: false,
        error: data?.error || `Login failed (${res.status})`,
      }
    }
    setStoredToken(data.token)
    setIsAuthenticated(true)
    setUser(username)
    return { ok: true }
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    clearStoredToken()
    clearUsersDataCaches()
    setIsAuthenticated(false)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ ready, isAuthenticated, user, login, logout }),
    [ready, isAuthenticated, user, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
