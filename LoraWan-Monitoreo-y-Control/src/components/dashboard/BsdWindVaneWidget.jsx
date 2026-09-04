import React from 'react';
import { normalizeWindDegrees } from './windVaneUi';

/** Posiciones de etiquetas en viewBox 200×200 (margen interior para no recortar N/S). */
const LABELS = [
  { t: 'N', x: 100, y: 22, anchor: 'middle' },
  { t: 'NE', x: 154, y: 40, anchor: 'middle' },
  { t: 'E', x: 180, y: 104, anchor: 'middle' },
  { t: 'SE', x: 154, y: 166, anchor: 'middle' },
  { t: 'S', x: 100, y: 186, anchor: 'middle' },
  { t: 'SO', x: 46, y: 166, anchor: 'middle' },
  { t: 'O', x: 20, y: 104, anchor: 'middle' },
  { t: 'NO', x: 46, y: 40, anchor: 'middle' },
];

/**
 * Brújula / veleta: aguja roja; `degrees` = dirección meteorológica (0° = N).
 * El valor y el rumbo van al centro para no recortar el círculo en tarjetas compactas.
 * @param {{ degrees: number | null; displayDeg?: string; cardinal?: string; className?: string; 'aria-label'?: string }} props
 */
export default function BsdWindVaneWidget({
  degrees,
  displayDeg,
  cardinal,
  className = '',
  'aria-label': ariaLabel,
}) {
  const rot = degrees != null && Number.isFinite(degrees) ? normalizeWindDegrees(degrees) : null;
  const label =
    ariaLabel ||
    (rot != null ? `Dirección del viento ${rot.toFixed(0)} grados` : 'Dirección del viento sin dato');
  const centerDeg = displayDeg != null && String(displayDeg).trim() ? String(displayDeg).trim() : rot != null ? `${rot.toFixed(0)}°` : '—';
  const centerCard = cardinal != null && String(cardinal).trim() && String(cardinal).trim() !== '—' ? String(cardinal).trim() : '';

  return (
    <div className={['bsd-wind-vane', className].filter(Boolean).join(' ')} role="img" aria-label={label}>
      <svg
        className="bsd-wind-vane__svg"
        viewBox="0 0 200 200"
        preserveAspectRatio="xMidYMid meet"
        width="100%"
        height="100%"
        aria-hidden
      >
        <defs>
          <linearGradient id="bsd-wind-vane-needle-top" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ff5c5c" />
            <stop offset="100%" stopColor="#e11d48" />
          </linearGradient>
        </defs>
        <circle className="bsd-wind-vane__rim" cx="100" cy="100" r="92" fill="none" strokeWidth="5" />
        <circle className="bsd-wind-vane__face" cx="100" cy="100" r="86" />
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
            points="100,30 105,86 95,86"
            fill="url(#bsd-wind-vane-needle-top)"
          />
        </g>
        <circle className="bsd-wind-vane__hub-dot" cx="100" cy="100" r="4.5" />
        <text className="bsd-wind-vane__center-deg" x="100" y="102" textAnchor="middle" dominantBaseline="middle">
          {centerDeg}
        </text>
        {centerCard ? (
          <text className="bsd-wind-vane__center-card" x="100" y="118" textAnchor="middle" dominantBaseline="middle">
            {centerCard}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
