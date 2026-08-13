import React, { useState } from 'react';
import { LogOut, Save, Server, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  getMobileServerOrigin,
  normalizeServerOriginInput,
  setMobileServerOrigin,
} from '../utils/mobilePlatform';
import './MobileSettings.css';

export default function MobileSettings() {
  const { user, userProfile, logout } = useAuth();
  const profile = userProfile || user;
  const [serverOrigin, setServerOrigin] = useState(() => getMobileServerOrigin());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSaveServer = () => {
    setError('');
    const norm = normalizeServerOriginInput(serverOrigin);
    if (!norm) {
      setError('URL de servidor no válida.');
      return;
    }
    setMobileServerOrigin(norm);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  const handleLogout = () => {
    logout();
  };

  return (
    <div className="mobile-settings">
      <h2>Ajustes</h2>

      <section className="mobile-settings__card">
        <h3>
          <User size={18} aria-hidden /> Cuenta
        </h3>
        <p className="mobile-settings__email">{profile?.email || '—'}</p>
        {profile?.profileName ? <p className="mobile-settings__meta">{profile.profileName}</p> : null}
        {profile?.role ? <p className="mobile-settings__meta">Rol: {profile.role}</p> : null}
      </section>

      <section className="mobile-settings__card">
        <h3>
          <Server size={18} aria-hidden /> Servidor SYSCOM
        </h3>
        <input
          type="url"
          value={serverOrigin}
          onChange={(ev) => setServerOrigin(ev.target.value)}
          placeholder="https://iot.empresa.com"
        />
        {error ? <p className="mobile-settings__error">{error}</p> : null}
        {saved ? <p className="mobile-settings__ok">Servidor guardado. Vuelva a iniciar sesión si cambió la URL.</p> : null}
        <button type="button" className="mobile-settings__save" onClick={handleSaveServer}>
          <Save size={18} aria-hidden /> Guardar servidor
        </button>
      </section>

      <button type="button" className="mobile-settings__logout" onClick={handleLogout}>
        <LogOut size={18} aria-hidden /> Cerrar sesión
      </button>
    </div>
  );
}
