import React, { useState } from 'react';
import { Lock, LogIn, Mail, Server, Wifi } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  getMobileServerOrigin,
  normalizeServerOriginInput,
  setMobileServerOrigin,
} from '../utils/mobilePlatform';
import './MobileLogin.css';

export default function MobileLogin() {
  const { loginAsUser, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverOrigin, setServerOrigin] = useState(() => getMobileServerOrigin());
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const normOrigin = normalizeServerOriginInput(serverOrigin);
    if (!normOrigin) {
      setError('Indique la URL de su servidor SYSCOM IoT (ej. https://iot.empresa.com).');
      return;
    }
    if (!String(email).trim() || !password) {
      setError('Correo y contraseña requeridos.');
      return;
    }
    setMobileServerOrigin(normOrigin);
    setSubmitting(true);
    try {
      await loginAsUser(email.trim().toLowerCase(), password);
    } catch (err) {
      setError(err?.message || 'No se pudo iniciar sesión. Revise servidor, correo y contraseña.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mobile-login">
      <div className="mobile-login__hero">
        <div className="mobile-login__logo-wrap">
          <img src="/syscom-iot-logo.png" alt="SYSCOM IoT" className="mobile-login__logo" />
        </div>
        <h1>SYSCOM IoT</h1>
        <p>Monitoreo y control en tu dispositivo</p>
      </div>

      <form className="mobile-login__form" onSubmit={handleSubmit}>
        <label className="mobile-login__field">
          <span className="mobile-login__label">
            <Server size={16} aria-hidden /> Servidor
          </span>
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://iot.empresa.com"
            value={serverOrigin}
            onChange={(ev) => setServerOrigin(ev.target.value)}
            disabled={submitting || loading}
          />
        </label>

        <label className="mobile-login__field">
          <span className="mobile-login__label">
            <Mail size={16} aria-hidden /> Correo
          </span>
          <input
            type="email"
            autoComplete="username email"
            placeholder="usuario@empresa.com"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            disabled={submitting || loading}
          />
        </label>

        <label className="mobile-login__field">
          <span className="mobile-login__label">
            <Lock size={16} aria-hidden /> Contraseña
          </span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            disabled={submitting || loading}
          />
        </label>

        {error ? (
          <p className="mobile-login__error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="mobile-login__submit" disabled={submitting || loading}>
          <LogIn size={20} aria-hidden />
          {submitting ? 'Entrando…' : 'Iniciar sesión'}
        </button>

        <p className="mobile-login__hint">
          <Wifi size={14} aria-hidden /> Use la misma URL donde accede al panel web de SYSCOM IoT.
        </p>
      </form>
    </div>
  );
}
