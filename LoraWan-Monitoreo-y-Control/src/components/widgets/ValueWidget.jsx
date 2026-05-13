import React from 'react';
import { motion as Motion } from 'framer-motion';
import { Activity } from 'lucide-react';
import './Widgets.css';

const ValueWidget = ({ title, value, unit, trend, color, staleMinutes }) => {
  const display =
    value !== undefined && value !== null && value !== ''
      ? typeof value === 'number'
        ? Number.isFinite(value)
          ? value.toFixed(2)
          : String(value)
        : String(value)
      : '—';

  return (
    <Motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="value-widget-premium"
    >
      {title ? (
        <div className="value-widget-premium__eyebrow">
          <span>{title}</span>
          <Activity size={14} style={{ color: color || 'var(--accent-cyan)', opacity: 0.85 }} />
        </div>
      ) : null}
      <div className="widget-content value-widget-premium__value-row">
        <span className="widget-value">{display}</span>
        {unit ? <span className="widget-unit">{unit}</span> : null}
      </div>
      {trend != null && trend !== '' ? (
        <div className="widget-footer">
          <span
            className={`trend ${
              String(trend).startsWith('-')
                ? 'down'
                : String(trend).startsWith('+') || String(trend).startsWith('↑')
                  ? 'up'
                  : ''
            }`}
          >
            {trend}
            {!String(trend).includes('%') ? '%' : ''}
          </span>
          <span className="trend-label">vs período anterior</span>
        </div>
      ) : null}
      {staleMinutes != null && staleMinutes > 0 && (
        <div className="value-stale">Dato desactualizado (hace {staleMinutes} min)</div>
      )}
    </Motion.div>
  );
};

export default ValueWidget;
