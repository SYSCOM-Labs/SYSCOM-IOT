import React from 'react';
import { normalizeWindDegrees } from './windVaneUi';

/** Posiciones de etiquetas en viewBox 200×200. */
const LABELS = [
  { t: 'N', x: 100, y: 16, anchor: 'middle' },
  { t: 'NE', x: 158, y: 34, anchor: 'middle' },
  { t: 'E', x: 184, y: 104, anchor: 'middle' },
  { t: 'SE', x: 158, y: 172, anchor: 'middle' },
  { t: 'S', x: 100, y: 190, anchor: 'middle' },
  { t: 'SO', x: 42, y: 172, anchor: 'middle' },
  { t: 'O', x: 16, y: 104, anchor: 'middle' },
  { t: 'NO', x: 42, y: 34, anchor: 'middle' },
];

/**
 * Brújula / veleta: aguja roja; `degrees` = dirección meteorológica (0° = N).
 * @param {{ degrees: number | null; className?: string; 'aria-label'?: string }} props
 */
export default function BsdWindVaneWidget({ degrees, className = '', 'aria-label': ariaLabel }) {
  const rot = degrees != null && Number.isFinite(degrees) ? normalizeWindDegrees(degrees) : null;
  const label =
    ariaLabel ||
    (rot != null ? `Dirección del viento ${rot.toFixed(0)} grados` : 'Dirección del viento sin dato');

  return (
    <div className={['bsd-wind-vane', className].filter(Boolean).join(' ')} role="img" aria-label={label}>
      <svg className="bsd-wind-vane__svg" viewBox="0 0 200 200" width="100%" height="100%" aria-hidden>
        <defs>
          <linearGradient id="bsd-wind-vane-needle-top" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ff5c5c" />
            <stop offset="100%" stopColor="#e11d48" />
          </linearGradient>
        </defs>
        <circle className="bsd-wind-vane__rim" cx="100" cy="100" r="96" fill="none" strokeWidth="5" />
        <circle className="bsd-wind-vane__face" cx="100" cy="100" r="90" />
        {LABELS.map((lb) => (
          <text
            key={lb.t}
            className="bsd-wind-vane__label"
            x={lb.x}
            y={lb.y}
            textAnchor={lb.anchor}
            dominantBaseline="middle"
          >
            {lb.t}
          </text>
        ))}
        <g
          className="bsd-wind-vane__needle"
          style={
            rot != null
              ? { transform: `rotate(${rot}deg)`, transformOrigin: '100px 100px' }
              : { opacity: 0.35 }
          }
        >
          <polygon
            className="bsd-wind-vane__needle-head"
            points="100,26 106,98 94,98"
            fill="url(#bsd-wind-vane-needle-top)"
          />
        </g>
        <circle className="bsd-wind-vane__hub-dot" cx="100" cy="100" r="5" />
      </svg>
    </div>
  );
}
