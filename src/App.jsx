import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import MainDashboard from './pages/MainDashboard.jsx'
import GaFirebaseDashboard from './pages/GaFirebaseDashboard.jsx'
import WithdrawalPanel from './pages/WithdrawalPanel.jsx'
import EarningUsersDashboard from './pages/EarningUsersDashboard.jsx'
import TelegramIdsDashboard from './pages/TelegramIdsDashboard.jsx'
import MailDashboard from './pages/MailDashboard.jsx'
import Login from './pages/Login.jsx'
import { useAuth } from './context/AuthProvider.jsx'
import { FirebaseProvider } from './context/FirebaseProvider.jsx'
import UsersDataProvider from './context/UsersDataProvider.jsx'
import './App.css'

function ProtectedApp() {
  const { user, logout } = useAuth()

  return (
    <FirebaseProvider>
      <UsersDataProvider>
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
              <NavLink to="/mail">Mail Dashboard</NavLink>
              <NavLink to="/withdrawals">Withdrawals</NavLink>
              <button
                type="button"
                className="app-logout"
                onClick={async () => {
                  await logout()
                  window.location.assign('/login')
                }}
              >
                Logout{user ? ` (${user})` : ''}
              </button>
            </div>
          </nav>

          <main className="app-main">
            <Routes>
              <Route path="/" element={<MainDashboard />} />
              <Route path="/ga4" element={<GaFirebaseDashboard />} />
              <Route path="/earning-users" element={<EarningUsersDashboard />} />
              <Route path="/telegram-ids" element={<TelegramIdsDashboard />} />
              <Route path="/mail" element={<MailDashboard />} />
              <Route path="/withdrawals" element={<WithdrawalPanel />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </UsersDataProvider>
    </FirebaseProvider>
  )
}

function RequireAuth({ children }) {
  const { ready, isAuthenticated } = useAuth()
  const location = useLocation()

  if (!ready) {
    return (
      <div className="auth-boot">
        <p>Checking session…</p>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <ProtectedApp />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
