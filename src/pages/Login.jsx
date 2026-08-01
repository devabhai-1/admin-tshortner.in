import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider.jsx'
import './Login.css'

export default function Login() {
  const { ready, isAuthenticated, login } = useAuth()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (ready && isAuthenticated) {
    const to = location.state?.from?.pathname || '/'
    return <Navigate to={to} replace />
  }

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const result = await login(username.trim(), password)
      if (!result.ok) setError(result.error || 'Invalid credentials')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-glow" aria-hidden="true" />
      <form className="login-panel" onSubmit={onSubmit} autoComplete="off">
        <p className="login-brand">TShortner Admin</p>
        <h1 className="login-title">Sign in</h1>
        <p className="login-sub">Authorized administrators only.</p>

        <label className="login-label" htmlFor="admin-username">
          Username
        </label>
        <input
          id="admin-username"
          className="login-input"
          name="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={submitting || !ready}
        />

        <label className="login-label" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          className="login-input"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={submitting || !ready}
        />

        {error ? <p className="login-error">{error}</p> : null}

        <button className="login-submit" type="submit" disabled={submitting || !ready}>
          {submitting ? 'Checking…' : 'Enter admin'}
        </button>
      </form>
    </div>
  )
}
