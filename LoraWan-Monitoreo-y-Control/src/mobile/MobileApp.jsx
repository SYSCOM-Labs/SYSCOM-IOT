import React, { useCallback, useEffect, useState } from 'react';
import { Info, LayoutGrid, Loader, Settings } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import FirstPasswordChange from '../components/FirstPasswordChange';
import SyscomRealtimeBridge from '../components/SyscomRealtimeBridge';
import { isCapacitorNative } from '../utils/mobilePlatform';
import MobileLogin from './MobileLogin';
import MobileDeviceList from './MobileDeviceList';
import MobileDeviceView from './MobileDeviceView';
import MobileAbout from './MobileAbout';
import MobileSettings from './MobileSettings';
import './mobile.css';

const TABS = [
  { id: 'devices', label: 'Dispositivos', icon: LayoutGrid },
  { id: 'info', label: 'Info', icon: Info },
  { id: 'settings', label: 'Ajustes', icon: Settings },
];

export default function MobileApp() {
  const { user, userProfile, loading, token, needsSetup } = useAuth();
  const [tab, setTab] = useState('devices');
  const [selectedDevice, setSelectedDevice] = useState(null);
  const backListenerRef = React.useRef(null);

  const mustChangePassword = Boolean(
    (userProfile && userProfile.mustChangePassword) || (user && user.mustChangePassword)
  );

  useEffect(() => {
    if (!isCapacitorNative()) return undefined;
    const StatusBar = window.Capacitor?.Plugins?.StatusBar;
    if (!StatusBar?.setStyle) return undefined;
    StatusBar.setStyle({ style: 'DARK' }).catch(() => {});
    StatusBar.setBackgroundColor?.({ color: '#0f172a' }).catch(() => {});
    return undefined;
  }, []);

  useEffect(() => {
    if (!isCapacitorNative()) return undefined;
    const App = window.Capacitor?.Plugins?.App;
    if (!App?.addListener) return undefined;
    let handle;
    App.addListener('backButton', ({ canGoBack }) => {
      if (selectedDevice) {
        setSelectedDevice(null);
        return;
      }
      if (canGoBack) {
        window.history.back();
      } else {
        App.minimizeApp?.();
      }
    }).then((h) => {
      handle = h;
      backListenerRef.current = h;
    }).catch(() => {});
    return () => {
      handle?.remove?.();
      backListenerRef.current?.remove?.();
      backListenerRef.current = null;
    };
  }, [selectedDevice]);

  const handleOpenDevice = useCallback((device) => {
    setSelectedDevice(device);
  }, []);

  const handleBackFromDevice = useCallback(() => {
    setSelectedDevice(null);
  }, []);

  if (loading) {
    return (
      <div className="mobile-app mobile-app--loading">
        <Loader size={32} className="mobile-spin" aria-hidden />
        <span>Cargando…</span>
      </div>
    );
  }

  if (needsSetup) {
    return (
      <div className="mobile-app mobile-app--loading">
        <p>El servidor aún no está configurado. Use la consola web para el primer registro.</p>
      </div>
    );
  }

  if (!user || !token) {
    return <MobileLogin />;
  }

  if (mustChangePassword) {
    return (
      <div className="mobile-app mobile-app--first-password">
        <FirstPasswordChange />
      </div>
    );
  }

  return (
    <div className="mobile-app">
      <SyscomRealtimeBridge />
      <main className="mobile-app__main">
        {tab === 'devices' && !selectedDevice ? <MobileDeviceList onOpenDevice={handleOpenDevice} /> : null}
        {tab === 'info' ? <MobileAbout /> : null}
        {tab === 'settings' ? <MobileSettings /> : null}
      </main>

      {!selectedDevice ? (
        <nav className="mobile-app__nav" aria-label="Navegación principal">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'is-active' : ''}
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
            >
              <Icon size={22} strokeWidth={tab === id ? 2.4 : 2} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {selectedDevice ? <MobileDeviceView device={selectedDevice} onBack={handleBackFromDevice} /> : null}
    </div>
  );
}
