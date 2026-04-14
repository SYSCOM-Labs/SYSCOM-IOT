import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { motion as Motion } from 'framer-motion';
import { queryTelemetry } from '../../services/localAuth';
import './Widgets.css';

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 14;

function buildTimeline(rows, key) {
  if (!Array.isArray(rows) || !key) return [];
  const sorted = [...rows].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const events = [];
  let prevVal;
  for (const row of sorted) {
    const v = row.properties?.[key];
    if (v === undefined) continue;
    const str = String(v);
    if (prevVal !== undefined && str !== prevVal) {
      events.push({
        ts: row.timestamp,
        from: prevVal,
        to: str,
      });
    }
    prevVal = str;
  }
  return events.slice(-MAX_EVENTS);
}

const TimelineWidget = ({ deviceId, propertyKey }) => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!deviceId || !propertyKey) return;
    const now = Date.now();
    try {
      const data = await queryTelemetry(deviceId, null, now - WINDOW_MS, now);
      const list = Array.isArray(data) ? data : [];
      setEvents(buildTimeline(list, propertyKey));
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId, propertyKey]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const label = useMemo(() => propertyKey || 'propiedad', [propertyKey]);

  if (loading && events.length === 0) {
    return <div className="timeline-muted">Cargando línea de tiempo…</div>;
  }

  if (events.length === 0) {
    return (
      <div className="timeline-muted">
        No hay cambios de <strong>{label}</strong> en el historial reciente, o falta telemetría local.
      </div>
    );
  }

  return (
    <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="timeline-root">
      <ul className="timeline-list">
        {[...events].reverse().map((ev, i) => (
          <li key={`${ev.ts}-${i}`} className="timeline-item">
            <span className="timeline-dot" />
            <div className="timeline-body">
              <div className="timeline-time">
                {ev.ts ? new Date(ev.ts).toLocaleString() : '—'}
              </div>
              <div className="timeline-change">
                <span className="timeline-from">{ev.from}</span>
                <span className="timeline-arrow">→</span>
                <span className="timeline-to">{ev.to}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Motion.div>
  );
};

export default TimelineWidget;
