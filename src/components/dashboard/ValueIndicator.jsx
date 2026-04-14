import React, { useMemo } from 'react';
import SemicircleGauge from './SemicircleGauge';
import { normalizeIndicatorType } from './valueIndicatorUtils';
import './ValueIndicator.css';

/**
 * @param {{
 *   type?: string;
 *   value: number;
 *   unit?: string;
 *   decimals?: number;
 *   scaleMin?: number;
 *   scaleMax?: number;
 *   ranges?: Array<{ value: number; color?: string }>;
 *   title?: string;
 *   titleColor?: string;
 *   subtitle?: string;
 *   compact?: boolean;
 *   theme?: 'dark' | 'light';
 *   historySeries?: number[];
 * }} props
 */
export default function ValueIndicator({
  type = 'numeric',
  value,
  unit = '',
  decimals = 2,
  scaleMin = 0,
  scaleMax = 100,
  ranges = [],
  title = '',
  titleColor = '#f97316',
  subtitle = '',
  compact = false,
  theme = 'light',
  historySeries,
}) {
  const kind = normalizeIndicatorType(type);
  const min = Number.isFinite(Number(scaleMin)) ? Number(scaleMin) : 0;
  const max = Number.isFinite(Number(scaleMax)) && Number(scaleMax) > min ? Number(scaleMax) : min + 1;
  const v = Number(value);
  const n = Number.isFinite(v) ? v : min;
  const clamped = Math.min(max, Math.max(min, n));
  const pct = max > min ? (clamped - min) / (max - min) : 0;
  const d = Math.min(6, Math.max(0, Number(decimals) || 0));
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(d) : '—');
  const dark = theme === 'dark';

  const barColor = useMemo(() => {
    if (!ranges.length) return dark ? '#818cf8' : '#6366f1';
    const sorted = [...ranges].sort((a, b) => Number(a.value) - Number(b.value));
    for (let i = 0; i < sorted.length; i++) {
      if (clamped <= Number(sorted[i].value)) return sorted[i].color || '#6366f1';
    }
    return sorted[sorted.length - 1]?.color || '#6366f1';
  }, [ranges, clamped, dark]);

  if (kind === 'circular') {
    return (
      <SemicircleGauge
        value={clamped}
        unit={unit}
        decimals={d}
        scaleMin={min}
        scaleMax={max}
        ranges={ranges}
        title={title}
        titleColor={titleColor}
        subtitle={subtitle}
        compact={compact}
      />
    );
  }

  if (kind === 'none') {
    return (
      <div className={`vi-none ${compact ? 'vi-none--compact' : ''} ${dark ? 'vi-none--dark' : ''}`}>
        {title ? (
          <div className="vi-none__title" style={{ color: titleColor }}>
            {title}
          </div>
        ) : null}
        {subtitle ? <div className="vi-none__sub">{subtitle}</div> : null}
        <div className="vi-none__val">
          {fmt(clamped)}
          {unit ? <span className="vi-none__unit">{unit}</span> : null}
        </div>
      </div>
    );
  }

  if (kind === 'linear') {
    const series = Array.isArray(historySeries) ? historySeries.filter((x) => Number.isFinite(Number(x))) : [];
    const spark =
      series.length > 1
        ? (() => {
            const lo = Math.min(...series, min);
            const hi = Math.max(...series, max);
            const span = hi > lo ? hi - lo : 1;
            const pts = series
              .map((v, i) => {
                const x = (i / Math.max(1, series.length - 1)) * 100;
                const y = 100 - ((Number(v) - lo) / span) * 100;
                return `${x},${Math.min(100, Math.max(0, y))}`;
              })
              .join(' ');
            return pts;
          })()
        : null;
    return (
      <div className={`vi-linear ${compact ? 'vi-linear--compact' : ''} ${dark ? 'vi-linear--dark' : ''}`}>
        {(title || subtitle) && (
          <div className="vi-linear__meta">
            {title ? (
              <div className="vi-linear__title" style={{ color: titleColor }}>
                {title}
              </div>
            ) : null}
            {subtitle ? <div className="vi-linear__sub">{subtitle}</div> : null}
          </div>
        )}
        <div className="vi-linear__track">
          <div className="vi-linear__fill" style={{ width: `${pct * 100}%`, background: barColor }} />
        </div>
        {spark ? (
          <svg className="vi-linear__spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polyline fill="none" stroke={barColor} strokeWidth="3" vectorEffect="non-scaling-stroke" points={spark} />
          </svg>
        ) : null}
        <div className="vi-linear__val">
          {fmt(clamped)} {unit}
        </div>
      </div>
    );
  }

  if (kind === 'vertical' || kind === 'fill') {
    return (
      <div className={`vi-vertical ${compact ? 'vi-vertical--compact' : ''} ${dark ? 'vi-vertical--dark' : ''}`}>
        {(title || subtitle) && (
          <div className="vi-vertical__meta">
            {title ? (
              <div className="vi-vertical__title" style={{ color: titleColor }}>
                {title}
              </div>
            ) : null}
            {subtitle ? <div className="vi-vertical__sub">{subtitle}</div> : null}
          </div>
        )}
        <div className="vi-vertical__body">
          <div className="vi-vertical__track">
            <div className="vi-vertical__fill" style={{ height: `${pct * 100}%`, background: barColor }} />
          </div>
          <div className="vi-vertical__val">
            {fmt(clamped)} <span>{unit}</span>
          </div>
        </div>
      </div>
    );
  }

  if (kind === 'battery') {
    return (
      <div className={`vi-battery ${compact ? 'vi-battery--compact' : ''} ${dark ? 'vi-battery--dark' : ''}`}>
        {(title || subtitle) && (
          <div className="vi-battery__meta">
            {title ? (
              <div className="vi-battery__title" style={{ color: titleColor }}>
                {title}
              </div>
            ) : null}
            {subtitle ? <div className="vi-battery__sub">{subtitle}</div> : null}
          </div>
        )}
        <div className="vi-battery__shell">
          <div className="vi-battery__tip" />
          <div className="vi-battery__inner">
            <div className="vi-battery__level" style={{ width: `${pct * 100}%`, background: barColor }} />
          </div>
        </div>
        <div className="vi-battery__val">
          {fmt(clamped)}
          {unit ? ` ${unit}` : ''}
        </div>
      </div>
    );
  }

  if (kind === 'compass') {
    const deg = ((clamped - min) / (max - min || 1)) * 360;
    return (
      <div className={`vi-compass ${compact ? 'vi-compass--compact' : ''} ${dark ? 'vi-compass--dark' : ''}`}>
        {(title || subtitle) && (
          <div className="vi-compass__meta">
            {title ? (
              <div className="vi-compass__title" style={{ color: titleColor }}>
                {title}
              </div>
            ) : null}
            {subtitle ? <div className="vi-compass__sub">{subtitle}</div> : null}
          </div>
        )}
        <div className="vi-compass__dial">
          <svg viewBox="0 0 100 100" className="vi-compass__svg" aria-hidden>
            <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <text x="50" y="18" textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.6">
              N
            </text>
            <g transform={`rotate(${deg - 90} 50 50)`}>
              <polygon points="50,14 46,50 50,44 54,50" fill={barColor} />
            </g>
            <circle cx="50" cy="50" r="4" fill={barColor} />
          </svg>
        </div>
        <div className="vi-compass__val">
          {fmt(clamped)}
          {unit ? ` ${unit}` : '°'}
        </div>
      </div>
    );
  }

  /* numeric default */
  return (
    <div className={`vi-numeric ${compact ? 'vi-numeric--compact' : ''} ${dark ? 'vi-numeric--dark' : ''}`}>
      {title ? (
        <div className="vi-numeric__title" style={{ color: titleColor }}>
          {title}
        </div>
      ) : null}
      {subtitle ? <div className="vi-numeric__sub">{subtitle}</div> : null}
      <div className="vi-numeric__val">
        {fmt(clamped)} {unit ? <span>{unit}</span> : null}
      </div>
    </div>
  );
}
