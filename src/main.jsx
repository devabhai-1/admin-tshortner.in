import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { FirebaseProvider } from './context/FirebaseProvider.jsx'
import UsersDataProvider from './context/UsersDataProvider.jsx'

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
