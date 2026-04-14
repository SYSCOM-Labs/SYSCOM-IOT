import React, { useState } from 'react';
import { Lock, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { validatePasswordStrength, PASSWORD_POLICY_HINT } from '../utils/passwordPolicy';
import './Login.css';

export default function FirstPasswordChange() {
  const { user, completeFirstPassword, logout } = useAuth();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setErr('');
    if (p1 !== p2) {
      setErr('Las contraseñas no coinciden.');
      return;
    }
    const v = validatePasswordStrength(p1);
    if (!v.ok) {
      setErr(v.error);
      return;
    }
    setLoading(true);
    try {
      await completeFirstPassword(p1);
    } catch (e2) {
      setErr(e2.message || 'No se pudo actualizar la contraseña.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-overlay login-overlay--premium">
      <div className="login-card login-card--premium glass card" style={{ maxWidth: 480 }}>
        <div className="login-header">
          <div className="role-pill admin">
            <Lock size={14} /> Primer acceso
          </div>
          <h2>Defina su contraseña</h2>
          <p>
            Con la cuenta <strong>{user?.email}</strong> debe establecer una contraseña personal que cumpla la política de
            seguridad antes de usar la plataforma.
          </p>
          <p className="first-pw-policy-hint">{PASSWORD_POLICY_HINT}</p>
        </div>
        <form onSubmit={onSubmit} className="login-form">
          <div className="form-group">
            <label>
              <Lock size={14} /> Nueva contraseña
            </label>
            <input
              type="password"
              className="glass"
              value={p1}
              onChange={(e) => setP1(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="Ej. MiClave!8"
            />
          </div>
          <div className="form-group">
            <label>
              <Lock size={14} /> Confirmar contraseña
            </label>
            <input
              type="password"
              className="glass"
              value={p2}
              onChange={(e) => setP2(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          {err ? <div className="error-message">{err}</div> : null}
          <button type="submit" className="btn btn-primary full-width" disabled={loading}>
            {loading ? 'Guardando…' : 'Guardar y continuar'}
          </button>
          <button
            type="button"
            className="btn full-width"
            style={{ marginTop: 12, opacity: 0.85 }}
            onClick={() => logout()}
          >
            <LogOut size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Cerrar sesión
          </button>
        </form>
      </div>
    </div>
  );
}
