import React, { useMemo } from 'react';
import './SemicircleGauge.css';

/**
 * Gauge semicircular (arco superior). Ángulos: π (izq) → 0 (der).
 */
export default function SemicircleGauge({
  value,
  unit = '',
  decimals = 2,
  scaleMin,
  scaleMax,
  ranges,
  title,
  titleColor = '#f97316',
  subtitleColor,
  subtitle = '',
  compact = false,
  /** Si viene, sustituye el número formateado bajo el arco (p. ej. Short / Long). */
  centerLabel,
  /** Menor valor en escala = mayor llenado del arco (p. ej. distancia ultrasónica). El color por rangos sigue siendo según la lectura real. */
  inverseFill = false,
}) {
  const min = Number.isFinite(scaleMin) ? scaleMin : 0;
  const max = Number.isFinite(scaleMax) && scaleMax > min ? scaleMax : min + 1;
  const v = Number.isFinite(parseFloat(value)) ? parseFloat(value) : min;
  const clamped = Math.min(max, Math.max(min, v));
  const arcVal = inverseFill ? min + max - clamped : clamped;

  const sorted = useMemo(() => {
    const list = Array.isArray(ranges) ? [...ranges] : [];
    list.sort((a, b) => Number(a.value) - Number(b.value));
    return list;
  }, [ranges]);

  /** Misma lógica que la barra lineal: un solo color según el tramo donde cae el valor. */
  const barColor = useMemo(() => {
    if (!sorted.length) return 'rgba(99, 102, 241, 0.92)';
    for (let i = 0; i < sorted.length; i++) {
      if (clamped <= Number(sorted[i].value)) return sorted[i].color || '#6366f1';
    }
    return sorted[sorted.length - 1]?.color || '#6366f1';
  }, [sorted, clamped]);

  const cx = 100;
  const cy = 88;
  const r = compact ? 58 : 72;
  const sw = compact ? 10 : 12;

  const valToAngle = (val) => Math.PI * (1 - (val - min) / (max - min || 1));

  const arcPath = (a0, a1) => {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p0 = { x: cx + r * Math.cos(a0), y: cy - r * Math.sin(a0) };
    const p1 = { x: cx + r * Math.cos(a1), y: cy - r * Math.sin(a1) };
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 0 ${p1.x} ${p1.y}`;
  };

  const needleAngle = valToAngle(arcVal);
  const nLen = r * 0.78;
  const nx = cx + nLen * Math.cos(needleAngle);
  const ny = cy - nLen * Math.sin(needleAngle);

  const trackColor = 'rgba(15, 23, 42, 0.12)';
  const fullArcD = arcPath(Math.PI, 0);
  const span = max - min || 1;
  const hasProgress = Math.abs(arcVal - min) > span * 1e-9;
  const progressD = hasProgress ? arcPath(Math.PI, needleAngle) : '';

  const ticks = useMemo(() => {
    const n = 4;
    const arr = [];
    for (let i = 0; i <= n; i++) {
      const t = min + ((max - min) * i) / n;
      arr.push(t);
    }
    return arr;
  }, [min, max]);

  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(decimals > 0 ? decimals : 0) : '—');
  const useCustomCenter = centerLabel != null && String(centerLabel).trim().length > 0;
  const centerText = useCustomCenter ? String(centerLabel).trim() : fmt(clamped);
  const subColor = subtitleColor != null && String(subtitleColor).trim() !== '' ? subtitleColor : titleColor;

  return (
    <div className={`semicircle-gauge ${compact ? 'semicircle-gauge--compact' : ''}`}>
      {(title || subtitle) && (
        <div className="semicircle-gauge__meta">
          {title && (
            <div className="semicircle-gauge__title" style={{ color: titleColor }}>
              {title}
            </div>
          )}
          {subtitle && (
            <div className="semicircle-gauge__sub" style={{ color: subColor }}>
              {subtitle}
            </div>
          )}
        </div>
      )}
      <svg viewBox="0 0 200 120" className="semicircle-gauge__svg" aria-hidden>
        <path
          d={fullArcD}
          fill="none"
          stroke={trackColor}
          strokeWidth={sw}
          strokeLinecap="round"
        />
        {hasProgress ? (
          <path
            d={progressD}
            fill="none"
            stroke={barColor}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        ) : null}
        <line
          x1={cx}
          y1={cy}
          x2={nx}
          y2={ny}
          stroke={barColor}
          strokeWidth={compact ? 2.5 : 3}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={compact ? 5 : 6} fill={barColor} />
        {ticks.map((t, i) => {
          const ang = valToAngle(t);
          const x1 = cx + (r + 4) * Math.cos(ang);
          const y1 = cy - (r + 4) * Math.sin(ang);
          const x2 = cx + (r + 12) * Math.cos(ang);
          const y2 = cy - (r + 12) * Math.sin(ang);
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.2)" strokeWidth={1} />
              <text
                x={cx + (r + 22) * Math.cos(ang)}
                y={cy - (r + 22) * Math.sin(ang) + 4}
                fontSize="9"
                fill="#64748b"
                textAnchor="middle"
              >
                {fmt(t)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="semicircle-gauge__value-block">
        <span className="semicircle-gauge__value">{centerText}</span>
        {unit && !useCustomCenter ? <span className="semicircle-gauge__unit">{unit}</span> : null}
      </div>
    </div>
  );
}
