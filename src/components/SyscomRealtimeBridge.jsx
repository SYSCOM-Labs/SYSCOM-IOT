import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { getEventsStreamUrl } from '../config/apiBase';
import { dispatchAppLog } from '../constants/appLog';
import { SYSCOM_REALTIME_LNS, SYSCOM_REALTIME_TELEMETRY } from '../constants/realtimeEvents';

/**
 * Mantiene EventSource (SSE) con el backend: telemetría y eventos LNS sin polling exclusivo.
 */
export default function SyscomRealtimeBridge() {
  const { token, user } = useAuth();
  const esRef = useRef(null);
  const retryMsRef = useRef(2000);
  const lastSseWarnRef = useRef(0);

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
        dispatchAppLog('info', 'Tiempo real (SSE) conectado', { category: 'realtime' });
      });

      es.addEventListener('telemetry', (e) => {
        try {
          const detail = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent(SYSCOM_REALTIME_TELEMETRY, { detail }));
        } catch {
          /* ignore */
        }
      });

      es.addEventListener('lns', (e) => {
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
        if (now - lastSseWarnRef.current > 12000) {
          lastSseWarnRef.current = now;
          dispatchAppLog('warn', `Tiempo real (SSE) desconectado; reintento en ${Math.round(delay / 1000)}s`, {
            category: 'realtime',
            data: { reconnectDelayMs: delay },
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
