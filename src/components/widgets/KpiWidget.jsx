import React, { useEffect, useState, useCallback } from 'react';
import { motion as Motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { queryTelemetry } from '../../services/localAuth';
import './Widgets.css';

const PERIOD_MS = 24 * 60 * 60 * 1000;

function avgForKey(rows, key) {
  if (!Array.isArray(rows) || !key) return null;
  const vals = rows
    .map((r) => parseFloat(r.properties?.[key]))
    .filter(Number.isFinite);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const KpiWidget = ({ deviceId, propertyKey, unit, liveValue, staleMinutes }) => {
  const [prevAvg, setPrevAvg] = useState(null);
  const [curAvg, setCurAvg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!deviceId || !propertyKey) {
      setLoading(false);
      return;
    }
    const now = Date.now();
    const curStart = now - PERIOD_MS;
    const prevEnd = curStart;
    const prevStart = prevEnd - PERIOD_MS;
    try {
      setErr(null);
      const [curRows, prevRows] = await Promise.all([
        queryTelemetry(deviceId, propertyKey, curStart, now),
        queryTelemetry(deviceId, propertyKey, prevStart, prevEnd),
      ]);
      setCurAvg(avgForKey(curRows, propertyKey));
      setPrevAvg(avgForKey(prevRows, propertyKey));
    } catch (e) {
      setErr(e.message || 'Sin historial');
    } finally {
      setLoading(false);
    }
  }, [deviceId, propertyKey]);

  useEffect(() => {
    load();
    const id = setInterval(load, Math.max(60000, 30000));
    return () => clearInterval(id);
  }, [load]);

  const parsedLive = parseFloat(liveValue);
  const hasLive = Number.isFinite(parsedLive);
  const displayMain = hasLive ? parsedLive.toFixed(2) : '—';

  let deltaPct = null;
  let direction = 'flat';
  if (curAvg != null && prevAvg != null && Math.abs(prevAvg) > 1e-9) {
    deltaPct = ((curAvg - prevAvg) / Math.abs(prevAvg)) * 100;
    if (deltaPct > 0.5) direction = 'up';
    else if (deltaPct < -0.5) direction = 'down';
  } else if (curAvg != null && prevAvg != null && prevAvg === 0 && curAvg !== 0) {
    deltaPct = curAvg > 0 ? 100 : -100;
    direction = curAvg > 0 ? 'up' : 'down';
  }

  const deltaColor =
    direction === 'up' ? 'var(--success)' : direction === 'down' ? 'var(--danger)' : 'var(--text-secondary)';

  return (
    <Motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="kpi-widget"
    >
      <div className="kpi-main-row">
        <span className="kpi-value">{displayMain}</span>
        {unit ? <span className="kpi-unit">{unit}</span> : null}
      </div>
      <div className="kpi-sub">
        {loading ? 'Cargando comparativa…' : err ? <span className="kpi-muted">{err}</span> : null}
        {!loading && !err && (
          <>
            <span className="kpi-muted">Media 24h vs 24h anterior</span>
            {deltaPct != null && Number.isFinite(deltaPct) ? (
              <span className="kpi-delta" style={{ color: deltaColor }}>
                {direction === 'up' && <TrendingUp size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />}
                {direction === 'down' && <TrendingDown size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />}
                {direction === 'flat' && <Minus size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />}
                {deltaPct > 0 ? '+' : ''}
                {deltaPct.toFixed(1)}%
              </span>
            ) : (
              <span className="kpi-muted">Sin datos previos para comparar</span>
            )}
          </>
        )}
      </div>
      {staleMinutes != null && staleMinutes > 0 && (
        <div className="kpi-stale">Dato desactualizado (hace {staleMinutes} min)</div>
      )}
    </Motion.div>
  );
};

export default KpiWidget;
