import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { getEventsStreamUrl } from '../config/apiBase';
import { SYSCOM_REALTIME_LNS, SYSCOM_REALTIME_TELEMETRY, SYSCOM_SSE_CONNECTED } from '../constants/realtimeEvents';
import { pushAppActivityLog } from '../utils/appActivityLog';
import { scheduleClientEmailWebhookAutomations } from '../services/automationService';
import sseContract from '../../shared/realtime-sse-contract.json';

/**
 * Mantiene EventSource (SSE) con el backend: telemetría y eventos LNS sin polling exclusivo.
 * Downlinks y email de reglas: servidor (`server/automation-runner.js`). Webhook/toast: cliente tras SSE.
 */
export default function SyscomRealtimeBridge() {
  const { token, user, userProfile, credentials, hasNavPage, isSuperAdmin, isDemo } = useAuth();
  const esRef = useRef(null);
  const retryMsRef = useRef(2000);
  const isStaff = Boolean(!isDemo && (isSuperAdmin || hasNavPage('Automations')));
  const automationCtxRef = useRef({
    credentials,
    token,
    auth: { user: userProfile },
    isStaff,
  });
  automationCtxRef.current = {
    credentials,
    token,
    auth: { user: userProfile },
    isStaff,
  };

  useEffect(() => {
    if (!token || !user?.id) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      return undefined;
    }

    let cancelled = false;
    let reconnectTimer;

    const connect = () => {
      if (cancelled) return;
      let lastSseErrLog = 0;
      const url = getEventsStreamUrl(token);
      try {
        esRef.current?.close();
      } catch {
        /* ignore */
      }
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener('open', () => {
        retryMsRef.current = 2000;
        pushAppActivityLog({ level: 'success', tag: 'SSE', message: 'Canal tiempo real conectado' });
        window.dispatchEvent(new CustomEvent(SYSCOM_SSE_CONNECTED));
      });

      es.addEventListener(sseContract.sseTelemetry, (e) => {
        try {
          const detail = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent(SYSCOM_REALTIME_TELEMETRY, { detail }));
          scheduleClientEmailWebhookAutomations(automationCtxRef.current, detail);
        } catch {
          /* ignore */
        }
      });

      es.addEventListener(sseContract.sseLns, (e) => {
        try {
          const detail = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent(SYSCOM_REALTIME_LNS, { detail }));
        } catch {
          /* ignore */
        }
      });

      es.onerror = () => {
        es.close();
        if (cancelled) return;
        const delay = retryMsRef.current;
        retryMsRef.current = Math.min(60000, Math.floor(retryMsRef.current * 1.5));
        const now = Date.now();
        if (now - lastSseErrLog > 6000) {
          lastSseErrLog = now;
          pushAppActivityLog({
            level: 'warn',
            tag: 'SSE',
            message: 'Canal tiempo real desconectado; reintentando',
            detail: { siguienteIntentoMs: delay },
          });
        }
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      try {
        esRef.current?.close();
      } catch {
        /* ignore */
      }
      esRef.current = null;
    };
  }, [token, user?.id]);

  return null;
}
