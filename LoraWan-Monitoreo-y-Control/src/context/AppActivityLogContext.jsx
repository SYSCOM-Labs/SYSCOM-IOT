import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SYSCOM_APP_ACTIVITY, pushAppActivityLog } from '../utils/appActivityLog';
import { SYSCOM_LNS_DOWNLINK_SENT_EVENT } from '../services/api';
import { SYSCOM_REALTIME_LNS, SYSCOM_REALTIME_TELEMETRY } from '../constants/realtimeEvents';

const MAX_LINES = 200;

function normDevId(id) {
  const h = String(id || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return h.length >= 8 ? h : String(id || '');
}

function formatClientDownlinkLine(d) {
  const deuiRaw = String(d.devEUI || d.devEui || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const dev = deuiRaw.length === 16 ? deuiRaw : normDevId(d.deviceId);
  if (d.deferred === true) {
    const reason =
      d.deferredReason != null && String(d.deferredReason).trim() !== ''
        ? ` · ${String(d.deferredReason).trim()}`
        : '';
    const q =
      d.pendingQueueLength != null && Number.isFinite(Number(d.pendingQueueLength))
        ? ` · cola ${Number(d.pendingQueueLength)}`
        : '';
    return dev
      ? `Downlink encolado (próximo uplink) · ${dev}${reason}${q}`
      : `Downlink encolado (próximo uplink)${reason}${q}`;
  }
  const parts = [];
  if (d.fPort != null && d.fPort !== '') parts.push(`FPort ${d.fPort}`);
  if (d.gatewayEui) parts.push(`GW ${normDevId(d.gatewayEui)}`);
  if (d.deviceClass) parts.push(`LoRaWAN clase ${d.deviceClass}`);
  if (d.confirmed === true) parts.push('confirmado');
  else if (d.confirmed === false) parts.push('no confirmado');
  if (d.imme === true) parts.push('TX inmediata');
  else if (d.imme === false) parts.push('TX en ventana RX');
  if (d.classARxWindow) parts.push(`ventana ${d.classARxWindow}`);
  if (d.fCnt != null && d.fCnt !== '') parts.push(`FCnt↓ ${d.fCnt}`);
  if (d.txAckPending === true) {
    const w = d.txAckMaxWaitMs != null && Number.isFinite(Number(d.txAckMaxWaitMs)) ? Number(d.txAckMaxWaitMs) : 8000;
    parts.push(`pendiente GW TX_ACK (~${Math.round(w / 1000)}s)`);
  }
  const tail = parts.length ? ` — ${parts.join(' · ')}` : '';
  return dev ? `Downlink aceptado · ${dev}${tail}` : `Downlink aceptado${tail}`;
}

const AppActivityLogContext = createContext(null);

/**
 * Mantiene el estado del registro de actividad (siempre montado) para que los eventos
 * sigan registrándose aunque el panel solo se muestre en Ajustes.
 * @param {{ currentPage?: string, children: React.ReactNode }} props
 */
export function AppActivityLogProvider({ currentPage, children }) {
  const [expanded, setExpanded] = useState(true);
  const [lines, setLines] = useState(() => [
    {
      ts: Date.now(),
      level: 'info',
      tag: 'App',
      message: 'Registro de actividad iniciado',
    },
  ]);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevPageRef = useRef(null);

  const append = useCallback((entry) => {
    setLines((prev) => {
      const next = [...prev, entry];
      if (next.length > MAX_LINES) return next.slice(-MAX_LINES);
      return next;
    });
  }, []);

  useEffect(() => {
    const onActivity = (ev) => {
      const d = ev.detail;
      if (!d || typeof d.message !== 'string') return;
      append({
        ts: d.ts != null ? Number(d.ts) : Date.now(),
        level: d.level || 'info',
        tag: d.tag || 'App',
        message: d.message,
        detail: d.detail,
      });
    };
    window.addEventListener(SYSCOM_APP_ACTIVITY, onActivity);
    return () => window.removeEventListener(SYSCOM_APP_ACTIVITY, onActivity);
  }, [append]);

  useEffect(() => {
    const onTok = () => {
      append({
        ts: Date.now(),
        level: 'info',
        tag: 'Auth',
        message: 'Sesión renovada (JWT)',
      });
    };
    window.addEventListener('syscom-token-refreshed', onTok);
    return () => window.removeEventListener('syscom-token-refreshed', onTok);
  }, [append]);

  useEffect(() => {
    const onDl = (ev) => {
      const d = ev.detail || {};
      append({
        ts: Date.now(),
        level: 'success',
        tag: 'Downlink',
        message: formatClientDownlinkLine(d),
        detail: undefined,
      });
    };
    window.addEventListener(SYSCOM_LNS_DOWNLINK_SENT_EVENT, onDl);
    return () => window.removeEventListener(SYSCOM_LNS_DOWNLINK_SENT_EVENT, onDl);
  }, [append]);

  useEffect(() => {
    const onLns = (ev) => {
      const d = ev.detail || {};
      const t = d.eventType || d.type || 'evento';
      if (t === 'downlink_device_acked') {
        const meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
        const dev = normDevId(meta.deviceId || meta.devEUI || d.devEui);
        append({
          ts: Date.now(),
          level: 'success',
          tag: 'LNS',
          message: dev ? `Dispositivo confirmó downlink · ${dev}` : 'Dispositivo confirmó recepción de downlink',
          detail: Object.keys(meta).length ? meta : undefined,
        });
        return;
      }
      if (t === 'downlink_sent') {
        return;
      }
      if (t === 'gateway_tx_rejected') {
        const meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
        const err = meta.txpkError != null ? String(meta.txpkError) : 'error';
        const gw = normDevId(meta.gatewayEui);
        const orphan = Boolean(meta.orphanAck);
        append({
          ts: Date.now(),
          level: 'error',
          tag: 'LNS',
          message: gw
            ? `Gateway rechazó TX · ${gw} — ${err}${orphan ? ' (sin correlación TX_ACK)' : ''}${
                /TOO_LATE|TOO_EARLY/i.test(String(err))
                  ? ' · suba SYSCOM_LNS_CLASS_C_TX_GAP_MS (p. ej. 1500–2200) o SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1'
                  : ''
              }`
            : `Gateway rechazó TX — ${err}`,
          detail: Object.keys(meta).length ? meta : undefined,
        });
        return;
      }
      if (t === 'downlink_gateway_ack') {
        const meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
        const dev = normDevId(meta.devEUI || d.devEui);
        if (meta.timeout) {
          append({
            ts: Date.now(),
            level: 'warn',
            tag: 'LNS',
            message: dev
              ? `Downlink sin GW_TX_ACK (timeout) · ${dev} — cola liberada; reintente o SYSCOM_LNS_APP_DOWNLINK_TX_ACK=0`
              : 'Downlink sin GW_TX_ACK (timeout) — cola liberada',
            detail: Object.keys(meta).length ? meta : undefined,
          });
        } else if (meta.ok) {
          append({
            ts: Date.now(),
            level: 'success',
            tag: 'LNS',
            message: dev
              ? `Gateway TX_ACK OK · ${dev}${meta.fCnt != null ? ` · FCnt↓ ${meta.fCnt}` : ''}`
              : `Gateway TX_ACK OK${meta.fCnt != null ? ` · FCnt↓ ${meta.fCnt}` : ''}`,
            detail: Object.keys(meta).length ? meta : undefined,
          });
        } else {
          const err = meta.error != null ? String(meta.error) : 'error';
          append({
            ts: Date.now(),
            level: 'error',
            tag: 'LNS',
            message: dev ? `Gateway TX_ACK · ${dev} — ${err}` : `Gateway TX_ACK — ${err}`,
            detail: Object.keys(meta).length ? meta : undefined,
          });
        }
      }
    };
    window.addEventListener(SYSCOM_REALTIME_LNS, onLns);
    return () => window.removeEventListener(SYSCOM_REALTIME_LNS, onLns);
  }, [append]);

  useEffect(() => {
    const lastByKey = new Map();
    const onTel = (ev) => {
      const d = ev.detail || {};
      const id = d.deviceId || d.device_id || '';
      const now = Date.now();
      const isGw = String(d.deviceType || '').toUpperCase() === 'GATEWAY';
      const dev = normDevId(id);
      const key = isGw ? `gw:${dev || '?'}` : `dev:${dev || '?'}`;
      const minGap = isGw ? 120000 : 1000;
      const prev = lastByKey.get(key) || 0;
      if (now - prev < minGap) return;
      lastByKey.set(key, now);
      if (lastByKey.size > 400) {
        for (const k of lastByKey.keys()) {
          lastByKey.delete(k);
          if (lastByKey.size <= 200) break;
        }
      }
      const label =
        isGw && dev
          ? `Gateway en línea · ${dev.length >= 16 ? dev : `${dev}…`}`
          : dev
            ? `Uplink / telemetría · ${dev.length >= 16 ? dev : `${dev}…`}`
            : 'Actualización de telemetría';
      append({
        ts: now,
        level: 'info',
        tag: isGw ? 'Gateway' : 'Telemetría',
        message: label,
      });
    };
    window.addEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
    return () => window.removeEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
  }, [append]);

  useEffect(() => {
    const onErr = (e) => {
      append({
        ts: Date.now(),
        level: 'error',
        tag: 'JS',
        message: e.message || 'Error',
        detail: e.filename ? `${e.filename}:${e.lineno}` : undefined,
      });
    };
    const onRej = (e) => {
      const r = e.reason;
      append({
        ts: Date.now(),
        level: 'error',
        tag: 'Promise',
        message: typeof r === 'string' ? r : r?.message || 'Rechazo no manejado',
      });
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [append]);

  useEffect(() => {
    if (prevPageRef.current === null) {
      prevPageRef.current = currentPage;
      return;
    }
    if (prevPageRef.current === currentPage) return;
    prevPageRef.current = currentPage;
    pushAppActivityLog({
      level: 'info',
      tag: 'Navegación',
      message: `Vista: ${currentPage || '—'}`,
    });
  }, [currentPage]);

  const clear = useCallback(() => {
    setLines([
      {
        ts: Date.now(),
        level: 'info',
        tag: 'App',
        message: 'Registro vaciado',
      },
    ]);
  }, []);

  const value = useMemo(
    () => ({
      lines,
      clear,
      autoScroll,
      setAutoScroll,
      expanded,
      setExpanded,
    }),
    [lines, clear, autoScroll, expanded]
  );

  return <AppActivityLogContext.Provider value={value}>{children}</AppActivityLogContext.Provider>;
}

export function useAppActivityLog() {
  const ctx = useContext(AppActivityLogContext);
  if (!ctx) {
    throw new Error('useAppActivityLog debe usarse dentro de AppActivityLogProvider');
  }
  return ctx;
}
