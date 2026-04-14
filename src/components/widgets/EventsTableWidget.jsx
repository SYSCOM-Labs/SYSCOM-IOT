import React, { useEffect, useState, useCallback } from 'react';
import { motion as Motion } from 'framer-motion';
import { queryTelemetry } from '../../services/localAuth';
import './Widgets.css';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 12;

function summarizeProps(props, highlightKey) {
  if (!props || typeof props !== 'object') return '—';
  const keys = Object.keys(props).filter(
    (k) => !['deviceId', 'deviceName', 'userId', 'timestamp', 'lastUpdateTime'].includes(k)
  );
  const ordered = highlightKey && keys.includes(highlightKey)
    ? [highlightKey, ...keys.filter((k) => k !== highlightKey)]
    : keys;
  const parts = ordered.slice(0, 4).map((k) => {
    const v = props[k];
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k}: ${s.length > 18 ? `${s.slice(0, 16)}…` : s}`;
  });
  return parts.length ? parts.join(' · ') : '—';
}

const EventsTableWidget = ({ deviceId, highlightKey }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!deviceId) return;
    const now = Date.now();
    try {
      const data = await queryTelemetry(deviceId, null, now - WINDOW_MS, now);
      const list = Array.isArray(data) ? data : [];
      const tail = list.slice(-MAX_ROWS).reverse();
      setRows(tail);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, 45000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && rows.length === 0) {
    return <div className="events-table-muted">Cargando eventos…</div>;
  }

  if (rows.length === 0) {
    return <div className="events-table-muted">Sin telemetría guardada para este dispositivo.</div>;
  }

  return (
    <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="events-table-wrap">
      <table className="events-table">
        <thead>
          <tr>
            <th>Fecha / hora</th>
            <th>Resumen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.timestamp}-${r.deviceId}`}>
              <td className="events-ts">
                {r.timestamp
                  ? new Date(r.timestamp).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : '—'}
              </td>
              <td className="events-summary">{summarizeProps(r.properties, highlightKey)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Motion.div>
  );
};

export default EventsTableWidget;
