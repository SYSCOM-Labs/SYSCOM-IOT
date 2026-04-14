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
  subtitle = '',
  compact = false,
}) {
  const min = Number.isFinite(scaleMin) ? scaleMin : 0;
  const max = Number.isFinite(scaleMax) && scaleMax > min ? scaleMax : min + 1;
  const v = Number.isFinite(parseFloat(value)) ? parseFloat(value) : min;
  const clamped = Math.min(max, Math.max(min, v));

  const sorted = useMemo(() => {
    const list = Array.isArray(ranges) ? [...ranges] : [];
    list.sort((a, b) => Number(a.value) - Number(b.value));
    return list;
  }, [ranges]);

  const segments = useMemo(() => {
    if (!sorted.length) {
      return [{ from: min, to: max, color: 'rgba(99,102,241,0.5)' }];
    }
    const out = [];
    let prev = min;
    for (let i = 0; i < sorted.length; i++) {
      const end = Math.min(max, Number(sorted[i].value));
      if (end > prev) {
        out.push({ from: prev, to: end, color: sorted[i].color || '#6366f1' });
        prev = end;
      }
    }
    if (prev < max) {
      out.push({ from: prev, to: max, color: sorted[sorted.length - 1]?.color || '#6366f1' });
    }
    return out;
  }, [sorted, min, max]);

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

  const needleAngle = valToAngle(clamped);
  const nLen = r * 0.78;
  const nx = cx + nLen * Math.cos(needleAngle);
  const ny = cy - nLen * Math.sin(needleAngle);

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

  return (
    <div className={`semicircle-gauge ${compact ? 'semicircle-gauge--compact' : ''}`}>
      {(title || subtitle) && (
        <div className="semicircle-gauge__meta">
          {title && (
            <div className="semicircle-gauge__title" style={{ color: titleColor }}>
              {title}
            </div>
          )}
          {subtitle && <div className="semicircle-gauge__sub">{subtitle}</div>}
        </div>
      )}
      <svg viewBox="0 0 200 120" className="semicircle-gauge__svg" aria-hidden>
        {segments.map((seg, i) => {
          const a0 = valToAngle(seg.from);
          const a1 = valToAngle(seg.to);
          return (
            <path
              key={i}
              d={arcPath(a0, a1)}
              fill="none"
              stroke={seg.color}
              strokeWidth={sw}
              strokeLinecap="round"
            />
          );
        })}
        <line
          x1={cx}
          y1={cy}
          x2={nx}
          y2={ny}
          stroke="#1e1b4b"
          strokeWidth={compact ? 2.5 : 3}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={compact ? 5 : 6} fill="#312e81" />
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
        <span className="semicircle-gauge__value">{fmt(clamped)}</span>
        {unit ? <span className="semicircle-gauge__unit">{unit}</span> : null}
      </div>
    </div>
  );
}
