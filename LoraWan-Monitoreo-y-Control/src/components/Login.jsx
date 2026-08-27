import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { createAdmin, checkEmailRegistered, checkSetup } from '../services/localAuth';
import { validatePasswordStrength, PASSWORD_POLICY_HINT, isPasswordPolicySatisfied } from '../utils/passwordPolicy';
import { Bot, CloudUpload, LineChart, Lock, LogIn, Mail, ShieldCheck, UserPlus, AlertTriangle } from 'lucide-react';
import { getDuplicateEntityNotice } from '../utils/duplicateEntityNotice';
import './Login.css';

const HERO_FEATURES = [
  { icon: LineChart, text: 'Analítica en tiempo real' },
  { icon: ShieldCheck, text: 'Seguridad de extremo a extremo' },
  { icon: CloudUpload, text: 'Sincronización multi-nube' },
  { icon: Bot, text: 'Automatización inteligente' },
];
const LOGO_STORAGE_KEY = 'syscom_iot_logo';
const LOGO_CHANGED_EVENT = 'syscom-custom-logo-changed';

function seeded01(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function LoginNetwork({ pointCount }) {
  const [points, setPoints] = useState(() =>
    Array.from({ length: pointCount }).map((_, idx) => {
      const xr = seeded01(idx + 1);
      const yr = seeded01((idx + 1) * 17);
      const vxr = seeded01((idx + 1) * 31);
      const vyr = seeded01((idx + 1) * 47);
      return {
        x: 5 + xr * 90,
        y: 6 + yr * 88,
        vx: (vxr - 0.5) * 0.22,
        vy: (vyr - 0.5) * 0.22,
        phase: seeded01((idx + 1) * 73),
      };
    })
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setPoints((prev) =>
        prev.map((p) => {
          let nx = p.x + p.vx;
          let ny = p.y + p.vy;
          let nvx = p.vx;
          let nvy = p.vy;
          if (nx < 2 || nx > 98) {
            nvx = -nvx;
            nx = Math.min(98, Math.max(2, nx));
          }
          if (ny < 2 || ny > 98) {
            nvy = -nvy;
            ny = Math.min(98, Math.max(2, ny));
          }
          return { ...p, x: nx, y: ny, vx: nvx, vy: nvy };
        })
      );
    }, 40);
    return () => window.clearInterval(id);
  }, []);

  const lines = useMemo(() => {
    const MAX_NEIGHBORS = 4;
    const MAX_DISTANCE = 21;
    const edges = [];
    const seen = new Set();
    for (let i = 0; i < points.length; i += 1) {
      const nearest = [];
      for (let j = 0; j < points.length; j += 1) {
        if (i === j) continue;
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist <= MAX_DISTANCE) nearest.push({ j, dist });
      }
      nearest.sort((a, b) => a.dist - b.dist);
      nearest.slice(0, MAX_NEIGHBORS).forEach(({ j, dist }) => {
        const a = Math.min(i, j);
        const b = Math.max(i, j);
        const key = `${a}-${b}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({
          a,
          b,
          key,
          alpha: Math.max(0.1, 1 - dist / MAX_DISTANCE),
          delay: `${((i + j) % 7) * 0.35}s`,
        });
      });
    }
    return edges;
  }, [points]);

  return (
    <div className="login-network" aria-hidden="true">
      <svg className="network-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {lines.map((line) => (
          <line
            key={line.key}
            x1={points[line.a].x}
            y1={points[line.a].y}
            x2={points[line.b].x}
            y2={points[line.b].y}
            className="network-line"
            style={{ opacity: line.alpha, animationDelay: line.delay }}
          />
        ))}
      </svg>
      {points.map((point, idx) => (
        <span
          key={idx}
          className="network-node"
          style={{
            left: `${point.x}%`,
            top: `${point.y}%`,
            animationDelay: `${point.phase * 1.6}s`,
          }}
        />
      ))}
    </div>
  );
}

const Login = () => {
  const { loginWithEmail, needsSetup, setNeedsSetup } = useAuth();
  const { t } = useLanguage();
  const [customLogo, setCustomLogo] = useState(() => localStorage.getItem(LOGO_STORAGE_KEY) || null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [setupEmail, setSetupEmail] = useState('');
  const [setupName, setSetupName] = useState('');
  const [setupPass, setSetupPass] = useState('');
  const [setupPass2, setSetupPass2] = useState('');
  /** Aviso estructurado si el correo del setup inicial ya existe (409). */
  const [setupDuplicate, setSetupDuplicate] = useState(null);

  const setupPwPolicyOk = useMemo(() => isPasswordPolicySatisfied(setupPass), [setupPass]);
  /** Borde rojo si ya escribió y no cumple política; verde si cumple; neutro si vacío. */
  const setupPw1BorderClass = useMemo(() => {
    if (!setupPass) return '';
    return setupPwPolicyOk ? 'input-border--valid' : 'input-border--invalid';
  }, [setupPass, setupPwPolicyOk]);
  /** Confirmación: rojo si falta o no coincide cuando la principal ya es válida, o si escribió y la principal no es válida; verde solo si ambas coinciden y la política se cumple. */
  const setupPw2BorderClass = useMemo(() => {
    if (!setupPass2) {
      if (setupPwPolicyOk) return 'input-border--invalid';
      return '';
    }
    if (setupPwPolicyOk && setupPass === setupPass2) return 'input-border--valid';
    return 'input-border--invalid';
  }, [setupPass, setupPass2, setupPwPolicyOk]);

  useEffect(() => {
    const syncLogo = () => {
      setCustomLogo(localStorage.getItem(LOGO_STORAGE_KEY) || null);
    };
    window.addEventListener(LOGO_CHANGED_EVENT, syncLogo);
    return () => window.removeEventListener(LOGO_CHANGED_EVENT, syncLogo);
  }, []);

  /**
   * Revalidar bootstrap: si la tabla `users` está vacía, el API devuelve needsSetup y se muestra el formulario
   * de primer superadmin (corrige fallos transitorios de red en el primer fetch del AuthContext).
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await checkSetup();
        if (cancelled) return;
        if (status.needsSetup) setNeedsSetup(true);
      } catch {
        /* sin acción: el usuario puede recargar cuando el API esté arriba */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setNeedsSetup]);

  const resetError = () => {
    setError('');
    setSetupDuplicate(null);
  };

  const handleSetup = async (e) => {
    e.preventDefault();
    if (setupPass !== setupPass2) {
      setSetupDuplicate(null);
      setError('Las contraseñas no coinciden.');
      return;
    }
    const pv = validatePasswordStrength(setupPass);
    if (!pv.ok) {
      setSetupDuplicate(null);
      setError(pv.error);
      return;
    }
    setLoading(true);
    resetError();
    try {
      await createAdmin(setupEmail, setupPass, setupName);
      setNeedsSetup(false);
    } catch (err) {
      const msg =
        err.response?.data?.errMsg || err.response?.data?.error || err.message || '';
      if (err.code === 'USER_EXISTS' || err.message?.includes('ya está registrado')) {
        setSetupDuplicate(getDuplicateEntityNotice('USER_EXISTS', { userAction: 'create' }));
        setError('');
      } else {
        setSetupDuplicate(null);
        setError(msg || err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    const norm = String(email || '').trim().toLowerCase();
    if (!norm) {
      setError('Ingresa tu correo electrónico.');
      return;
    }
    if (!password) {
      setError('Ingresa tu contraseña.');
      return;
    }
    setLoading(true);
    resetError();
    try {
      const r = await checkEmailRegistered(norm);
      if (!r.exists) {
        setError('No hay una cuenta registrada con ese correo. Verifica el texto o solicita acceso a un administrador.');
        return;
      }
      await loginWithEmail(norm, String(password).trim());
    } catch (err) {
      if (err.code === 'auth/is-admin') {
        setError(
          'Esta cuenta de super administrador no puede usar el acceso restringido. Use el inicio de sesión principal.'
        );
      } else if (err.message?.includes('incorrectos')) {
        setError(
          'Esa cuenta existe, pero la contraseña no coincide. Un administrador debe restablecerla en Usuarios (clave temporal, por ejemplo 123456).'
        );
      } else {
        setError(err.message || 'Error al iniciar sesión.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (needsSetup) {
    return (
      <div className="login-screen">
        <LoginNetwork pointCount={40} />
        <div className="login-shell">
          <aside className="login-hero">
            <div className="login-logo-row">
              {customLogo ? (
                <img src={customLogo} alt="Logo" className="login-logo-img" />
              ) : (
                <div className="login-brand-default">
                  <img src="/syscom-iot-logo.png" alt="" className="login-logo-img login-logo-img--default" />
                  <span className="login-logo-text login-logo-text--brand">{t('brand.name')}</span>
                </div>
              )}
            </div>
            <div className="login-badge">Plataforma de conectividad inteligente</div>
            <h1>
              Gestiona el <span>ecosistema</span> de tus dispositivos
            </h1>
            <p>
              Monitoreo en tiempo real, automatización y análisis para IoT en una experiencia unificada y segura.
            </p>
            <div className="login-feature-list">
              {HERO_FEATURES.map((item) => (
                <div key={item.text} className="login-feature-item">
                  <item.icon size={18} />
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </aside>
          <section className="login-pane">
            <div className="login-pane-head">
              <div className="role-pill admin">
                <UserPlus size={14} /> Configuración inicial
              </div>
              <h2>Crear super administrador</h2>
              <p>
                Primera cuenta del sistema (super administrador). Podrá registrar dispositivos, asignarlos y gestionar
                todas las cuentas.
              </p>
            </div>
            <p className="first-pw-policy-hint">{PASSWORD_POLICY_HINT}</p>
            <form onSubmit={handleSetup} className="login-form">
              <div className="form-group">
                <label>
                  <Mail size={14} /> Correo electrónico
                </label>
                <input
                  type="email"
                  className="glass"
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  required
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
              <div className="form-group">
                <label>
                  <Lock size={14} /> Contraseña
                </label>
                <input
                  type="password"
                  className={['glass', setupPw1BorderClass].filter(Boolean).join(' ')}
                  value={setupPass}
                  onChange={(e) => setSetupPass(e.target.value)}
                  required
                  placeholder="Mín. 8 caracteres, mayús., minús. y símbolo"
                  autoComplete="new-password"
                />
              </div>
              <div className="form-group">
                <label>
                  <Lock size={14} /> Confirmar contraseña
                </label>
                <input
                  type="password"
                  className={['glass', setupPw2BorderClass].filter(Boolean).join(' ')}
                  value={setupPass2}
                  onChange={(e) => setSetupPass2(e.target.value)}
                  required
                  placeholder="Repite la contraseña"
                  autoComplete="new-password"
                />
              </div>
              {setupDuplicate && (
                <div className="login-notice login-notice--duplicate" role="status">
                  <AlertTriangle size={22} className="login-notice__icon" aria-hidden />
                  <div className="login-notice__text">
                    <strong>{setupDuplicate.title}</strong>
                    <p>{setupDuplicate.body}</p>
                  </div>
                </div>
              )}
              {error && <div className="error-message">{error}</div>}
              <button type="submit" className="btn btn-primary full-width login-submit-btn" disabled={loading}>
                {loading ? 'Creando...' : 'Crear cuenta y continuar'}
              </button>
            </form>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <LoginNetwork pointCount={48} />
      <div className="login-shell">
        <aside className="login-hero">
          <div className="login-logo-row">
            {customLogo ? (
              <img src={customLogo} alt="Logo" className="login-logo-img" />
            ) : (
              <div className="login-brand-default">
                <img src="/syscom-iot-logo.png" alt="" className="login-logo-img login-logo-img--default" />
                <span className="login-logo-text login-logo-text--brand">{t('brand.name')}</span>
              </div>
            )}
          </div>
          <div className="login-badge">Plataforma de conectividad inteligente</div>
          <h1>
            Gestiona el <span>ecosistema</span> de tus dispositivos
          </h1>
          <p>
            Monitoreo en tiempo real, automatización predictiva y análisis de datos para el Internet de las Cosas.
          </p>
          <div className="login-feature-list">
            {HERO_FEATURES.map((item) => (
              <div key={item.text} className="login-feature-item">
                <item.icon size={18} />
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </aside>
        <section className="login-pane">
          <div className="login-pane-head">
            <div className="role-pill user">
              <Lock size={14} /> Acceso
            </div>
            <h2>Bienvenido de vuelta</h2>
            <p>Introduce el correo y la contraseña de tu cuenta SYSCOM IoT.</p>
          </div>
          <form onSubmit={handleLogin} className="login-form">
            <div className="form-group">
              <label>
                <Mail size={14} /> Correo electrónico
              </label>
              <input
                type="email"
                className="glass"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                placeholder="usuario@ejemplo.com"
              />
            </div>
            <div className="form-group">
              <label>
                <Lock size={14} /> Contraseña
              </label>
              <input
                type="password"
                className="glass"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </div>
            {error ? <div className="error-message">{error}</div> : null}
            <button type="submit" className="btn btn-primary full-width login-submit-btn" disabled={loading}>
              <LogIn size={16} />
              {loading ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default Login;
