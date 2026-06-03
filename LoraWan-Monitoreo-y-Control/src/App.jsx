import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import DeviceList from './pages/DeviceList';
import HistoryPage from './pages/History';
import SettingsPage from './pages/Settings';
import AutomationsPage from './pages/Automations';
import SpecialReport from './pages/SpecialReport';
import UserManagement from './pages/UserManagement';
import TemplatesPage from './pages/TemplatesPage';
import GatewaysPage from './pages/GatewaysPage';
import Login from './components/Login';
import FirstPasswordChange from './components/FirstPasswordChange';
import { useAuth } from './context/AuthContext';
import { DeviceWidgetPickerProvider } from './context/DeviceWidgetPickerContext';
import { useLanguage } from './context/LanguageContext';
import { Menu, User, Mail, LogOut, ChevronDown } from 'lucide-react';
import { useBarAvatarOverride } from './hooks/useBarAvatarOverride';
import { fetchLicenseWarnings } from './services/api';
import LnsDownlinkToastBridge from './components/LnsDownlinkToastBridge';
import AutomationToastBridge from './components/AutomationToastBridge';
import SyscomRealtimeBridge from './components/SyscomRealtimeBridge';
import { AppActivityLogProvider } from './context/AppActivityLogContext';
import { installAutomationToastAudioUnlock } from './utils/automationToastSound.js';

const PAGE_HEADINGS = {
  Dashboard: {
    title: 'Panel de control',
    subtitle: 'Sensores, métricas y telemetría en tiempo casi real',
  },
  Devices: { title: 'Dispositivos', subtitle: 'Listado, estado y acciones por equipo' },
  History: { title: 'Reportes', subtitle: 'Dispositivos, variables y exportación CSV/PDF' },
  SpecialReport: { title: 'Reporte especial', subtitle: 'Cálculos y documentos' },
  Automations: { title: 'Automatización', subtitle: 'Reglas, condiciones y acciones' },
  Settings: { title: 'Ajustes', subtitle: 'Cuenta, ingesta HTTP y apariencia' },
  Users: { title: 'Usuarios', subtitle: 'Alta, roles y tokens de ingesta' },
  Templates: {
    title: 'Plantillas',
    subtitle: 'Decoder y downlinks por modelo; marca una como predeterminada para heredarla en cada alta',
  },
  Gateway: {
    title: 'Gateway',
    subtitle: 'Alta de gateways LoRaWAN y estado en la cuenta',
  },
};

import { NAV_PAGE_IDS } from './config/navConfig';

const LAST_PAGE_STORAGE_KEY = 'syscom_iot_last_page';

const ALL_NAV_PAGE_IDS = new Set(NAV_PAGE_IDS);

function readLastPageFromStorage() {
  try {
    const v = localStorage.getItem(LAST_PAGE_STORAGE_KEY);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

function writeLastPageToStorage(pageId) {
  try {
    if (typeof pageId === 'string' && ALL_NAV_PAGE_IDS.has(pageId)) {
      localStorage.setItem(LAST_PAGE_STORAGE_KEY, pageId);
    }
  } catch {
    /* ignore */
  }
}

/** Páginas permitidas según `nav` del usuario (y plantillas solo rol superadmin). */
function resolvePageForRole(pageId, hasNavPage, isSuperAdmin) {
  const id = typeof pageId === 'string' && ALL_NAV_PAGE_IDS.has(pageId) ? pageId : 'Dashboard';
  const allowed = new Set();
  for (const p of ALL_NAV_PAGE_IDS) {
    if (hasNavPage(p)) allowed.add(p);
  }
  if (isSuperAdmin) allowed.add('Templates');
  if (!allowed.has('Dashboard')) allowed.add('Dashboard');
  return allowed.has(id) ? id : 'Dashboard';
}

function LicenseExpiryBanner({ userId }) {
  const [warnings, setWarnings] = useState([]);
  const today = new Date().toISOString().slice(0, 10);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('syscom_license_banner_dismiss') || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const w = await fetchLicenseWarnings();
        if (!cancelled) setWarnings(Array.isArray(w) ? w : []);
      } catch {
        if (!cancelled) setWarnings([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (warnings.length === 0 || dismissed === today) return null;

  const dismiss = () => {
    try {
      localStorage.setItem('syscom_license_banner_dismiss', today);
    } catch {
      /* ignore */
    }
    setDismissed(today);
  };

  return (
    <div className="license-expiry-banner" role="status">
      <div className="license-expiry-banner__inner">
        <strong>Licencias por vencer</strong>
        <p className="license-expiry-banner__hint">
          Aviso diario mientras el dispositivo esté en ventana de aviso; use «Entendido» para ocultarlo el resto del día.
        </p>
        <ul className="license-expiry-banner__list">
          {warnings.map((w) => (
            <li key={w.deviceId}>
              <span className="license-expiry-banner__name">{w.displayName || w.deviceId}</span>
              {' — '}
              {typeof w.daysRemaining === 'number' ? (
                <>
                  <strong>
                    {w.daysRemaining === 0
                      ? 'vence hoy'
                      : w.daysRemaining === 1
                        ? 'queda 1 día'
                        : `quedan ${w.daysRemaining} días`}
                  </strong>
                  {' para el vencimiento ('}
                  <time dateTime={w.expiresAt}>
                    {new Date(w.expiresAt).toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}
                  </time>
                  ).
                </>
              ) : (
                <>
                  vence el{' '}
                  <time dateTime={w.expiresAt}>
                    {new Date(w.expiresAt).toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}
                  </time>
                </>
              )}{' '}
              Tras esa fecha el dispositivo dejará de mostrarse en cuentas de administrador y usuario; el super
              administrador conserva hasta 30 días adicionales para renovar antes del borrado total.
            </li>
          ))}
        </ul>
        <button type="button" className="license-expiry-banner__dismiss" onClick={dismiss}>
          Entendido (no mostrar hasta mañana)
        </button>
      </div>
    </div>
  );
}

function ImpersonationSupportBanner({ isImpersonating, targetEmail, targetDisplayName, onExit, exitBusy }) {
  if (!isImpersonating) return null;
  const trimmedName = targetDisplayName && String(targetDisplayName).trim();
  const email = targetEmail && String(targetEmail).trim();
  const who =
    trimmedName ||
    (email ? email.split('@')[0] || email : '') ||
    'Usuario';
  return (
    <div className="syscom-impersonation-banner" role="status" aria-live="polite">
      <div className="syscom-impersonation-banner__inner">
        <div className="syscom-impersonation-banner__spacer" aria-hidden />
        <div className="syscom-impersonation-banner__center">
          <span className="syscom-impersonation-banner__kicker">Viendo la cuenta de</span>
          <span className="syscom-impersonation-banner__name">{who}</span>
        </div>
        <button
          type="button"
          className="syscom-impersonation-banner__btn"
          disabled={exitBusy}
          onClick={() => void onExit()}
        >
          {exitBusy ? 'Restaurando…' : 'Volver a mi cuenta'}
        </button>
      </div>
    </div>
  );
}

function App() {
  useEffect(() => {
    installAutomationToastAudioUnlock();
  }, []);

  const {
    user,
    userProfile,
    token,
    loading,
    hasNavPage,
    isSuperAdmin,
    logout,
    isImpersonating,
    exitImpersonation,
  } = useAuth();
  const barAvatarOverride = useBarAvatarOverride();

  const roleLabel = (role) => {
    if (role === 'superadmin') return 'Super administrador';
    if (role === 'admin') return 'Usuario'; /* legado migrado */
    if (role === 'user' || role === 'viewer') return 'Usuario';
    return 'Usuario';
  };
  const { t } = useLanguage();
  const [currentPage, setCurrentPage] = useState(() => {
    const raw = readLastPageFromStorage();
    return typeof raw === 'string' && ALL_NAV_PAGE_IDS.has(raw) ? raw : 'Dashboard';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userPopoverOpen, setUserPopoverOpen] = useState(false);
  const [devicesSearchQuery, setDevicesSearchQuery] = useState('');
  const [impersonationExitBusy, setImpersonationExitBusy] = useState(false);
  /** Tras login o F5: reaplicar `localStorage` cuando el rol ya es fiable (evita pisar con Dashboard). */
  const sessionRouteSyncedRef = useRef(false);

  useEffect(() => {
    if (!user) sessionRouteSyncedRef.current = false;
  }, [user]);

  useEffect(() => {
    if (loading || !user) return;
    if (!sessionRouteSyncedRef.current) {
      sessionRouteSyncedRef.current = true;
      const stored = readLastPageFromStorage();
      const candidate =
        typeof stored === 'string' && ALL_NAV_PAGE_IDS.has(stored) ? stored : 'Dashboard';
      const next = resolvePageForRole(candidate, hasNavPage, isSuperAdmin);
      setCurrentPage(next);
      writeLastPageToStorage(next);
      return;
    }
    setCurrentPage((prev) => resolvePageForRole(prev, hasNavPage, isSuperAdmin));
  }, [loading, user, hasNavPage, isSuperAdmin]);

  useEffect(() => {
    if (loading || !user) return;
    writeLastPageToStorage(resolvePageForRole(currentPage, hasNavPage, isSuperAdmin));
  }, [currentPage, loading, user, hasNavPage, isSuperAdmin]);

  /**
   * Panel de control: un solo scroll en `.page-content.page-content--budget-dashboard`. El wrapper del dashboard
   * no usa flex-grow para no quedar a altura fija con scroll interno (doble barra).
   */
  useEffect(() => {
    const cl = 'syscom-scroll-lock-dashboard';
    const supportView = Boolean(userProfile?.impersonation?.actorId || user?.impersonatorId);
    const mustChangePassword =
      Boolean(userProfile?.mustChangePassword ?? user?.mustChangePassword) && !supportView;
    const active = Boolean(
      !loading && user && token && currentPage === 'Dashboard' && !mustChangePassword
    );
    if (!active) {
      document.documentElement.classList.remove(cl);
      document.body.classList.remove(cl);
      return undefined;
    }
    document.documentElement.classList.add(cl);
    document.body.classList.add(cl);
    return () => {
      document.documentElement.classList.remove(cl);
      document.body.classList.remove(cl);
    };
  }, [loading, user, token, currentPage, userProfile?.mustChangePassword, user?.mustChangePassword, userProfile?.impersonation?.actorId, user?.impersonatorId]);

  if (loading) {
    return <div className="loading-screen loading-screen--premium">{t('common.loading')}</div>;
  }

  if (!user || !token) {
    return <Login />;
  }

  const supportView = Boolean(userProfile?.impersonation?.actorId || user?.impersonatorId);
  const mustChangePassword =
    Boolean(userProfile?.mustChangePassword ?? user?.mustChangePassword) && !supportView;
  if (mustChangePassword) {
    return <FirstPasswordChange />;
  }

  const navigate = (page) => {
    const next = resolvePageForRole(page, hasNavPage, isSuperAdmin);
    setCurrentPage(next);
    writeLastPageToStorage(next);
    setSidebarOpen(false);
    if (next !== 'Devices') setDevicesSearchQuery('');
  };

  const heading = PAGE_HEADINGS[currentPage] || PAGE_HEADINGS.Dashboard;
  const displayName =
    (userProfile?.profileName && String(userProfile.profileName).trim()) ||
    (user?.profileName && String(user.profileName).trim()) ||
    user?.email?.split('@')[0] ||
    'Usuario';
  const avatarUrl = barAvatarOverride || userProfile?.avatarUrl || user?.avatarUrl;

  return (
    <DeviceWidgetPickerProvider onSwitchToDashboard={() => setCurrentPage('Dashboard')}>
    <AppActivityLogProvider currentPage={currentPage}>
    <div className={`app-container app-container--premium ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <Sidebar
        onNavigate={navigate}
        activePage={currentPage}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)}></div>}

      <main className="main-content">
        <header className="top-bar top-bar--premium">
          <div className="top-bar-leading">
            <button type="button" className="mobile-menu-btn glass" onClick={() => setSidebarOpen(true)}>
              <Menu size={22} strokeWidth={1.75} />
            </button>
            <div className="page-heading">
              <h1>{heading.title}</h1>
              <p>{heading.subtitle}</p>
            </div>
          </div>
          <div className="top-bar-tools">
           <div 
            className={`user-profile glass ${userPopoverOpen ? 'active' : ''}`} 
            onClick={() => setUserPopoverOpen(!userPopoverOpen)}
            style={{ 
              cursor: 'pointer', 
              padding: '6px 12px', 
              borderRadius: '20px',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: '10px'
            }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="top-bar-avatar-img"
                width={36}
                height={36}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="profile-badge glass" style={{ margin: 0 }}>
                IOT
              </div>
            )}
            <span className="top-bar-user-name">{displayName}</span>
            <ChevronDown size={14} style={{ opacity: 0.5, transform: userPopoverOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />

            {userPopoverOpen && (
              <div className="user-popover glass card animate-in" onClick={(e) => e.stopPropagation()}>
                <div className="popover-header">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="large-avatar large-avatar--photo"
                      width={48}
                      height={48}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="large-avatar">IOT</div>
                  )}
                  <div className="user-details">
                    <div className="popover-name">{displayName}</div>
                    <div className="popover-role">{roleLabel(userProfile?.role ?? user?.role)}</div>
                  </div>
                </div>
                
                <div className="popover-divider"></div>
                
                <div className="popover-info">
                  <div className="info-item">
                    <User size={16} />
                    <span>{displayName}</span>
                  </div>
                  <div className="info-item">
                    <Mail size={16} />
                    <span>{user?.email}</span>
                  </div>
                </div>

                <div className="popover-divider"></div>
                
                <button type="button" className="logout-btn" onClick={() => { logout(); setUserPopoverOpen(false); }}>
                  <LogOut size={16} /> Cerrar Sesión
                </button>
              </div>
            )}
          </div>
          </div>
        </header>
        <ImpersonationSupportBanner
          isImpersonating={isImpersonating}
          targetEmail={user?.email}
          targetDisplayName={userProfile?.profileName ?? user?.profileName}
          exitBusy={impersonationExitBusy}
          onExit={async () => {
            if (impersonationExitBusy) return;
            setImpersonationExitBusy(true);
            try {
              await exitImpersonation();
            } catch (e) {
              window.alert(e?.message || 'No se pudo volver a su cuenta');
            } finally {
              setImpersonationExitBusy(false);
            }
          }}
        />
        <LicenseExpiryBanner userId={user?.id} />
        <SyscomRealtimeBridge />
        <LnsDownlinkToastBridge />
        <AutomationToastBridge />
        <div
          className={`page-content${currentPage === 'Dashboard' ? ' page-content--budget-dashboard' : ''}`}
        >
          {currentPage === 'Dashboard'    && <Dashboard />}
          {currentPage === 'Devices'      && (
            <DeviceList listSearchQuery={devicesSearchQuery} onListSearchQueryChange={setDevicesSearchQuery} />
          )}
          {currentPage === 'History'      && <HistoryPage />}
          {currentPage === 'SpecialReport'&& <SpecialReport />}
          {/* Admin-only pages */}
          {currentPage === 'Automations'  && (hasNavPage('Automations') ? <AutomationsPage /> : <AccessDenied />)}
          {currentPage === 'Settings'     && (hasNavPage('Settings') ? <SettingsPage />    : <AccessDenied />)}
          {currentPage === 'Users'        && (hasNavPage('Users') ? <UserManagement onAfterEnterSupport={() => navigate('Dashboard')} />  : <AccessDenied />)}
          {currentPage === 'Templates'   && (isSuperAdmin ? <TemplatesPage /> : <AccessDenied />)}
          {currentPage === 'Gateway'      && (hasNavPage('Gateway') ? <GatewaysPage /> : <AccessDenied />)}
        </div>
      </main>
    </div>
    </AppActivityLogProvider>
    </DeviceWidgetPickerProvider>
  );
}

const AccessDenied = () => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: '1rem', color: 'var(--text-secondary)' }}>
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
    <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>Acceso restringido</h2>
    <p style={{ margin: 0 }}>No tienes permisos para ver esta sección.</p>
  </div>
);

export default App;
