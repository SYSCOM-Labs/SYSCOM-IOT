import React, { useEffect, useRef, useState } from 'react';
import FormToast from './FormToast';
import { fetchLnsUiEventsAfterId, SYSCOM_LNS_DOWNLINK_SENT_EVENT } from '../services/api';
import { SYSCOM_REALTIME_LNS } from '../constants/realtimeEvents';

const STORAGE_KEY = 'syscom_lns_ui_last_id';

function readStoredLastId() {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY) || '0');
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeStoredLastId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/**
 * Toasts globales: downlink enviado (inmediato) y confirmación de recepción en dispositivo (polling LNS).
 */
export default function LnsDownlinkToastBridge() {
  const [toast, setToast] = useState(null);
  const lastIdRef = useRef(readStoredLastId());
  /** Si ya hay cursor guardado, no absorber el primer lote como histórico. */
  const bootstrappedRef = useRef(readStoredLastId() > 0);

  useEffect(() => {
    const onSent = () => {
      setToast({ type: 'success', message: 'Downlink enviado' });
    };
    window.addEventListener(SYSCOM_LNS_DOWNLINK_SENT_EVENT, onSent);
    return () => window.removeEventListener(SYSCOM_LNS_DOWNLINK_SENT_EVENT, onSent);
  }, []);

  useEffect(() => {
    const onSseLns = (ev) => {
      const d = ev.detail;
      if (d?.eventType === 'downlink_device_acked') {
        setToast({ type: 'success', message: 'Dispositivo recibió downlink' });
      } else if (d?.eventType === 'downlink_gateway_tx_ack') {
        setToast({ type: 'success', message: 'Gateway confirmó transmisión (GW_TX_ACK)' });
      } else if (d?.eventType === 'downlink_gateway_tx_reject') {
        const err = d?.meta?.error || d?.meta?.txpkAck?.error;
        setToast({
          type: 'error',
          message: err ? `Gateway rechazó TX: ${err}` : 'Gateway rechazó transmisión (GW_TX_ACK)',
        });
      }
    };
    window.addEventListener(SYSCOM_REALTIME_LNS, onSseLns);
    return () => window.removeEventListener(SYSCOM_REALTIME_LNS, onSseLns);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const events = await fetchLnsUiEventsAfterId(lastIdRef.current);
        if (cancelled || !Array.isArray(events)) return;

        if (!bootstrappedRef.current) {
          bootstrappedRef.current = true;
          if (events.length > 0) {
            const maxId = Math.max(...events.map((e) => Number(e.id) || 0));
            lastIdRef.current = maxId;
            writeStoredLastId(maxId);
          }
          return;
        }

        let maxId = lastIdRef.current;
        for (const ev of events) {
          const id = Number(ev.id) || 0;
          if (id > maxId) maxId = id;
          if (ev.eventType === 'downlink_device_acked') {
            setToast({ type: 'success', message: 'Dispositivo recibió downlink' });
          } else if (ev.eventType === 'downlink_gateway_tx_ack') {
            setToast({ type: 'success', message: 'Gateway confirmó transmisión (GW_TX_ACK)' });
          } else if (ev.eventType === 'downlink_gateway_tx_reject') {
            const err = ev.meta?.error || ev.meta?.txpkAck?.error;
            setToast({
              type: 'error',
              message: err ? `Gateway rechazó TX: ${err}` : 'Gateway rechazó transmisión (GW_TX_ACK)',
            });
          }
        }
        if (maxId > lastIdRef.current) {
          lastIdRef.current = maxId;
          writeStoredLastId(maxId);
        }
      } catch {
        /* offline / 401: siguiente ciclo */
      }
    };

    tick();
    const iv = window.setInterval(tick, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.25rem',
        right: '1.25rem',
        zIndex: 10050,
        maxWidth: 'min(420px, calc(100vw - 2rem))',
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <FormToast
          type={toast?.type || 'success'}
          message={toast?.message || ''}
          onDismiss={() => setToast(null)}
          durationMs={0}
        />
      </div>
    </div>
  );
}
