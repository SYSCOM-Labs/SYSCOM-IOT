import React, { createContext, useState, useContext, useEffect } from 'react';
import {
  localLogin,
  localLogout,
  googleCallback,
  getMe,
  isTokenValid,
  getLocalUser,
  checkSetup,
  completeFirstPassword as submitFirstPassword,
  debugImpersonate as apiDebugImpersonate,
  refreshSession,
} from '../services/localAuth';
import { fixUtf8Mojibake } from '../utils/fixUtf8Mojibake';

const AuthContext = createContext(null);

/** Corrige nombres con mojibake UTF-8 (p. ej. tras JWT antiguo en localStorage). */
function normalizeAuthUser(u) {
  if (!u || typeof u !== 'object') return u;
  if (u.profileName == null || u.profileName === '') return u;
  const profileName = fixUtf8Mojibake(String(u.profileName));
  if (profileName === u.profileName) return u;
  return { ...u, profileName };
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authError, setAuthError] = useState(null);

  /** Compatibilidad con páginas que aún pasan credentials a la API (ya no se usan). */
  const [credentials] = useState({ clientId: '', clientSecret: '', serverAddress: '' });

  const [token, setToken] = useState(null);

  const [refreshInterval, setRefreshInterval] = useState(() => {
    try {
      return parseInt(localStorage.getItem('refresh_interval') || '5000');
    } catch {
      return 5000;
    }
  });

  useEffect(() => {
    const restoreSession = async () => {
      // Detectar retorno del flujo redirect de Google OAuth (?code=...)
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        window.history.replaceState({}, '', window.location.pathname);
        try {
          const data = await googleCallback(code);
          setToken(data.token);
          setUser(normalizeAuthUser(data.user));
          setUserProfile(normalizeAuthUser(data.user));
          try {
            setUserProfile(normalizeAuthUser(await getMe()));
          } catch {
            /* ok */
          }
        } catch (e) {
          console.error('[Google OAuth] Error al procesar el código:', e.message);
          setAuthError(e.message || 'Error al iniciar sesión con Google. Intenta de nuevo.');
        }
        setLoading(false);
        return;
      }

      const stored = localStorage.getItem('local_token');
      if (stored && !isTokenValid()) {
        try {
          await refreshSession();
        } catch (e) {
          const payload = getLocalUser();
          if (e?.code !== 'MUST_CHANGE_PASSWORD' || !payload?.mustChangePassword) {
            localLogout();
          }
        }
      }

      const still = localStorage.getItem('local_token');
      const jwtPayload = getLocalUser();
      if (still && (isTokenValid() || jwtPayload?.mustChangePassword)) {
        setToken(still);
        setUser(normalizeAuthUser(jwtPayload));
        setUserProfile(normalizeAuthUser(jwtPayload));
        if (isTokenValid()) {
          try {
            const profile = await getMe();
            setUserProfile(normalizeAuthUser(profile));
          } catch (e) {
            console.warn('Could not refresh profile:', e.message);
          }
        }
      } else {
        try {
          const status = await checkSetup();
          setNeedsSetup(status.needsSetup);
        } catch (e) {
          console.warn('Server not reachable:', e.message);
        }
      }
      setLoading(false);
    };
    restoreSession();
  }, []);

  useEffect(() => {
    const onRefreshed = (e) => {
      const t = e.detail?.token;
      if (typeof t === 'string' && t) setToken(t);
    };
    window.addEventListener('syscom-token-refreshed', onRefreshed);
    return () => window.removeEventListener('syscom-token-refreshed', onRefreshed);
  }, []);

  /** Renovar JWT periódicamente (kiosco / JWT corto en servidor). */
  useEffect(() => {
    if (!token) return undefined;
    const sixHours = 6 * 60 * 60 * 1000;
    const id = window.setInterval(() => {
      refreshSession().catch(() => {});
    }, sixHours);
    return () => window.clearInterval(id);
  }, [token]);

  const r = userProfile?.role;
  const isSuperAdmin = r === 'superadmin';
  /** Personal con panel de gestión (super admin o admin). */
  const isAdmin = r === 'superadmin' || r === 'admin';
  /** Cuenta solo lectura / dispositivos asignados (incluye legado `viewer`). */
  const isViewer = r === 'user' || r === 'viewer';
  /** Super admin o admin: pueden editar widgets del panel y del dashboard por dispositivo. */
  const canEditDashboard = isAdmin;
  /** Solo super admin: alta de dispositivos en el sistema. */
  const canCreateDevices = isSuperAdmin;

  const loginWithEmail = async (email, password) => {
    const data = await localLogin(email, password);
    setToken(data.token);
    setUser(normalizeAuthUser(data.user));
    setUserProfile(normalizeAuthUser(data.user));
    try {
      const profile = await getMe();
      setUserProfile(normalizeAuthUser(profile));
    } catch {
      /* ok */
    }
    return data;
  };

  // loginWithGoogle no se usa en el flujo redirect — el código se maneja en restoreSession al cargar la app.
  const loginWithGoogle = null;

  const completeFirstPassword = async (newPassword) => {
    const data = await submitFirstPassword(newPassword);
    setToken(data.token);
    setUser(normalizeAuthUser(data.user));
    setUserProfile(normalizeAuthUser(data.user));
    return data;
  };

  /** Solo localhost: suplantar otro usuario (requiere API en la misma máquina). */
  const loginAsDebugUser = async (userId) => {
    const data = await apiDebugImpersonate(userId);
    setToken(data.token);
    setUser(normalizeAuthUser(data.user));
    setUserProfile(normalizeAuthUser(data.user));
    try {
      setUserProfile(normalizeAuthUser(await getMe()));
    } catch {
      /* ok */
    }
    return data;
  };

  const logout = () => {
    localLogout();
    setUser(null);
    setUserProfile(null);
    setToken(null);
    localStorage.removeItem('milesight_token');
    localStorage.removeItem('milesight_creds');
  };

  const saveCredentials = () => {};

  const updateRefreshInterval = (val) => {
    setRefreshInterval(val);
    localStorage.setItem('refresh_interval', val.toString());
  };

  const reAuthenticate = async () => {
    return null;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        userProfile,
        loading,
        isAdmin,
        isSuperAdmin,
        isViewer,
        canEditDashboard,
        canCreateDevices,
        needsSetup,
        setNeedsSetup,
        authError,
        setAuthError,
        loginWithEmail,
        loginWithGoogle,
        completeFirstPassword,
        loginAsDebugUser,
        logout,
        credentials,
        saveCredentials,
        token,
        setToken,
        reAuthenticate,
        refreshInterval,
        updateRefreshInterval,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
