import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createAdmin } from '../services/localAuth';
import { useGoogleLogin } from '@react-oauth/google';
import { Mail, UserPlus } from 'lucide-react';
import './Login.css';

const GOOGLE_REDIRECT_URI = import.meta.env.VITE_GOOGLE_REDIRECT_URI || window.location.origin;

const Login = () => {
  const { needsSetup, setNeedsSetup, authError, setAuthError } = useAuth();

  const startGoogleLogin = useGoogleLogin({
    flow: 'auth-code',
    ux_mode: 'redirect',
    redirect_uri: GOOGLE_REDIRECT_URI,
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [setupEmail, setSetupEmail] = useState('');
  const [setupName, setSetupName] = useState('');

  const resetError = () => setError('');

  // ── Setup inicial (primer superadmin) ────────────────────────
  const handleSetup = async (e) => {
    e.preventDefault();
    if (!setupEmail) { setError('El correo es obligatorio.'); return; }
    setLoading(true);
    resetError();
    try {
      await createAdmin(setupEmail, setupName);
      setNeedsSetup(false);
    } catch (err) {
      const msg = err.response?.data?.errMsg || err.response?.data?.error || err.message || '';
      setError(msg.includes('ya está registrado') ? 'Ese correo ya está registrado.' : msg || err.message);
    } finally {
      setLoading(false);
    }
  };

  if (needsSetup) {
    return (
      <div className="login-overlay login-overlay--premium">
        <div className="login-card login-card--premium glass card" style={{ maxWidth: '500px' }}>
          <div className="login-header">
            <div className="role-pill admin">
              <UserPlus size={14} /> Configuración inicial
            </div>
            <h2>Crear super administrador</h2>
            <p>
              Registra el correo de Google del primer administrador. Podrá gestionar dispositivos, usuarios y toda la
              configuración de la plataforma.
            </p>
          </div>
          <form onSubmit={handleSetup} className="login-form">
            <div className="form-group">
              <label><Mail size={14} /> Correo electrónico (cuenta Google)</label>
              <input
                type="email"
                className="glass"
                value={setupEmail}
                onChange={(e) => setSetupEmail(e.target.value)}
                required
                autoFocus
                placeholder="admin@ejemplo.com"
              />
            </div>
            <div className="form-group">
              <label>Nombre</label>
              <input
                type="text"
                className="glass"
                value={setupName}
                onChange={(e) => setSetupName(e.target.value)}
                placeholder="Nombre o empresa"
              />
            </div>
            {error && <div className="error-message">{error}</div>}
            <button type="submit" className="btn btn-primary full-width" disabled={loading}>
              {loading ? 'Creando...' : 'Crear cuenta y continuar'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Login principal ──────────────────────────────────────────
  return (
    <div className="login-overlay login-overlay--premium">
      <div className="login-card login-card--premium glass card">
        <div className="login-header">
          <h2>SYSCOM IoT</h2>
          <p>Inicia sesión para continuar</p>
        </div>

        {authError && (
          <div className="error-message" style={{ cursor: 'pointer' }} onClick={() => setAuthError(null)}>
            {authError}
          </div>
        )}

        <div className="social-login">
          <button
            type="button"
            className="btn btn-google full-width"
            onClick={() => { setAuthError(null); startGoogleLogin(); }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continuar con Google
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;
