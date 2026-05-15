import React, { useId } from 'react';

/**
 * Tanque tipo depósito (nivel 0–100 %): referencia visual + máximo aprovechamiento del área útil.
 */
export default function BsdContainerTankView({
  fillPct = 0,
  fillColor = '#22c55e',
  centerLabel = '—',
  lastAtLine = '',
  titleColor,
}) {
  const uid = useId().replace(/:/g, '');
  const t = Math.min(100, Math.max(0, Number(fillPct) || 0));
  /** Interior del cuerpo (líquido). */
  const innerTop = 86;
  const innerH = 112;
  const innerBottom = innerTop + innerH;
  const fillH = (innerH * t) / 100;
  const fillY = innerBottom - fillH;

  return (
    <div className="bsd-container-tank">
      <div className="bsd-container-tank__texture" aria-hidden />
      <div className="bsd-container-tank__stage">
        <svg
          className="bsd-container-tank__svg"
          viewBox="0 0 200 210"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          <defs>
            <linearGradient id={`ct-glass-${uid}`} x1="8%" y1="0%" x2="92%" y2="8%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.42)" />
              <stop offset="22%" stopColor="rgba(186,230,253,0.18)" />
              <stop offset="55%" stopColor="rgba(255,255,255,0.08)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.32)" />
            </linearGradient>
            <linearGradient id={`ct-body-shade-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.2)" />
              <stop offset="100%" stopColor="rgba(15,23,42,0.15)" />
            </linearGradient>
            <linearGradient id={`ct-base-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#5b5b63" />
              <stop offset="100%" stopColor="#3a3a42" />
            </linearGradient>
            <filter id={`ct-soft-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <clipPath id={`ct-clip-${uid}`}>
              <rect x="48" y={innerTop} width="104" height={innerH} rx="36" ry="36" />
            </clipPath>
          </defs>

          {/* Silueta / estructura trasera (industrial) */}
          <rect
            x="18"
            y="44"
            width="164"
            height="132"
            rx="18"
            fill="rgba(100,116,139,0.11)"
            stroke="rgba(148,163,184,0.22)"
            strokeWidth="1.2"
          />

          <ellipse cx="100" cy="198" rx="62" ry="7" fill="rgba(0,0,0,0.28)" opacity="0.65" />

          {/* Plataforma */}
          <rect x="10" y="182" width="180" height="22" rx="9" fill={`url(#ct-base-${uid})`} stroke="#2d2d33" strokeWidth="1" />
          <rect x="16" y="178" width="168" height="10" rx="4" fill="#6b7280" opacity="0.45" />

          {/* Cuerpo cristal (barrilete más ancho abajo) */}
          <path
            d="M 44 184 L 44 96 C 44 66 68 46 100 38 C 132 46 156 66 156 96 L 156 184 C 156 200 132 210 100 212 C 68 210 44 200 44 184 Z"
            fill="rgba(255,255,255,0.06)"
            stroke="rgba(186,230,253,0.45)"
            strokeWidth="2.2"
            filter={`url(#ct-soft-${uid})`}
          />

          <g clipPath={`url(#ct-clip-${uid})`}>
            <rect x="46" y={innerTop - 2} width="108" height={innerH + 4} fill="rgba(15,23,42,0.28)" />
            <rect x="46" y={fillY} width="108" height={Math.max(0, fillH) + 1} fill={fillColor} opacity="0.92" />
            <rect x="46" y={innerTop} width="108" height={innerH * 0.45} fill={`url(#ct-body-shade-${uid})`} opacity="0.55" />
          </g>

          <path
            d="M 44 184 L 44 96 C 44 66 68 46 100 38 C 132 46 156 66 156 96 L 156 184 C 156 200 132 210 100 212 C 68 210 44 200 44 184 Z"
            fill={`url(#ct-glass-${uid})`}
            opacity="0.55"
          />

          <path
            d="M 44 184 L 44 96 C 44 66 68 46 100 38 C 132 46 156 66 156 96 L 156 184 C 156 200 132 210 100 212 C 68 210 44 200 44 184 Z"
            fill="none"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth="1.3"
          />

          {/* Brillo lateral */}
          <path
            d="M 52 170 L 52 88 Q 54 58 72 48"
            fill="none"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.35"
          />
          <path
            d="M 148 170 L 148 88 Q 146 58 128 48"
            fill="none"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.25"
          />

          {/* Cúpula superior */}
          <ellipse cx="100" cy="42" rx="40" ry="14" fill="rgba(186,230,253,0.42)" stroke="rgba(148,163,184,0.55)" strokeWidth="1.4" />
          <ellipse cx="100" cy="40" rx="28" ry="9" fill="rgba(255,255,255,0.35)" />
        </svg>
        <div className="bsd-container-tank__hub">
          <span className="bsd-container-tank__value">{centerLabel}</span>
        </div>
      </div>
      {lastAtLine ? (
        <div className="bsd-container-tank__foot-at" style={titleColor ? { color: titleColor } : undefined}>
          {lastAtLine}
        </div>
      ) : null}
    </div>
  );
}
