import React from 'react';
import './Widgets.css';
import { motion as Motion } from 'framer-motion';

/**
 * Barra de progreso hacia una meta (ej. tanque 75/100 L).
 * widget.progressMax en el panel (por defecto 100).
 */
export default function ProgressWidget({ value, unit, max = 100 }) {
  const m = Math.max(Number(max) || 100, 0.0001);
  const n = parseFloat(value);
  const pct = Number.isFinite(n) ? Math.min(100, Math.max(0, (n / m) * 100)) : 0;

  return (
    <Motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="progress-widget-soft"
    >
      <div className="progress-widget-soft__head">
        <span className="progress-widget-soft__pct">{Number.isFinite(n) ? `${pct.toFixed(0)}%` : '—'}</span>
        <span className="progress-widget-soft__cap">
          {Number.isFinite(n) ? n.toFixed(2) : '—'} / {m}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <div className="progress-widget-soft__track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-widget-soft__fill" style={{ width: `${pct}%` }} />
      </div>
    </Motion.div>
  );
}
