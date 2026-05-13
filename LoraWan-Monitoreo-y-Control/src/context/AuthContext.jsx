import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import {
  localLogin,
  localLogout,
  getMe,
  isTokenValid,
  getLocalUser,
  checkSetup,
  completeFirstPassword as submitFirstPassword,
  refreshSession,
  applySessionToken,
} from '../services/localAuth';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  /** Compatibilidad con páginas que aún pasan credentials a la API (ya no se usan). */
  const [credentials] = useState({ clientId: '', clientSecret: '', serverAddress: '' });

  const [token, setToken] = useState(null);

  useEffect(() => {
    const restoreSession = async () => {
      /**
       * Primero consultar si hace falta bootstrap (tabla `users` vacía → formulario de primer superadmin).
       * Si ya hay algún usuario, el servidor devuelve needsSetup: false y se muestra el login habitual.
       */
      let needsBootstrap = false;
      try {
        const status = await checkSetup();
        needsBootstrap = Boolean(status.needsSetup);
        setNeedsSetup(needsBootstrap);
      } catch (e) {
        console.warn('Server not reachable:', e.message);
        setNeedsSetup(false);
      }

      if (needsBootstrap) {
        localLogout();
        setToken(null);
        setUser(null);
        setUserProfile(null);
        setLoading(false);
        return;
      }

      if (!isTokenValid() && localStorage.getItem('local_token')) {
        try {
          await refreshSession();
        } catch {
          /* JWT caducado fuera de gracia o inválido */
        }
      }
      if (isTokenValid()) {
        const stored = localStorage.getItem('local_token');
        setToken(stored);
        const localUser = getLocalUser();
        setUser(localUser);
        setUserProfile(localUser);
        try {
          const profile = await getMe();
          setUserProfile(profile);
        } catch (e) {
          if (e?.status === 401) {
            localLogout();
            setToken(null);
            setUser(null);
            setUserProfile(null);
          } else {
            console.warn('Could not refresh profile:', e.message);
          }
        }
      }
      setLoading(false);
    };
    restoreSession();
  }, []);

  /** Sincronizar estado React cuando axios u otro código renueva el token en localStorage. */
  useEffect(() => {
    const onRefreshed = (e) => {
      const nt = e?.detail?.token;
      if (typeof nt === 'string' && nt) setToken(nt);
    };
    window.addEventListener('syscom-token-refreshed', onRefreshed);
    return () => window.removeEventListener('syscom-token-refreshed', onRefreshed);
  }, []);

  /** Renovación periódica para pantallas 24/7 (el JWT sigue siendo el control de acceso; el servidor LNS no depende de esto). */
  useEffect(() => {
    if (!token) return undefined;
    const tick = async () => {
      try {
        const data = await refreshSession();
        if (data?.token) setToken(data.token);
        if (data?.user) {
          setUser(data.user);
          setUserProfile(data.user);
        }
        try {
          const profile = await getMe();
          setUserProfile(profile);
        } catch {
          /* ok */
        }
      } catch (e) {
        console.warn('[AuthContext] refresh periódico:', e?.message || e);
      }
    };
    const sixHours = 6 * 60 * 60 * 1000;
    const id = setInterval(tick, sixHours);
    return () => clearInterval(id);
  }, [token]);

  /** Tras F5, `userProfile` puede llegar un tick después; el JWT en `user` ya trae `role`. */
  const r = userProfile?.role ?? user?.role;
  const isSuperAdmin = r === 'superadmin';
  /** Personal con panel de gestión (super admin o admin). */
  const isAdmin = r === 'superadmin' || r === 'admin';
  /** Cuenta solo lectura / dispositivos asignados (incluye legado `viewer`). */
  const isViewer = r === 'user' || r === 'viewer';
  /** Super admin o admin: pueden editar widgets del panel y del dashboard por dispositivo. */
  const canEditDashboard = isAdmin;
  /** Solo super admin: alta de dispositivos en el sistema. */
  const canCreateDevices = isSuperAdmin;

  const adoptSessionToken = useCallback(async (newToken) => {
    applySessionToken(newToken);
    setToken(newToken);
    const localUser = getLocalUser();
    setUser(localUser);
    setUserProfile(localUser);
    try {
      const profile = await getMe();
      setUserProfile(profile);
    } catch {
      /* ok */
    }
  }, []);

  const loginWithEmail = async (email, password) => {
    const data = await localLogin(email, password);
    setToken(data.token);
    setUser(data.user);
    setUserProfile(data.user);
    try {
      const profile = await getMe();
      setUserProfile(profile);
    } catch {
      /* ok */
    }
    return data;
  };

  const loginAsUser = async (email, password) => {
    const data = await localLogin(email, password);
    if (data.user.role === 'admin' || data.user.role === 'superadmin') {
      localLogout();
      setToken(null);
      throw Object.assign(
        new Error('Este correo es de administrador. Use el acceso de Administrador (no el de Usuario).'),
        { code: 'auth/is-admin' }
      );
    }
    setToken(data.token);
    setUser(data.user);
    setUserProfile(data.user);
    try {
      const profile = await getMe();
      setUserProfile(profile);
    } catch {
      /* ok */
    }
    return data;
  };

  const completeFirstPassword = async (newPassword) => {
    const data = await submitFirstPassword(newPassword);
    setToken(data.token);
    setUser(data.user);
    setUserProfile(data.user);
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

  const reAuthenticate = async () => {
    return null;
  };

  /** Tras cambiar perfil en servidor (p. ej. nombre): renueva JWT y estado en memoria. */
  const resyncSession = useCallback(async () => {
    try {
      const data = await refreshSession();
      if (data?.token) setToken(data.token);
      if (data?.user) {
        setUser(data.user);
        setUserProfile(data.user);
      }
    } catch (e) {
      console.warn('[AuthContext] resyncSession:', e?.message || e);
    }
  }, []);

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
        loginWithEmail,
        loginAsUser,
        adoptSessionToken,
        completeFirstPassword,
        logout,
        credentials,
        saveCredentials,
        token,
        setToken,
        reAuthenticate,
        resyncSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
