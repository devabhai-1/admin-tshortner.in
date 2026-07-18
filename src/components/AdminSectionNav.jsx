import { NavLink } from 'react-router-dom'
import './AdminSectionNav.css'

const LINKS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/earning-users', label: 'All Users', end: false },
  { to: '/telegram-ids', label: 'Telegram IDs', end: false },
  { to: '/ga4', label: 'GA4 Analysis', end: false },
  { to: '/withdrawals', label: 'Withdrawals', end: false },
]

export default function AdminSectionNav() {
  return (
    <nav className="admin-section-nav" aria-label="Admin menu">
      {LINKS.map(({ to, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => (isActive ? 'admin-section-nav__link active' : 'admin-section-nav__link')}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  )
}
