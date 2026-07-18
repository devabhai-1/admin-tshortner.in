import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useState, useEffect } from 'react'
import Login from './components/Login.jsx'
import MainDashboard from './pages/MainDashboard.jsx'
import GaFirebaseDashboard from './pages/GaFirebaseDashboard.jsx'
import WithdrawalPanel from './pages/WithdrawalPanel.jsx'
import EarningUsersDashboard from './pages/EarningUsersDashboard.jsx'
import TelegramIdsDashboard from './pages/TelegramIdsDashboard.jsx'
import './App.css'

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    if (localStorage.getItem('adminToken')) {
      setIsAuthenticated(true)
    }
  }, [])

  if (!isAuthenticated) {
    return <Login onLogin={() => setIsAuthenticated(true)} />
  }

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <NavLink to="/" className="app-brand" end>
          TShortner Admin
        </NavLink>
        <div className="app-nav-links">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/ga4">GA4 Analysis</NavLink>
          <NavLink to="/earning-users">All Users</NavLink>
          <NavLink to="/telegram-ids">Telegram IDs</NavLink>
          <NavLink to="/withdrawals">Withdrawals</NavLink>
        </div>
      </nav>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<MainDashboard />} />
          <Route path="/ga4" element={<GaFirebaseDashboard />} />
          <Route path="/earning-users" element={<EarningUsersDashboard />} />
          <Route path="/telegram-ids" element={<TelegramIdsDashboard />} />
          <Route path="/withdrawals" element={<WithdrawalPanel />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
