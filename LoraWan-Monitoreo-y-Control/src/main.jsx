import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext'
import { LanguageProvider } from './context/LanguageContext'
import { ThemeProvider } from './context/ThemeContext'
import { registerSyscomNotifyServiceWorker } from './utils/browserNotifications.js'

if (import.meta.env.DEV) {
  console.log('--- SYSTEM BOOT ---');
}

registerSyscomNotifyServiceWorker();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <LanguageProvider>
        <AuthProvider>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </AuthProvider>
      </LanguageProvider>
    </StrictMode>
  );
}
