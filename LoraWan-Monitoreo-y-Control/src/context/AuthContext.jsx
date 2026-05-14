import React, { createContext, useState, useContext, useEffect, useCallback, useMemo } from 'react';
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
  startImpersonationSession,
  stopImpersonationSession,
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

  const nav = useMemo(() => {
    const a = userProfile?.nav;
    const b = user?.nav;
    const fromProfile = a && typeof a === 'object' ? a : {};
    const fromUser = b && typeof b === 'object' ? b : {};
    return { ...fromUser, ...fromProfile };
  }, [userProfile?.nav, user?.nav]);

  const hasNavPage = useCallback(
    (pageId) => {
      if (isSuperAdmin) return true;
      return Boolean(nav[String(pageId)]);
    },
    [isSuperAdmin, nav]
  );

  /** Compat: algún módulo de gestión (menús «admin» heredados). */
  const isAdmin =
    isSuperAdmin ||
    ['Users', 'Gateway', 'Automations', 'Settings', 'Templates'].some((k) => Boolean(nav[k]));
  /** Cuenta solo lectura / dispositivos asignados (incluye legado `viewer`). */
  const isViewer = r === 'user' || r === 'viewer';
  /** Edición de widgets: módulo Dispositivos o superadmin. */
  const canEditDashboard = isSuperAdmin || Boolean(nav.Devices);
  /** Solo super admin: alta de dispositivos en el sistema. */
  const canCreateDevices = isSuperAdmin;

  const isImpersonating = Boolean(
    userProfile?.impersonation?.actorId || user?.impersonatorId
  );

  const enterImpersonation = useCallback(async (targetUserId) => {
    const data = await startImpersonationSession(targetUserId);
    applySessionToken(data.token);
    setToken(data.token);
    const lu = getLocalUser();
    setUser(lu);
    try {
      const profile = await getMe();
      setUserProfile(profile);
    } catch {
      setUserProfile({ ...data.user, impersonation: data.impersonation });
    }
  }, []);

  const exitImpersonation = useCallback(async () => {
    const data = await stopImpersonationSession();
    const tok = data?.token;
    if (!tok || typeof tok !== 'string') {
      throw new Error('El servidor no devolvió una sesión válida. Intente de nuevo o cierre sesión.');
    }
    applySessionToken(tok);
    setToken(tok);
    let lu = getLocalUser();
    if (!lu && data.user && typeof data.user === 'object') {
      lu = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role,
        profileName: data.user.profileName,
        mustChangePassword: Boolean(data.user.mustChangePassword),
        avatarUrl: data.user.avatarUrl,
        nav: data.user.nav && typeof data.user.nav === 'object' ? data.user.nav : {},
      };
    }
    if (!lu) {
      throw new Error('No se pudo aplicar la sesión restaurada. Cierre sesión e inicie de nuevo.');
    }
    setUser(lu);
    const prof = {
      ...(data.user && typeof data.user === 'object' ? data.user : lu),
      impersonation: data.impersonation != null ? data.impersonation : null,
    };
    setUserProfile(prof);
    try {
      const profile = await getMe();
      setUserProfile(profile);
      const lu2 = getLocalUser();
      if (lu2) setUser(lu2);
    } catch {
      /* mantener prof si /me falla */
    }
  }, []);

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
    if (data.user.role === 'superadmin') {
      localLogout();
      setToken(null);
      throw Object.assign(
        new Error('Las cuentas de super administrador deben iniciar sesión por el acceso principal.'),
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
        hasNavPage,
        isViewer,
        canEditDashboard,
        canCreateDevices,
        isImpersonating,
        enterImpersonation,
        exitImpersonation,
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
