import { useState } from 'react'
import { apiUrl } from '../lib/api'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('adminToken', data.token)
        onLogin()
      } else {
        setError(data.error || 'Invalid credentials')
      }
    } catch (err) {
      setError('Connection failed. Backend is offline?')
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#121212', color: '#fff' }}>
      <form onSubmit={handleSubmit} style={{ background: '#1e1e1e', padding: '2rem', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '1rem', width: '300px', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}>
        <h2 style={{ margin: 0, textAlign: 'center' }}>Admin Access</h2>
        {error && <div style={{ color: '#ff4444', textAlign: 'center', fontSize: '0.9rem' }}>{error}</div>}
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Username</label>
          <input 
            type="text" 
            value={username} 
            onChange={e => setUsername(e.target.value)} 
            required 
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box', background: '#333', color: '#fff', border: '1px solid #444', borderRadius: '4px' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Password</label>
          <input 
            type="password" 
            value={password} 
            onChange={e => setPassword(e.target.value)} 
            required 
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box', background: '#333', color: '#fff', border: '1px solid #444', borderRadius: '4px' }}
          />
        </div>
        <button type="submit" disabled={loading} style={{ padding: '0.75rem', background: '#4CAF50', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>
  )
}
