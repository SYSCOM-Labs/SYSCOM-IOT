import React from 'react';
import {
  VALUE_DATE_FILTER_PRESETS,
  VALUE_DATE_FILTER_OPERATIONS,
  normalizeValueDateFilterPreset,
  normalizeValueDateFilterOperation,
} from './widgetConfigUtils';

/**
 * Botones Día / Semana / Mes / Personalizado (y En vivo).
 * `variant`: `modal` (edición) o `widget` (tablero, reutiliza estilo de gráficos).
 */
export function ValueWidgetDateFilterButtons({ activePreset, onSelect, variant = 'modal', hideLive = false }) {
  const active = normalizeValueDateFilterPreset(activePreset);
  const presets = hideLive ? VALUE_DATE_FILTER_PRESETS.filter((p) => p.id !== 'live') : VALUE_DATE_FILTER_PRESETS;
  const rowClass = variant === 'widget' ? 'bsd-bar-chart-presets bsd-value-date-filter' : 'widget-edit-granularity-row';
  return (
    <div className={rowClass} role="group" aria-label="Filtro por fechas">
      {presets.map((p) => {
        const isActive = active === p.id;
        const btnClass =
          variant === 'widget'
            ? `bsd-bar-chart-preset${isActive ? ' active' : ''}`
            : `widget-edit-granularity-btn${isActive ? ' is-active' : ''}`;
        return (
          <button
            key={p.id}
            type="button"
            className={btnClass}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(p.id);
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

export function ValueWidgetDateFilterCustomFields({
  customFrom,
  customTo,
  onChangeFrom,
  onChangeTo,
  onApply,
  showApply = false,
  compact = false,
}) {
  return (
    <div className={compact ? 'bsd-value-date-filter-custom' : 'widget-edit-date-filter-custom'}>
      <label className={compact ? 'bsd-value-date-filter-custom__lab' : 'widget-edit-label'}>
        Desde (día y hora)
        <input
          type="datetime-local"
          className={compact ? 'bsd-value-date-filter-custom__input' : 'widget-edit-input'}
          value={customFrom || ''}
          onChange={(e) => onChangeFrom(e.target.value)}
        />
      </label>
      <label className={compact ? 'bsd-value-date-filter-custom__lab' : 'widget-edit-label'}>
        Hasta (día y hora)
        <input
          type="datetime-local"
          className={compact ? 'bsd-value-date-filter-custom__input' : 'widget-edit-input'}
          value={customTo || ''}
          onChange={(e) => onChangeTo(e.target.value)}
        />
      </label>
      {showApply ? (
        <button type="button" className="bsd-value-date-filter-apply" onClick={onApply}>
          Aplicar rango
        </button>
      ) : null}
    </div>
  );
}

export function ValueWidgetDateFilterOperationSelect({ value, onChange }) {
  const v = normalizeValueDateFilterOperation(value);
  return (
    <label className="widget-edit-label">
      Operación del periodo
      <select className="widget-edit-input" value={v} onChange={(e) => onChange(e.target.value)}>
        {VALUE_DATE_FILTER_OPERATIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
