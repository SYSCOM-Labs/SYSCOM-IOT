import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { SYSCOM_APP_LOG_EVENT, normalizeAppLogCategory } from '../constants/appLog';

const MAX_LINES = 1200;

/** Evita duplicar el mensaje inicial en React StrictMode (doble montaje en desarrollo). */
let appLogBootMessageSent = false;

const AppLogContext = createContext(null);

function formatErrMessage(ev) {
  if (ev?.message) return String(ev.message);
  return 'Error en la ventana';
}

function formatRejectionMessage(ev) {
  const r = ev?.reason;
  if (r instanceof Error) return r.message || String(r);
  if (typeof r === 'string') return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}

export function AppLogProvider({ children }) {
  const [logs, setLogs] = useState([]);

  const push = useCallback((level, message, opts = {}) => {
    const category = normalizeAppLogCategory(opts.category);
    const rawData = opts.data;
    let data = rawData;
    if (rawData !== undefined && rawData !== null && typeof rawData === 'object') {
      try {
        const s = JSON.stringify(rawData);
        if (s.length > 24000) {
          data = { _truncated: true, preview: `${s.slice(0, 20000)}…` };
        }
      } catch {
        data = { _error: 'No serializable' };
      }
    }
    const line = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      ts: Date.now(),
      level: level === 'warn' || level === 'error' ? level : 'info',
      message: String(message ?? ''),
      category,
      data,
    };
    setLogs((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  useEffect(() => {
    const onCustom = (e) => {
      const d = e.detail || {};
      push(d.level, d.message, { category: d.category, data: d.data });
    };
    window.addEventListener(SYSCOM_APP_LOG_EVENT, onCustom);
    const onErr = (ev) => push('error', formatErrMessage(ev), { category: 'system' });
    const onRej = (ev) =>
      push('error', `Promesa no manejada: ${formatRejectionMessage(ev)}`, { category: 'system' });
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener(SYSCOM_APP_LOG_EVENT, onCustom);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [push]);

  useEffect(() => {
    if (appLogBootMessageSent) return;
    appLogBootMessageSent = true;
    push('info', 'Registro de actividad: filtros por categoría, búsqueda y clic en una línea para ver JSON completo.', {
      category: 'system',
    });
  }, [push]);

  const value = useMemo(() => ({ logs, push, clear }), [logs, push, clear]);
  return <AppLogContext.Provider value={value}>{children}</AppLogContext.Provider>;
}

export function useAppLog() {
  const ctx = useContext(AppLogContext);
  if (!ctx) {
    throw new Error('useAppLog debe usarse dentro de AppLogProvider');
  }
  return ctx;
}
