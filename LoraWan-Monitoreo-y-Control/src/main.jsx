import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import MobileApp from './mobile/MobileApp.jsx'
import { AuthProvider } from './context/AuthContext'
import { LanguageProvider } from './context/LanguageContext'
import { ThemeProvider } from './context/ThemeContext'
import { registerSyscomNotifyServiceWorker } from './utils/browserNotifications.js'
import { isMobileApp } from './utils/mobilePlatform.js'

if (import.meta.env.DEV) {
  console.log('--- SYSTEM BOOT ---');
}

if (!isMobileApp()) {
  registerSyscomNotifyServiceWorker();
}

const RootShell = isMobileApp() ? MobileApp : App;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <LanguageProvider>
        <AuthProvider>
          <ThemeProvider>
            <RootShell />
          </ThemeProvider>
        </AuthProvider>
      </LanguageProvider>
    </StrictMode>
  );
}
