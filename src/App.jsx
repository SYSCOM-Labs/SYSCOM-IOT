import React, { useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
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
import { Menu, User, Mail, LogOut, ChevronDown, Bug } from 'lucide-react';
import { fetchLicenseWarnings } from './services/api';
import { fetchDebugImpersonationUsers } from './services/localAuth';
import { isLocalDebugHost } from './utils/debugHost';
import LnsDownlinkToastBridge from './components/LnsDownlinkToastBridge';
import SyscomRealtimeBridge from './components/SyscomRealtimeBridge';
import AppLogRealtimeBridge from './components/AppLogRealtimeBridge';
import AppBottomLog from './components/AppBottomLog';
import { AppLogProvider } from './context/AppLogContext';
import { ROUTES } from './constants/routes';

const PAGE_HEADINGS = {
  Dashboard: {
    title: 'Panel de control',
    subtitle: 'Sensores, métricas y telemetría en tiempo casi real',
  },
  Devices: { title: 'Dispositivos', subtitle: 'Listado, estado y acciones por equipo' },
  History: { title: 'Historial', subtitle: 'Series temporales y exportación' },
  SpecialReport: { title: 'Reporte especial', subtitle: 'Cálculos y documentos' },
  Automations: { title: 'Automatización', subtitle: 'Reglas, condiciones y acciones' },
  Settings: { title: 'Ajustes', subtitle: 'Apariencia y notificaciones' },
  Users: { title: 'Usuarios', subtitle: 'Alta, roles y tokens de ingesta' },
  Templates: {
    title: 'Plantillas',
    subtitle: 'Decoder y downlinks por modelo; la predeterminada se hereda al dar de alta',
  },
  Gateway: {
    title: 'Gateway',
    subtitle: 'Alta de gateways LoRaWAN y estado en la cuenta',
  },
};

function getHeadingForPath(pathname) {
  const p = pathname || '';
  if (p === '/' || p.startsWith('/panel')) return PAGE_HEADINGS.Dashboard;
  if (p.startsWith('/dispositivos')) return PAGE_HEADINGS.Devices;
  if (p.startsWith('/historial')) return PAGE_HEADINGS.History;
  if (p.startsWith('/reporte-especial')) return PAGE_HEADINGS.SpecialReport;
  if (p.startsWith('/automatizacion')) return PAGE_HEADINGS.Automations;
  if (p.startsWith('/ajustes')) return PAGE_HEADINGS.Settings;
  if (p.startsWith('/usuarios')) return PAGE_HEADINGS.Users;
  if (p.startsWith('/plantillas')) return PAGE_HEADINGS.Templates;
  if (p.startsWith('/gateway')) return PAGE_HEADINGS.Gateway;
  return PAGE_HEADINGS.Dashboard;
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

  React.useEffect(() => {
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
        <ul className="license-expiry-banner__list">
          {warnings.map((w) => (
            <li key={w.deviceId}>
              <span className="license-expiry-banner__name">{w.displayName || w.deviceId}</span>
              {' — vence el '}
              <time dateTime={w.expiresAt}>
                {new Date(w.expiresAt).toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' })}
              </time>
              . Tras esa fecha el dispositivo dejará de mostrarse en cuentas de administrador y usuario.
            </li>
          ))}
        </ul>
        <button type="button" className="license-expiry-banner__dismiss" onClick={dismiss}>
          Entendido (hoy)
        </button>
      </div>
    </div>
  );
}

function userInitials(name, email) {
  const n = (name || email || '').trim();
  if (!n) return 'U';
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return n.slice(0, 2).toUpperCase();
}

function AppShell() {
  const { user, userProfile, token, loading, isAdmin, isSuperAdmin, logout, loginAsDebugUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const roleLabel = (role) => {
    if (role === 'superadmin') return 'Super administrador';
    if (role === 'admin') return 'Administrador';
    if (role === 'user' || role === 'viewer') return 'Usuario';
    return 'Usuario';
  };
  const { t } = useLanguage();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userPopoverOpen, setUserPopoverOpen] = useState(false);
  const [devicesSearchQuery, setDevicesSearchQuery] = useState('');
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [debugUsers, setDebugUsers] = useState([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState(null);
  const [selectedDebugUserId, setSelectedDebugUserId] = useState('');

  const showDebugMode = isLocalDebugHost() && isAdmin;

  const toggleDebugPanel = async () => {
    const next = !debugPanelOpen;
    setDebugPanelOpen(next);
    setDebugError(null);
    if (next && debugUsers.length === 0 && !debugLoading) {
      setDebugLoading(true);
      try {
        const list = await fetchDebugImpersonationUsers();
        setDebugUsers(Array.isArray(list) ? list : []);
      } catch (e) {
        setDebugError(e.message || 'No disponible');
        setDebugUsers([]);
      } finally {
        setDebugLoading(false);
      }
    }
  };

  const applyDebugLogin = async () => {
    if (!selectedDebugUserId) return;
    setDebugLoading(true);
    setDebugError(null);
    try {
      await loginAsDebugUser(selectedDebugUserId);
      setUserPopoverOpen(false);
      setDebugPanelOpen(false);
    } catch (e) {
      setDebugError(e.message || 'Error al suplantar usuario');
    } finally {
      setDebugLoading(false);
    }
  };

  const heading = getHeadingForPath(location.pathname);
  const showDevicesSearch = location.pathname.startsWith('/dispositivos');

  React.useEffect(() => {
    if (!location.pathname.startsWith('/dispositivos')) {
      setDevicesSearchQuery('');
    }
  }, [location.pathname]);

  if (loading) {
    return <div className="loading-screen loading-screen--premium">{t('common.loading')}</div>;
  }

  if (!user || !token) {
    return <Login />;
  }

  const mustChangePassword = Boolean(userProfile?.mustChangePassword ?? user?.mustChangePassword);
  if (mustChangePassword) {
    return <FirstPasswordChange />;
  }

  return (
    <AppLogProvider>
      <DeviceWidgetPickerProvider onSwitchToDashboard={() => navigate(ROUTES.panel)}>
        <div className={`app-container app-container--premium ${sidebarOpen ? 'sidebar-open' : ''}`}>
          <Sidebar
            pathname={location.pathname}
            isOpen={sidebarOpen}
            onToggle={() => setSidebarOpen(!sidebarOpen)}
            onAfterNavigate={() => setSidebarOpen(false)}
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
              <div className="search-container">
                {showDevicesSearch && (
                  <input
                    type="search"
                    className="search-input glass"
                    placeholder="Nombre, etiqueta, DevEUI…"
                    value={devicesSearchQuery}
                    onChange={(e) => setDevicesSearchQuery(e.target.value)}
                    aria-label="Filtrar dispositivos por nombre, etiqueta o DevEUI"
                    autoComplete="off"
                  />
                )}
              </div>
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
                  gap: '10px',
                }}
              >
                {userProfile?.pictureUrl ? (
                  <img
                    src={userProfile.pictureUrl}
                    alt="avatar"
                    className="profile-badge profile-badge--photo"
                    style={{ margin: 0 }}
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="profile-badge glass" style={{ margin: 0 }}>
                    {userInitials(userProfile?.profileName, userProfile?.email)}
                  </div>
                )}
                <span className="user-name" style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                  {user?.profileName || user?.displayName || user?.email?.split('@')[0] || 'User'}
                </span>
                <ChevronDown
                  size={14}
                  style={{ opacity: 0.5, transform: userPopoverOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                />

                {userPopoverOpen && (
                  <div className="user-popover glass card animate-in" onClick={(e) => e.stopPropagation()}>
                    <div className="popover-header">
                      {userProfile?.pictureUrl ? (
                        <img
                          src={userProfile.pictureUrl}
                          alt="avatar"
                          className="large-avatar large-avatar--photo"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="large-avatar">{userInitials(userProfile?.profileName, userProfile?.email)}</div>
                      )}
                      <div className="user-details">
                        <div className="popover-name">{user?.profileName || 'Usuario'}</div>
                        <div className="popover-role">{roleLabel(user?.role)}</div>
                      </div>
                    </div>

                    <div className="popover-divider"></div>

                    <div className="popover-info">
                      <div className="info-item">
                        <User size={16} />
                        <span>{user?.profileName}</span>
                      </div>
                      <div className="info-item">
                        <Mail size={16} />
                        <span>{user?.email}</span>
                      </div>
                    </div>

                    {showDebugMode && (
                      <>
                        <div className="popover-divider"></div>
                        <div className="user-popover-debug">
                          <button type="button" className="debug-mode-toggle" onClick={() => void toggleDebugPanel()}>
                            <Bug size={16} aria-hidden /> Debug Mode
                          </button>
                          {debugPanelOpen && (
                            <div className="debug-mode-panel">
                              {debugLoading && <span className="debug-mode-hint">Cargando usuarios…</span>}
                              {debugError && <span className="debug-mode-err">{debugError}</span>}
                              <label className="debug-mode-label" htmlFor="debug-user-select">
                                Suplantar sesión
                              </label>
                              <select
                                id="debug-user-select"
                                className="debug-mode-select"
                                value={selectedDebugUserId}
                                onChange={(e) => setSelectedDebugUserId(e.target.value)}
                                disabled={debugLoading}
                              >
                                <option value="">— Elegir usuario —</option>
                                {debugUsers.map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {(u.profileName || u.email || u.id).slice(0, 40)}
                                    {u.email ? ` · ${u.email}` : ''}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="debug-mode-apply"
                                disabled={!selectedDebugUserId || debugLoading}
                                onClick={() => void applyDebugLogin()}
                              >
                                Iniciar sesión como…
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    <div className="popover-divider"></div>

                    <button
                      type="button"
                      className="logout-btn"
                      onClick={() => {
                        logout();
                        setUserPopoverOpen(false);
                      }}
                    >
                      <LogOut size={16} /> Cerrar Sesión
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>
          <LicenseExpiryBanner userId={user?.id} />
          <SyscomRealtimeBridge />
          <AppLogRealtimeBridge />
          <LnsDownlinkToastBridge />
          <div className="page-content">
            <Routes>
              <Route path="/" element={<Navigate to={ROUTES.panel} replace />} />
              <Route path="/panel" element={<Dashboard />} />
              <Route
                path="/dispositivos/:deviceId?"
                element={<DeviceList listSearchQuery={devicesSearchQuery} onListSearchQueryChange={setDevicesSearchQuery} />}
              />
              <Route path="/historial" element={<HistoryPage />} />
              <Route path="/historial/dispositivo/:deviceId" element={<HistoryPage />} />
              <Route path="/reporte-especial" element={<SpecialReport />} />
              <Route path="/automatizacion" element={<AutomationsPage />} />
              <Route path="/ajustes" element={isAdmin ? <SettingsPage /> : <AccessDenied />} />
              <Route path="/gateway" element={isAdmin ? <GatewaysPage /> : <AccessDenied />} />
              <Route path="/usuarios/*" element={isAdmin ? <UserManagement /> : <AccessDenied />} />
              <Route path="/plantillas/*" element={isSuperAdmin ? <TemplatesPage /> : <AccessDenied />} />
              <Route path="*" element={<Navigate to={ROUTES.panel} replace />} />
            </Routes>
          </div>
          <AppBottomLog />
        </main>
      </div>
      </DeviceWidgetPickerProvider>
    </AppLogProvider>
  );
}

function App() {
  return <AppShell />;
}

const AccessDenied = () => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '60vh',
      gap: '1rem',
      color: 'var(--text-secondary)',
    }}
  >
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
    <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>Acceso restringido</h2>
    <p style={{ margin: 0 }}>No tienes permisos para ver esta sección.</p>
  </div>
);

export default App;
