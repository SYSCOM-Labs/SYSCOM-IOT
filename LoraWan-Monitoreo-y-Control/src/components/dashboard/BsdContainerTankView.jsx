import React, { useId, useMemo } from 'react';

/** Línea ondulada orgánica (superficie del agua vista desde abajo). */
function buildSurfaceRippleLine(width, baseY, amplitude, phase = 0) {
  const n = 14;
  const seg = width / n;
  let d = `M 0 ${baseY}`;
  for (let i = 0; i < n; i += 1) {
    const x1 = i * seg + seg * 0.33;
    const x2 = i * seg + seg * 0.66;
    const x3 = (i + 1) * seg;
    const w1 = Math.sin(phase + i * 0.85) * amplitude;
    const w2 = Math.cos(phase + i * 1.15 + 0.4) * amplitude * 0.85;
    const w3 = Math.sin(phase + i * 1.45 + 0.9) * amplitude * 0.65;
    d += ` C ${x1} ${baseY + w1} ${x2} ${baseY + w2} ${x3} ${baseY + w3}`;
  }
  return d;
}

/** Trazos tipo cáusticas bajo la superficie. */
function buildCausticPaths(width, height) {
  const paths = [];
  const rows = 7;
  for (let i = 0; i < rows; i += 1) {
    const y = height * (0.12 + (i / rows) * 0.82);
    const x0 = width * (0.05 + (i % 3) * 0.04);
    const x1 = width * (0.28 + Math.sin(i * 1.3) * 0.12);
    const x2 = width * (0.52 + Math.cos(i * 0.9) * 0.14);
    const x3 = width * (0.78 + Math.sin(i * 1.7) * 0.08);
    const lift = height * (0.12 + (i % 2) * 0.06);
    paths.push(
      `M ${x0} ${y} Q ${x1} ${y - lift} ${x2} ${y + lift * 0.35} T ${x3} ${y - lift * 0.25}`
    );
  }
  return paths;
}

/**
 * Tinaco / tanque de almacenamiento (referencia industrial azul): cilindro, aros, cúpula y nivel.
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

  const cx = 100;
  /** Cilindro más ancho y alto; cúpula baja (~12 % del alto total). */
  const bodyLeft = 30;
  const bodyRight = 170;
  const bodyTop = 66;
  const bodyBottom = 198;
  const coneApex = 50;
  const bodyH = bodyBottom - bodyTop;
  const fillH = (bodyH * t) / 100;
  const fillY = bodyBottom - fillH;
  const ribStep = bodyH / 5;
  const ribYs = [1, 2, 3, 4].map((i) => Math.round(bodyTop + ribStep * i));

  const labelTopPct = Math.min(64, Math.max(34, 32 + (100 - t) * 0.26));
  const valueColor =
    titleColor != null && String(titleColor).trim() !== '' ? String(titleColor).trim() : '#0f172a';

  const bodyPath = `M ${bodyLeft} ${bodyBottom} Q ${bodyLeft} ${bodyBottom + 8} ${cx} ${bodyBottom + 10} Q ${bodyRight} ${bodyBottom + 8} ${bodyRight} ${bodyBottom} L ${bodyRight} ${bodyTop} L ${bodyLeft} ${bodyTop} Z`;
  const conePath = `M ${bodyLeft} ${bodyTop} L ${cx} ${coneApex} L ${bodyRight} ${bodyTop} Z`;
  const viewBox = `${bodyLeft - 10} ${coneApex - 6} ${bodyRight - bodyLeft + 20} ${bodyBottom - coneApex + 18}`;
  const innerW = bodyRight - bodyLeft;
  const surfaceBandH = Math.min(36, Math.max(16, fillH * 0.28));
  const rippleAmp = Math.min(4.5, Math.max(2, surfaceBandH * 0.14));
  const causticPaths = useMemo(() => buildCausticPaths(innerW, surfaceBandH), [innerW, surfaceBandH]);
  const rippleLineA = useMemo(
    () => buildSurfaceRippleLine(innerW, rippleAmp * 0.9, rippleAmp, 0),
    [innerW, rippleAmp]
  );
  const rippleLineB = useMemo(
    () => buildSurfaceRippleLine(innerW, rippleAmp * 1.1, rippleAmp * 0.75, 1.2),
    [innerW, rippleAmp]
  );

  return (
    <div className="bsd-container-tank">
      <div className="bsd-container-tank__stage">
        <svg
          className="bsd-container-tank__svg"
          viewBox={viewBox}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          <defs>
            <linearGradient id={`tk-body-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#1d4f8c" />
              <stop offset="18%" stopColor="#3b82c4" />
              <stop offset="42%" stopColor="#5ba3e8" />
              <stop offset="58%" stopColor="#4a90d9" />
              <stop offset="82%" stopColor="#2563a8" />
              <stop offset="100%" stopColor="#1e3f6f" />
            </linearGradient>
            <linearGradient id={`tk-body-v-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
            </linearGradient>
            <linearGradient id={`tk-cone-${uid}`} x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#3d7cc4" />
              <stop offset="50%" stopColor="#5eb0f0" />
              <stop offset="100%" stopColor="#2a5f9e" />
            </linearGradient>
            <linearGradient id={`tk-shine-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
              <stop offset="35%" stopColor="#ffffff" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`tk-liquid-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="#e8fcff" stopOpacity="0.95" />
              <stop offset="12%" stopColor="#b8f0fa" stopOpacity="0.9" />
              <stop offset="28%" stopColor={fillColor} stopOpacity="0.9" />
              <stop offset="100%" stopColor={fillColor} stopOpacity="0.78" />
            </linearGradient>
            <radialGradient id={`tk-surface-glow-${uid}`} cx="50%" cy="0%" r="85%" fx="50%" fy="0%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.82" />
              <stop offset="35%" stopColor="#b8f8ff" stopOpacity="0.45" />
              <stop offset="100%" stopColor={fillColor} stopOpacity="0" />
            </radialGradient>
            <filter id={`tk-surface-turb-${uid}`} x="-8%" y="-30%" width="116%" height="160%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.018 0.07"
                numOctaves="2"
                seed="4"
                result="noise"
              >
                <animate
                  attributeName="baseFrequency"
                  values="0.014 0.055;0.024 0.09;0.014 0.055"
                  dur="9s"
                  repeatCount="indefinite"
                />
                <animate attributeName="seed" values="4;8;4" dur="14s" repeatCount="indefinite" />
              </feTurbulence>
              <feColorMatrix
                type="matrix"
                values="0 0 0 0 0.75  0 0 0 0 0.98  0 0 0 0 1  0 0 0 0.42 0"
                in="noise"
                result="cyan"
              />
              <feGaussianBlur in="cyan" stdDeviation="0.65" />
            </filter>
            <linearGradient id={`tk-empty-${uid}`} x1="50%" y1="0%" x2="50%" y2="100%">
              <stop offset="0%" stopColor="#1a3d66" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#0f2847" stopOpacity="0.35" />
            </linearGradient>
            <clipPath id={`tk-body-clip-${uid}`}>
              <path d={bodyPath} />
            </clipPath>
            <clipPath id={`tk-liquid-clip-${uid}`}>
              <rect x={bodyLeft} y={fillY} width={innerW} height={Math.max(0, fillH + 1)} />
            </clipPath>
            <filter id={`tk-shadow-${uid}`} x="-20%" y="-8%" width="140%" height="125%">
              <feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#0f172a" floodOpacity="0.35" />
            </filter>
          </defs>

          <ellipse cx={cx} cy={bodyBottom + 12} rx="62" ry="6" fill="rgba(15,23,42,0.3)" opacity="0.6" />

          <g filter={`url(#tk-shadow-${uid})`}>
            {/* Cuerpo cilíndrico */}
            <path d={bodyPath} fill={`url(#tk-body-${uid})`} stroke="#1a3d66" strokeWidth="1.2" />
            <path d={bodyPath} fill={`url(#tk-body-v-${uid})`} />

            {/* Nivel de agua (interior) */}
            <g clipPath={`url(#tk-body-clip-${uid})`}>
              <rect x={bodyLeft} y={bodyTop} width={innerW} height={bodyH} fill={`url(#tk-empty-${uid})`} />
              {fillH > 2 ? (
                <g clipPath={`url(#tk-liquid-clip-${uid})`} className="bsd-container-tank__liquid">
                  <rect
                    x={bodyLeft}
                    y={fillY}
                    width={innerW}
                    height={fillH + 1}
                    fill={`url(#tk-liquid-${uid})`}
                  />
                  {/* Superficie: luz, turbulencia y cáusticas (solo banda superior) */}
                  <g className="bsd-container-tank__surface" transform={`translate(${bodyLeft}, ${fillY})`}>
                    <rect
                      x={0}
                      y={0}
                      width={innerW}
                      height={surfaceBandH}
                      fill={`url(#tk-surface-glow-${uid})`}
                      className="bsd-container-tank__surface-glow"
                    />
                    <rect
                      x={0}
                      y={0}
                      width={innerW}
                      height={surfaceBandH}
                      fill="#cffafe"
                      opacity="0.35"
                      filter={`url(#tk-surface-turb-${uid})`}
                      className="bsd-container-tank__surface-turb"
                    />
                    <g className="bsd-container-tank__surface-ripples" fill="none">
                      <path
                        d={rippleLineA}
                        stroke="rgba(255,255,255,0.55)"
                        strokeWidth="1.4"
                        className="bsd-container-tank__ripple-line"
                      />
                      <path
                        d={rippleLineB}
                        stroke="rgba(186,245,255,0.45)"
                        strokeWidth="1"
                        className="bsd-container-tank__ripple-line bsd-container-tank__ripple-line--alt"
                      />
                    </g>
                    <g className="bsd-container-tank__surface-caustics" fill="none">
                      {causticPaths.map((d, i) => (
                        <path
                          key={i}
                          d={d}
                          className="bsd-container-tank__caustic-line"
                          style={{ animationDelay: `${(i % 5) * -0.65}s` }}
                        />
                      ))}
                    </g>
                  </g>
                </g>
              ) : null}
            </g>

            {/* Aros horizontales de refuerzo */}
            {ribYs.map((ry) => (
              <g key={ry}>
                <ellipse
                  cx={cx}
                  cy={ry}
                  rx="58"
                  ry="5.5"
                  fill="none"
                  stroke="rgba(15,45,82,0.55)"
                  strokeWidth="3"
                />
                <ellipse
                  cx={cx}
                  cy={ry - 1}
                  rx="56"
                  ry="3"
                  fill="none"
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth="1.2"
                />
              </g>
            ))}

            {/* Brillo lateral izquierdo */}
            <path
              d={`M ${bodyLeft + 8} ${bodyBottom - 6} L ${bodyLeft + 8} ${bodyTop + 8} Q ${bodyLeft + 20} ${bodyTop} ${bodyLeft + 28} ${bodyTop + 12}`}
              fill="none"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth="8"
              strokeLinecap="round"
              opacity="0.45"
            />

            {/* Cúpula cónica */}
            <path d={conePath} fill={`url(#tk-cone-${uid})`} stroke="#1a3d66" strokeWidth="1.1" />
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
              const angle = (Math.PI * (i + 0.5)) / 8;
              const ex = cx + Math.cos(angle) * 58;
              const ey = bodyTop;
              return (
                <line
                  key={i}
                  x1={cx}
                  y1={coneApex + 2}
                  x2={ex}
                  y2={ey}
                  stroke="rgba(20,60,110,0.35)"
                  strokeWidth="1.8"
                />
              );
            })}
            <path d={conePath} fill={`url(#tk-shine-${uid})`} opacity="0.35" />

            {/* Asas de izaje */}
            <path
              d={`M ${bodyLeft + 26} ${bodyTop} Q ${bodyLeft + 14} ${bodyTop - 6} ${bodyLeft + 20} ${bodyTop - 12} Q ${bodyLeft + 24} ${bodyTop - 4} ${bodyLeft + 30} ${bodyTop - 2}`}
              fill="none"
              stroke="#2a5f9e"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <path
              d={`M ${bodyRight - 26} ${bodyTop} Q ${bodyRight - 14} ${bodyTop - 6} ${bodyRight - 20} ${bodyTop - 12} Q ${bodyRight - 24} ${bodyTop - 4} ${bodyRight - 30} ${bodyTop - 2}`}
              fill="none"
              stroke="#2a5f9e"
              strokeWidth="3.5"
              strokeLinecap="round"
            />

            {/* Tapa central superior */}
            <circle cx={cx} cy={coneApex + 1} r="7" fill="#3d7cc4" stroke="#1a3d66" strokeWidth="1" />
            <circle cx={cx} cy={coneApex + 1} r="4" fill="#6eb3f5" stroke="#2563a8" strokeWidth="0.8" />
            <circle cx={cx} cy={coneApex + 1} r="1.6" fill="#1e3f6f" />
          </g>
        </svg>

        <div
          className="bsd-container-tank__hub"
          style={{ color: valueColor, top: `${labelTopPct}%` }}
        >
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
