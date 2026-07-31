import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { FirebaseProvider } from './context/FirebaseProvider.jsx'
import UsersDataProvider from './context/UsersDataProvider.jsx'

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return

  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        registration.unregister()
      }
    })
    return
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing
          if (!newWorker) return
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              if (window.confirm('New admin version available. Reload?')) {
                window.location.reload()
              }
            }
          })
        })
        setInterval(() => {
          registration.update()
        }, 600000)
      })
      .catch((error) => {
        console.error('Service Worker registration failed:', error)
      })
  })
}

registerServiceWorker()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <FirebaseProvider>
        <UsersDataProvider>
          <App />
        </UsersDataProvider>
      </FirebaseProvider>
    </BrowserRouter>
  </StrictMode>,
)
