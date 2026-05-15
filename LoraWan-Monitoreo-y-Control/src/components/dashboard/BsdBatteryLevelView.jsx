import React, { useId } from 'react';

/**
 * Pila vertical (0–100 %): cristal + tapas metálicas, referencia visual, máximo uso del espacio.
 */
export default function BsdBatteryLevelView({
  fillPct = 0,
  fillColor = '#fb923c',
  centerLabel = '—',
  lastAtLine = '',
  titleColor,
}) {
  const uid = useId().replace(/:/g, '');
  const t = Math.min(100, Math.max(0, Number(fillPct) || 0));
  const bodyTop = 78;
  const bodyH = 132;
  const bodyBottom = bodyTop + bodyH;
  const fillH = (bodyH * t) / 100;
  const fillY = bodyBottom - fillH;

  return (
    <div className="bsd-battery-level">
      <div className="bsd-battery-level__texture" aria-hidden />
      <div className="bsd-battery-level__stage">
        <svg
          className="bsd-battery-level__svg"
          viewBox="0 0 200 220"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          <defs>
            <linearGradient id={`bt-cap-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f4f4f5" />
              <stop offset="35%" stopColor="#a1a1aa" />
              <stop offset="100%" stopColor="#6b7280" />
            </linearGradient>
            <linearGradient id={`bt-glass-${uid}`} x1="12%" y1="0%" x2="88%" y2="0%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.38)" />
              <stop offset="40%" stopColor="rgba(255,255,255,0.07)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.28)" />
            </linearGradient>
            <linearGradient id={`bt-shine-${uid}`} x1="22%" y1="0%" x2="78%" y2="0%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.5)" />
              <stop offset="35%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.18)" />
            </linearGradient>
            <linearGradient id={`bt-base-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="#9ca3af" />
              <stop offset="100%" stopColor="#4b5563" />
            </linearGradient>
            <clipPath id={`bt-clip-${uid}`}>
              <rect x="50" y={bodyTop} width="100" height={bodyH} rx="36" ry="36" />
            </clipPath>
          </defs>

          <ellipse cx="100" cy="206" rx="68" ry="9" fill="rgba(0,0,0,0.3)" opacity="0.55" />

          {/* Base metálica ancha */}
          <rect x="22" y="192" width="156" height="22" rx="8" fill={`url(#bt-base-${uid})`} stroke="#374151" strokeWidth="1.1" />
          <rect x="30" y="188" width="140" height="8" rx="3" fill="#d1d5db" opacity="0.35" />

          {/* Cuerpo cristal (más ancho = más presencia) */}
          <rect
            x="42"
            y="64"
            width="116"
            height="156"
            rx="40"
            ry="40"
            fill="rgba(15,23,42,0.1)"
            stroke="rgba(209,213,219,0.5)"
            strokeWidth="2.2"
          />
          <rect x="46" y="68" width="108" height="148" rx="36" ry="36" fill={`url(#bt-glass-${uid})`} opacity="0.85" />

          <g clipPath={`url(#bt-clip-${uid})`}>
            <rect x="48" y={bodyTop - 2} width="104" height={bodyH + 4} fill="rgba(15,23,42,0.22)" />
            <rect x="48" y={fillY} width="104" height={Math.max(0, fillH) + 1} fill={fillColor} opacity="0.94" />
            <rect x="48" y={bodyTop} width="104" height={bodyH * 0.42} fill={`url(#bt-shine-${uid})`} opacity="0.4" />
          </g>

          <rect
            x="42"
            y="64"
            width="116"
            height="156"
            rx="40"
            ry="40"
            fill="none"
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="1.2"
          />

          {/* Brillos verticales */}
          <path
            d="M 58 198 L 58 78"
            stroke="rgba(255,255,255,0.45)"
            strokeWidth="6"
            strokeLinecap="round"
            opacity="0.22"
          />
          <path
            d="M 142 198 L 142 78"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.18"
          />

          {/* Tapa + terminal positivo */}
          <ellipse cx="100" cy="64" rx="44" ry="14" fill={`url(#bt-cap-${uid})`} stroke="#52525b" strokeWidth="1" />
          <rect x="88" y="40" width="24" height="30" rx="5" fill="#e5e7eb" stroke="#6b7280" strokeWidth="1" />
          <ellipse cx="100" cy="36" rx="10" ry="6" fill="#fafafa" stroke="#9ca3af" strokeWidth="0.8" />
          <rect x="96" y="28" width="8" height="14" rx="2" fill="#d1d5db" stroke="#6b7280" strokeWidth="0.6" />
        </svg>
        <div className="bsd-battery-level__hub">
          <span className="bsd-battery-level__value">{centerLabel}</span>
        </div>
      </div>
      {lastAtLine ? (
        <div className="bsd-battery-level__foot-at" style={titleColor ? { color: titleColor } : undefined}>
          {lastAtLine}
        </div>
      ) : null}
    </div>
  );
}
