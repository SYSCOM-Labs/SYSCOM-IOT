import React, { useId, useMemo } from 'react';

/** Asegura etiqueta con símbolo de porcentaje. */
function formatPctLabel(label) {
  const s = String(label ?? '').trim();
  if (!s || s === '—') return '—';
  return s.includes('%') ? s : `${s}%`;
}

/**
 * Batería vertical estilo icono clásico: marco metálico, relleno glossy y % (sin rayo).
 */
export default function BsdBatteryLevelView({
  fillPct = 0,
  fillColor = '#22c55e',
  centerLabel = '—',
  lastAtLine = '',
  titleColor,
}) {
  const uid = useId().replace(/:/g, '');
  const t = Math.min(100, Math.max(0, Number(fillPct) || 0));
  const pctLabel = useMemo(() => formatPctLabel(centerLabel), [centerLabel]);

  const shellX = 24;
  const shellY = 30;
  const shellW = 92;
  const shellH = 158;
  const shellR = 14;
  const pad = 7;
  const wellX = shellX + pad;
  const wellY = shellY + pad;
  const wellW = shellW - pad * 2;
  const wellH = shellH - pad * 2;
  const wellR = 10;
  const wellBottom = wellY + wellH;
  const fillH = (wellH * t) / 100;
  const fillY = wellBottom - fillH;

  const tipW = 34;
  const tipH = 12;
  const tipX = (140 - tipW) / 2;
  /** Ubica el % en la zona vacía (arriba) cuando el nivel es alto. */
  const labelTopPct = Math.min(58, Math.max(36, 34 + (100 - t) * 0.24));
  const valueColor =
    titleColor != null && String(titleColor).trim() !== '' ? String(titleColor).trim() : fillColor;

  return (
    <div className="bsd-battery-level">
      <div className="bsd-battery-level__stage">
        <svg
          className="bsd-battery-level__svg"
          viewBox="0 0 140 210"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          <defs>
            <linearGradient id={`vb-shell-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f1f5f9" />
              <stop offset="28%" stopColor="#cbd5e1" />
              <stop offset="55%" stopColor="#64748b" />
              <stop offset="100%" stopColor="#1e293b" />
            </linearGradient>
            <linearGradient id={`vb-tip-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#e2e8f0" />
              <stop offset="100%" stopColor="#475569" />
            </linearGradient>
            <linearGradient id={`vb-fill-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor={fillColor} stopOpacity="1" />
              <stop offset="55%" stopColor={fillColor} stopOpacity="0.92" />
              <stop offset="100%" stopColor={fillColor} stopOpacity="0.78" />
            </linearGradient>
            <linearGradient id={`vb-fill-shine-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="45%" stopColor="#ffffff" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`vb-glass-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
              <stop offset="35%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.08" />
            </linearGradient>
            <clipPath id={`vb-clip-${uid}`}>
              <rect x={wellX} y={wellY} width={wellW} height={wellH} rx={wellR} ry={wellR} />
            </clipPath>
            <filter id={`vb-shadow-${uid}`} x="-20%" y="-10%" width="140%" height="130%">
              <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.28" />
            </filter>
          </defs>

          <g filter={`url(#vb-shadow-${uid})`}>
            <rect
              x={tipX}
              y="10"
              width={tipW}
              height={tipH}
              rx="4"
              fill={`url(#vb-tip-${uid})`}
              stroke="#334155"
              strokeWidth="1"
            />

            <rect
              x={shellX}
              y={shellY}
              width={shellW}
              height={shellH}
              rx={shellR}
              ry={shellR}
              fill={`url(#vb-shell-${uid})`}
              stroke="#0f172a"
              strokeWidth="1.5"
            />

            <rect
              x={wellX - 2}
              y={wellY - 2}
              width={wellW + 4}
              height={wellH + 4}
              rx={wellR + 1}
              ry={wellR + 1}
              fill="#f8fafc"
              stroke="#e2e8f0"
              strokeWidth="1"
            />

            <g clipPath={`url(#vb-clip-${uid})`}>
              <rect x={wellX} y={wellY} width={wellW} height={wellH} fill="#1e293b" opacity="0.35" />
              {fillH > 0.5 ? (
                <>
                  <rect
                    x={wellX}
                    y={fillY}
                    width={wellW}
                    height={fillH + 0.5}
                    fill={`url(#vb-fill-${uid})`}
                  />
                  <rect
                    x={wellX + 3}
                    y={fillY}
                    width={wellW - 6}
                    height={Math.min(fillH * 0.55, wellH * 0.45)}
                    fill={`url(#vb-fill-shine-${uid})`}
                    rx="4"
                  />
                </>
              ) : null}
              <rect
                x={wellX + 4}
                y={wellY + 6}
                width="14"
                height={wellH - 12}
                fill={`url(#vb-glass-${uid})`}
                rx="6"
              />
            </g>

            <rect
              x={shellX}
              y={shellY}
              width={shellW}
              height={shellH}
              rx={shellR}
              ry={shellR}
              fill="none"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth="1.2"
            />
          </g>
        </svg>

        <div
          className="bsd-battery-level__label"
          style={{ color: valueColor, top: `${labelTopPct}%` }}
        >
          <span className="bsd-battery-level__value">{pctLabel}</span>
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
