import React, { useMemo, useState } from 'react';
import { X, Check } from 'lucide-react';
import ValueIndicator from './ValueIndicator';
import { normalizeIndicatorType } from './valueIndicatorUtils';
import {
  mergeWidgetConfig,
  WIDGET_TYPE_OPTIONS,
  WIDGET_PRESETS,
  applyWidgetPresetToDraft,
  dashWidgetIdFromPropertyKey,
  isDashboardFixedWidgetSensor,
  basicsWidgetOptionsForSensor,
  dashboardWidgetSensorStub,
  colorForValueInRanges,
  DASH_WIDGET,
  normalizeDownlinkHex,
  ensureStreamSeriesDraftData,
  defaultStreamSeriesRow,
} from './widgetConfigUtils';
import './WidgetEditModal.css';

function shortHexPreview(hex) {
  const s = String(hex || '').replace(/\s/g, '');
  if (!s) return '—';
  return s.length > 16 ? `${s.slice(0, 14)}…` : s;
}

function parseLiveNumber(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const TRANSLATION_LANGS = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'inglés' },
  { value: 'de', label: 'alemán' },
  { value: 'fr', label: 'francés' },
  { value: 'pt', label: 'portugués' },
];

const TABS = [
  { id: 'basics', label: 'Básicos' },
  { id: 'data', label: 'Datos' },
  { id: 'appearance', label: 'Apariencia' },
  { id: 'gauge', label: 'Indicador' },
];

/** @param {'value' | 'simple' | 'metrics'} editScope */
function tabsForScope(editScope) {
  if (editScope === 'simple') return TABS.filter((t) => t.id === 'basics' || t.id === 'appearance');
  if (editScope === 'metrics') return TABS.filter((t) => t.id === 'basics' || t.id === 'appearance' || t.id === 'data');
  return TABS;
}

function deepClone(c) {
  return JSON.parse(JSON.stringify(c));
}

const GRID_PREVIEW_FALLBACK = [
  { label: 'Temperatura', value: 23.2, unitFb: '°C' },
  { label: 'Humedad', value: 55, unitFb: '%' },
  { label: 'Presión', value: 1012, unitFb: 'hPa' },
  { label: 'Calidad aire', value: 42, unitFb: 'AQI' },
];

/** Vista previa del bloque «cuadrícula de sensores»: varias tarjetas con el tipo y estilo del borrador. */
function SensorGridWidgetPreview({
  draft,
  indicatorSelectValue,
  previewSubtitle,
  liveProps,
  availableDataFields,
  sensorTitleFallback,
}) {
  const demos = useMemo(() => {
    const u =
      draft.data?.unit != null && String(draft.data.unit).trim() ? String(draft.data.unit).trim() : '';
    const keys = (availableDataFields || []).filter((k) => k && !String(k).startsWith('__bsd')).slice(0, 4);
    if (keys.length) {
      return keys.map((k, i) => {
        const n = parseLiveNumber(liveProps[k]);
        const fb = GRID_PREVIEW_FALLBACK[i] ?? GRID_PREVIEW_FALLBACK[0];
        return {
          key: k,
          label: k.replace(/_/g, ' '),
          value: n != null ? n : fb.value,
          unit: u || fb.unitFb,
        };
      });
    }
    return GRID_PREVIEW_FALLBACK.map((f, i) => ({
      key: `demo_${i}`,
      label: f.label,
      value: f.value,
      unit: u || f.unitFb,
    }));
  }, [availableDataFields, liveProps, draft.data]);

  const dec = Number(draft.data?.decimals) || 1;
  const scaleMin = Number(draft.gauge?.scaleMin) || 0;
  const scaleMax = Number(draft.gauge?.scaleMax) || 50;
  const ranges = draft.gauge?.ranges || [];
  const titleColor = draft.appearance?.titleColor || '#f97316';
  const gridTitle = draft.basics?.title || sensorTitleFallback || 'Cuadrícula de sensores';
  const indType = normalizeIndicatorType(indicatorSelectValue);
  const useNumeric = indType === 'numeric';

  return (
    <div className="widget-edit-sensor-grid-preview">
      <div className="widget-edit-sensor-grid-preview__head">
        <div className="widget-edit-sensor-grid-preview__title" style={{ color: titleColor }}>
          {gridTitle}
        </div>
        <div className="widget-edit-sensor-grid-preview__sub">{previewSubtitle}</div>
        <p className="widget-edit-sensor-grid-preview__hint">
          Vista de ejemplo: cada sensor del dispositivo tendrá su tarjeta con este tipo de indicador, colores y escala.
        </p>
      </div>
      <div className="widget-edit-sensor-grid-preview__grid">
        {demos.map((d) => {
          const accent = colorForValueInRanges(d.value, ranges, scaleMin, scaleMax);
          const cellStyle = accent
            ? { borderColor: `${accent}aa`, boxShadow: `0 0 14px ${accent}38` }
            : undefined;
          if (useNumeric) {
            const v =
              typeof d.value === 'number' && !Number.isInteger(d.value) ? d.value.toFixed(dec) : d.value;
            return (
              <div
                key={d.key}
                className="widget-edit-sensor-grid-preview__cell widget-edit-sensor-grid-preview__cell--numeric"
                style={cellStyle}
              >
                <div className="widget-edit-sensor-grid-preview__cell-icon" aria-hidden>
                  📟
                </div>
                <div className="widget-edit-sensor-grid-preview__cell-name">{d.label}</div>
                <div className="widget-edit-sensor-grid-preview__cell-val">
                  {v}
                  <span className="widget-edit-sensor-grid-preview__cell-unit">{d.unit}</span>
                </div>
              </div>
            );
          }
          return (
            <div key={d.key} className="widget-edit-sensor-grid-preview__cell" style={cellStyle}>
              <ValueIndicator
                type={indicatorSelectValue}
                value={d.value}
                unit={d.unit}
                decimals={dec}
                scaleMin={scaleMin}
                scaleMax={scaleMax}
                ranges={ranges}
                title={d.label}
                titleColor={titleColor}
                subtitle=""
                compact
                theme="dark"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function WidgetEditModal({
  open,
  onClose,
  sensor,
  initialConfig,
  onSave,
  editScope = 'value',
  liveProps = {},
  availableDataFields = [],
  loadDashboardWidgetConfig,
  resolveDashboardStorageKey,
  availableDownlinks = [],
}) {
  const [tab, setTab] = useState(() => {
    if (!sensor) return 'data';
    return editScope === 'value' ? (isDashboardFixedWidgetSensor(sensor) ? 'basics' : 'data') : 'basics';
  });
  const [fieldSearch, setFieldSearch] = useState('');
  const [targetDashWidgetId, setTargetDashWidgetId] = useState(() => {
    if (!sensor || !isDashboardFixedWidgetSensor(sensor)) return null;
    const wid = dashWidgetIdFromPropertyKey(sensor.propertyKey);
    const opts = basicsWidgetOptionsForSensor(sensor);
    const ids = new Set(opts.map((o) => o.id));
    return wid && ids.has(wid) ? wid : opts[0]?.id ?? null;
  });
  const [draft, setDraft] = useState(() => {
    if (!sensor) {
      return mergeWidgetConfig(
        { name: '', propertyKey: 'x', unit: '', threshold: 50, value: 0, sourceDeviceId: 'demo' },
        null
      );
    }
    let base = mergeWidgetConfig(sensor, initialConfig);
    if (isDashboardFixedWidgetSensor(sensor) && dashWidgetIdFromPropertyKey(sensor.propertyKey) === DASH_WIDGET.STREAM) {
      base = deepClone(base);
      base.data = ensureStreamSeriesDraftData(base.data || {});
    }
    return base;
  });

  const dashboardBasicOptions = useMemo(() => basicsWidgetOptionsForSensor(sensor), [sensor]);

  /** Valor mostrado en la vista previa: en vivo si existe; si no, punto medio de la escala para ver colores/tipo. */
  const previewValue = useMemo(() => {
    const key = draft.data?.fieldKey || sensor?.propertyKey;
    if (liveProps && key != null && liveProps[key] !== undefined) {
      const n = parseLiveNumber(liveProps[key]);
      if (n != null) return n;
    }
    const fromSensor = parseLiveNumber(sensor?.value);
    if (fromSensor != null) return fromSensor;
    const min = Number(draft.gauge?.scaleMin);
    const max = Number(draft.gauge?.scaleMax);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) && max > lo ? max : lo + 50;
    return lo + (hi - lo) * 0.55;
  }, [
    draft.data?.fieldKey,
    draft.gauge?.scaleMin,
    draft.gauge?.scaleMax,
    liveProps,
    sensor?.propertyKey,
    sensor?.value,
  ]);

  const previewUsesLiveValue = useMemo(() => {
    const key = draft.data?.fieldKey || sensor?.propertyKey;
    if (liveProps && key != null && liveProps[key] !== undefined) {
      const n = parseLiveNumber(liveProps[key]);
      if (n != null) return true;
    }
    return parseLiveNumber(sensor?.value) != null;
  }, [draft.data?.fieldKey, liveProps, sensor?.propertyKey, sensor?.value]);

  const previewSubtitle = useMemo(() => {
    if (!previewUsesLiveValue) return 'Vista previa · valor de ejemplo (ajusta escala y rangos)';
    if (editScope !== 'value') return 'Vista previa';
    if (sensor?.sourceDeviceId === 'dashboard') return 'Vista previa · refleja cambios al instante';
    return 'Valor en vivo';
  }, [editScope, previewUsesLiveValue, sensor?.sourceDeviceId]);

  const indicatorSelectValue = useMemo(() => {
    const raw = draft.gauge?.indicatorType || 'numeric';
    const n = normalizeIndicatorType(raw);
    if (WIDGET_TYPE_OPTIONS.some((o) => o.value === n)) return n;
    return 'numeric';
  }, [draft.gauge?.indicatorType]);

  const fieldOptions = useMemo(() => {
    const fk = draft.data?.fieldKey;
    const set = new Set(availableDataFields);
    if (fk && String(fk).trim()) set.add(String(fk).trim());
    const q = fieldSearch.trim().toLowerCase();
    return [...set].filter((k) => !q || k.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [availableDataFields, draft.data?.fieldKey, fieldSearch]);

  const previewDashWidgetId = useMemo(() => {
    if (isDashboardFixedWidgetSensor(sensor) && targetDashWidgetId) return targetDashWidgetId;
    return dashWidgetIdFromPropertyKey(sensor?.propertyKey);
  }, [sensor, targetDashWidgetId]);

  const showDownlinkDataSection =
    previewDashWidgetId === DASH_WIDGET.SWITCH || previewDashWidgetId === DASH_WIDGET.DOWNLINK;

  const showStreamDataSection = previewDashWidgetId === DASH_WIDGET.STREAM;

  const hideGaugeForWidget = showDownlinkDataSection || showStreamDataSection;

  const visibleTabs = useMemo(() => {
    let tabs = tabsForScope(editScope);
    if (hideGaugeForWidget) tabs = tabs.filter((t) => t.id !== 'gauge');
    return tabs;
  }, [editScope, hideGaugeForWidget]);

  /** Si la pestaña «Indicador» deja de existir, mostramos «Datos» sin setState en un effect (reglas React Compiler / eslint). */
  const activeTab = tab === 'gauge' && hideGaugeForWidget ? 'data' : tab;

  const downlinkSelectState = useMemo(() => {
    const dlList = Array.isArray(availableDownlinks) ? availableDownlinks : [];
    const swOnN = normalizeDownlinkHex(draft.data?.switchHexOn);
    const swOffN = normalizeDownlinkHex(draft.data?.switchHexOff);
    const defDlN = normalizeDownlinkHex(draft.data?.downlinkDefaultHex);
    const listed = (n) => !!(n && dlList.some((d) => normalizeDownlinkHex(d.hex) === n));
    return {
      dlList,
      swOnN,
      swOffN,
      defDlN,
      swOnListed: listed(swOnN),
      swOffListed: listed(swOffN),
      defListed: listed(defDlN),
    };
  }, [
    availableDownlinks,
    draft.data?.switchHexOn,
    draft.data?.switchHexOff,
    draft.data?.downlinkDefaultHex,
  ]);

  const streamSeriesFieldOptions = useMemo(() => {
    const set = new Set(availableDataFields);
    const rows = draft.data?.streamSeries;
    if (Array.isArray(rows)) {
      rows.forEach((r) => {
        if (r?.fieldKey && String(r.fieldKey).trim()) set.add(String(r.fieldKey).trim());
      });
    }
    const q = fieldSearch.trim().toLowerCase();
    return [...set].filter((k) => !q || k.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [availableDataFields, draft.data?.streamSeries, fieldSearch]);

  const showSensorGridPreview = previewDashWidgetId === DASH_WIDGET.SENSOR_GRID;

  if (!open || !sensor) return null;

  const update = (path, val) => {
    setDraft((d) => {
      const next = deepClone(d);
      const keys = path.split('.');
      let o = next;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
      }
      o[keys[keys.length - 1]] = val;
      return next;
    });
  };

  const addRangeRow = () => {
    const ranges = [...(draft.gauge?.ranges || [])];
    const last = ranges[ranges.length - 1];
    const nextVal = last ? Number(last.value) + 10 : 10;
    ranges.push({
      id: `r_${Date.now()}`,
      name: '',
      value: nextVal,
      color: '#48bb78',
    });
    update('gauge.ranges', ranges);
  };

  const removeRangeRow = (id) => {
    const ranges = (draft.gauge?.ranges || []).filter((r) => r.id !== id);
    if (ranges.length) update('gauge.ranges', ranges);
  };

  const updateRange = (id, field, val) => {
    const ranges = (draft.gauge?.ranges || []).map((r) =>
      r.id === id ? { ...r, [field]: field === 'value' ? parseFloat(val) || 0 : val } : r
    );
    update('gauge.ranges', ranges);
  };

  const handleSave = () => {
    const cfg = deepClone(draft);
    const dashWid = isDashboardFixedWidgetSensor(sensor) ? dashWidgetIdFromPropertyKey(sensor.propertyKey) : null;
    if (dashWid === DASH_WIDGET.STREAM) {
      const rows = cfg.data?.streamSeries;
      if (Array.isArray(rows) && rows[0]?.fieldKey) {
        cfg.data = cfg.data || {};
        cfg.data.fieldKey = String(rows[0].fieldKey).trim();
      }
    }
    const saveToDashboardTarget =
      isDashboardFixedWidgetSensor(sensor) &&
      typeof resolveDashboardStorageKey === 'function' &&
      targetDashWidgetId;
    if (saveToDashboardTarget) {
      onSave(cfg, { dashboardTargetKey: resolveDashboardStorageKey(targetDashWidgetId) });
    } else {
      onSave(cfg);
    }
    onClose();
  };

  return (
    <div className="widget-edit-overlay" role="dialog" aria-modal="true" aria-labelledby="widget-edit-title">
      <div className="widget-edit-modal">
        <div className="widget-edit-head">
          <h2 id="widget-edit-title">
            {editScope === 'value' && sensor?.sourceDeviceId !== 'dashboard'
              ? 'Editar Value widget'
              : 'Editar widget'}
          </h2>
          <button type="button" className="widget-edit-close" onClick={onClose} aria-label="Cerrar">
            <X size={22} />
          </button>
        </div>

        <div className="widget-edit-preview-wrap">
          <div className="widget-edit-preview-heading">
            <span className="widget-edit-preview-heading__title">Vista previa</span>
            <span className="widget-edit-preview-heading__hint">
              Se actualiza al cambiar las pestañas; pulsa Guardar para aplicar en el tablero.
            </span>
          </div>
          <div className="widget-edit-preview">
            {showSensorGridPreview ? (
              <SensorGridWidgetPreview
                draft={draft}
                indicatorSelectValue={indicatorSelectValue}
                previewSubtitle={previewSubtitle}
                liveProps={liveProps}
                availableDataFields={availableDataFields}
                sensorTitleFallback={sensor.name}
              />
            ) : (
              <ValueIndicator
                key={indicatorSelectValue}
                type={indicatorSelectValue}
                value={previewValue}
                unit={draft.data?.unit || ''}
                decimals={Number(draft.data?.decimals) || 0}
                scaleMin={Number(draft.gauge?.scaleMin) || 0}
                scaleMax={Number(draft.gauge?.scaleMax) || 50}
                ranges={draft.gauge?.ranges || []}
                title={draft.basics?.title || sensor.name}
                titleColor={draft.appearance?.titleColor || '#f97316'}
                subtitle={previewSubtitle}
                theme="dark"
              />
            )}
          </div>
        </div>

        <div className="widget-edit-tabs" role="tablist">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`widget-edit-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="widget-edit-body">
          {activeTab === 'basics' && (
            <div className="widget-edit-fields">
              {editScope === 'value' &&
                isDashboardFixedWidgetSensor(sensor) &&
                typeof loadDashboardWidgetConfig === 'function' &&
                typeof resolveDashboardStorageKey === 'function' && (
                  <>
                    <label className="widget-edit-label">
                      Widget del tablero
                      <select
                        className="widget-edit-input"
                        value={targetDashWidgetId ?? ''}
                        onChange={(e) => {
                          const wid = e.target.value;
                          setTargetDashWidgetId(wid);
                          const stub = dashboardWidgetSensorStub(wid);
                          const stored = loadDashboardWidgetConfig(wid);
                          setDraft(mergeWidgetConfig(stub, stored));
                        }}
                      >
                        {dashboardBasicOptions.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="widget-edit-hint widget-edit-hint--preset">
                      Al guardar, la configuración se aplicará al widget seleccionado (título, apariencia, datos e
                      indicador). Puedes cambiar de widget en el listado y editar otro sin cerrar el modal.
                    </p>
                  </>
                )}
              {editScope === 'value' && !isDashboardFixedWidgetSensor(sensor) && (
                <>
                  <label className="widget-edit-label">
                    Plantilla del widget
                    <select
                      className="widget-edit-input"
                      value={draft.basics?.preset ?? 'none'}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => {
                          const next = deepClone(d);
                          next.basics = next.basics || {};
                          next.basics.preset = v;
                          applyWidgetPresetToDraft(next, v);
                          return next;
                        });
                      }}
                    >
                      {WIDGET_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="widget-edit-hint widget-edit-hint--preset">
                    Las plantillas aplican unidades, campo sugerido y rangos de color; puedes ajustar todo después.
                  </p>
                  <label className="widget-edit-label">
                    Tipo de widget (visualización)
                    <select
                      className="widget-edit-input"
                      value={indicatorSelectValue}
                      onChange={(e) => update('gauge.indicatorType', e.target.value)}
                    >
                      {WIDGET_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <label className="widget-edit-label">
                Título visible
                <input
                  type="text"
                  className="widget-edit-input"
                  value={draft.basics?.title ?? ''}
                  onChange={(e) => update('basics.title', e.target.value)}
                />
              </label>
              {editScope === 'value' && (
                <div className="widget-edit-translations">
                  <div className="widget-edit-label">Traducciones del título</div>
                  {(draft.basics?.titleTranslations || []).map((row) => (
                    <div key={row.id} className="widget-edit-trans-row">
                      <select
                        className="widget-edit-input widget-edit-input--narrow"
                        value={row.lang || 'en'}
                        onChange={(e) => {
                          const id = row.id;
                          const lang = e.target.value;
                          setDraft((d) => {
                            const next = deepClone(d);
                            const list = [...(next.basics.titleTranslations || [])];
                            const i = list.findIndex((x) => x.id === id);
                            if (i >= 0) list[i] = { ...list[i], lang };
                            next.basics.titleTranslations = list;
                            return next;
                          });
                        }}
                      >
                        {TRANSLATION_LANGS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        className="widget-edit-input"
                        value={row.text ?? ''}
                        placeholder="Texto"
                        onChange={(e) => {
                          const id = row.id;
                          const text = e.target.value;
                          setDraft((d) => {
                            const next = deepClone(d);
                            const list = [...(next.basics.titleTranslations || [])];
                            const i = list.findIndex((x) => x.id === id);
                            if (i >= 0) list[i] = { ...list[i], text };
                            next.basics.titleTranslations = list;
                            return next;
                          });
                        }}
                      />
                      <button
                        type="button"
                        className="widget-edit-range-remove"
                        aria-label="Quitar traducción"
                        onClick={() => {
                          const id = row.id;
                          setDraft((d) => {
                            const next = deepClone(d);
                            next.basics.titleTranslations = (next.basics.titleTranslations || []).filter((x) => x.id !== id);
                            return next;
                          });
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="widget-edit-add widget-edit-add--ghost"
                    onClick={() => {
                      setDraft((d) => {
                        const next = deepClone(d);
                        const list = [...(next.basics.titleTranslations || [])];
                        list.push({ id: `tr_${Date.now()}`, lang: 'en', text: '' });
                        next.basics.titleTranslations = list;
                        return next;
                      });
                    }}
                  >
                    + Añadir traducción
                  </button>
                  <button type="button" className="widget-edit-sync-btn" disabled title="Próximamente">
                    Sincronizar traducciones con otros widgets
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'data' && (
            <div className="widget-edit-fields">
              {showDownlinkDataSection && (
                <div className="widget-edit-downlink-block">
                  <label className="widget-edit-label">Downlinks del dispositivo</label>
                  <p className="widget-edit-hint">
                    {previewDashWidgetId === DASH_WIDGET.SWITCH
                      ? 'Los mismos que en Dispositivos → acciones → Downlink. Asigna qué HEX envía cada posición del interruptor.'
                      : 'Los mismos que en Dispositivos → acciones → Downlink. El botón del panel solo enviará el comando que elijas abajo (o el primero de la lista si no eliges).'}
                  </p>
                  {!downlinkSelectState.dlList.length ? (
                    <p className="widget-edit-hint">Aún no hay downlinks guardados para este dispositivo.</p>
                  ) : previewDashWidgetId === DASH_WIDGET.SWITCH ? (
                    <>
                      <label className="widget-edit-label widget-edit-label--mt">
                        Comando al encender (OFF → ON)
                        <select
                          className="widget-edit-input"
                          value={downlinkSelectState.swOnN || ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            update('data.switchHexOn', v ? normalizeDownlinkHex(v) : '');
                          }}
                        >
                          <option value="">Automático (1.º de la lista)</option>
                          {downlinkSelectState.swOnN && !downlinkSelectState.swOnListed ? (
                            <option value={downlinkSelectState.swOnN}>
                              Hex guardado ({shortHexPreview(downlinkSelectState.swOnN)})
                            </option>
                          ) : null}
                          {downlinkSelectState.dlList.map((dl, i) => {
                            const v = normalizeDownlinkHex(dl.hex);
                            return (
                              <option key={`sw_on_${i}_${v}`} value={v}>
                                {(dl.name || `Downlink ${i + 1}`).trim()} · {shortHexPreview(dl.hex)}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <label className="widget-edit-label widget-edit-label--mt">
                        Comando al apagar (ON → OFF)
                        <select
                          className="widget-edit-input"
                          value={downlinkSelectState.swOffN || ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            update('data.switchHexOff', v ? normalizeDownlinkHex(v) : '');
                          }}
                        >
                          <option value="">Automático (2.º de la lista)</option>
                          {downlinkSelectState.swOffN && !downlinkSelectState.swOffListed ? (
                            <option value={downlinkSelectState.swOffN}>
                              Hex guardado ({shortHexPreview(downlinkSelectState.swOffN)})
                            </option>
                          ) : null}
                          {downlinkSelectState.dlList.map((dl, i) => {
                            const v = normalizeDownlinkHex(dl.hex);
                            return (
                              <option key={`sw_off_${i}_${v}`} value={v}>
                                {(dl.name || `Downlink ${i + 1}`).trim()} · {shortHexPreview(dl.hex)}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <p className="widget-edit-hint">
                        Si ambos están en «Automático», se usa el orden de la lista (como antes). Si asignas los dos, se
                        envían solo esos HEX.
                      </p>
                    </>
                  ) : (
                    <label className="widget-edit-label widget-edit-label--mt">
                      Comando del botón
                      <select
                        className="widget-edit-input"
                        value={downlinkSelectState.defDlN || ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          update('data.downlinkDefaultHex', v ? normalizeDownlinkHex(v) : '');
                        }}
                      >
                        <option value="">Primer downlink de la lista</option>
                        {downlinkSelectState.defDlN && !downlinkSelectState.defListed ? (
                          <option value={downlinkSelectState.defDlN}>
                            Hex guardado ({shortHexPreview(downlinkSelectState.defDlN)})
                          </option>
                        ) : null}
                        {downlinkSelectState.dlList.map((dl, i) => {
                          const v = normalizeDownlinkHex(dl.hex);
                          return (
                            <option key={`dl_def_${i}_${v}`} value={v}>
                              {(dl.name || `Downlink ${i + 1}`).trim()} · {shortHexPreview(dl.hex)}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {showStreamDataSection && editScope === 'value' && (
                <div className="widget-edit-stream-block">
                  <label className="widget-edit-label">Series del gráfico (Streaming)</label>
                  <p className="widget-edit-hint">
                    Varias telemetrías en un solo widget: campo, tipo de gráfico, color y eje. Usa «Cambio» para mostrar
                    variación entre muestras.
                  </p>
                  <input
                    type="search"
                    className="widget-edit-input widget-edit-input--mb"
                    placeholder="Filtrar campos para los desplegables…"
                    value={fieldSearch}
                    onChange={(e) => setFieldSearch(e.target.value)}
                    aria-label="Filtrar campos"
                  />
                  {(Array.isArray(draft.data?.streamSeries) ? draft.data.streamSeries : []).map((row, rowIdx) => (
                    <div key={row.id || rowIdx} className="widget-edit-stream-row">
                      <button
                        type="button"
                        className="widget-edit-stream-remove"
                        aria-label="Quitar serie"
                        disabled={(draft.data?.streamSeries || []).length <= 1}
                        onClick={() => {
                          const list = [...(draft.data?.streamSeries || [])].filter((_, j) => j !== rowIdx);
                          if (list.length) update('data.streamSeries', list);
                        }}
                      >
                        ×
                      </button>
                      <label className="widget-edit-label">
                        Campo
                        <select
                          className="widget-edit-input"
                          value={row.fieldKey ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDraft((d) => {
                              const next = deepClone(d);
                              const list = [...(next.data?.streamSeries || [])];
                              if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], fieldKey: v };
                              next.data = { ...next.data, streamSeries: list };
                              return next;
                            });
                          }}
                        >
                          <option value="">— Elegir —</option>
                          {streamSeriesFieldOptions.map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="widget-edit-stream-seg">
                        <span className="widget-edit-stream-seg-label">Valores</span>
                        <div className="widget-edit-seg-inner" role="group">
                          <button
                            type="button"
                            className={`widget-edit-seg-btn ${row.valueMode !== 'delta' ? 'active' : ''}`}
                            onClick={() => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], valueMode: 'absolute' };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                          >
                            Absoluto
                          </button>
                          <button
                            type="button"
                            className={`widget-edit-seg-btn ${row.valueMode === 'delta' ? 'active' : ''}`}
                            onClick={() => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], valueMode: 'delta' };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                          >
                            Cambio
                          </button>
                        </div>
                      </div>
                      <label className="widget-edit-label">
                        Etiqueta
                        <input
                          type="text"
                          className="widget-edit-input"
                          value={row.label ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDraft((d) => {
                              const next = deepClone(d);
                              const list = [...(next.data?.streamSeries || [])];
                              if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], label: v };
                              next.data = { ...next.data, streamSeries: list };
                              return next;
                            });
                          }}
                          placeholder="p. ej. Fase 1"
                        />
                      </label>
                      <fieldset className="widget-edit-stream-type-fieldset">
                        <legend className="widget-edit-stream-legend">Tipo</legend>
                        <label className="widget-edit-radio">
                          <input
                            type="radio"
                            name={`st-type-${row.id || rowIdx}`}
                            checked={row.chartType === 'line' || !row.chartType}
                            onChange={() => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], chartType: 'line' };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                          />{' '}
                          Línea
                        </label>
                        <label className="widget-edit-radio">
                          <input
                            type="radio"
                            name={`st-type-${row.id || rowIdx}`}
                            checked={row.chartType === 'area'}
                            onChange={() => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], chartType: 'area' };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                          />{' '}
                          Área
                        </label>
                        <label className="widget-edit-radio">
                          <input
                            type="radio"
                            name={`st-type-${row.id || rowIdx}`}
                            checked={row.chartType === 'bar'}
                            onChange={() => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], chartType: 'bar' };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                          />{' '}
                          Barras
                        </label>
                      </fieldset>
                      <label className="widget-edit-label">
                        Color
                        <div className="widget-edit-color-row">
                          <input
                            type="color"
                            className="widget-edit-color"
                            value={
                              typeof row.color === 'string' && row.color.startsWith('#')
                                ? row.color
                                : '#4299e1'
                            }
                            onChange={(e) => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], color: e.target.value };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                          />
                          <input
                            type="text"
                            className="widget-edit-input"
                            value={row.color ?? ''}
                            onChange={(e) => {
                              setDraft((d) => {
                                const next = deepClone(d);
                                const list = [...(next.data?.streamSeries || [])];
                                if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], color: e.target.value };
                                next.data = { ...next.data, streamSeries: list };
                                return next;
                              });
                            }}
                            placeholder="#hex"
                          />
                        </div>
                      </label>
                      <label className="widget-edit-label">
                        Interpolación
                        <select
                          className="widget-edit-input"
                          value={row.interpolation === 'step' ? 'step' : 'linear'}
                          onChange={(e) => {
                            const v = e.target.value === 'step' ? 'step' : 'linear';
                            setDraft((d) => {
                              const next = deepClone(d);
                              const list = [...(next.data?.streamSeries || [])];
                              if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], interpolation: v };
                              next.data = { ...next.data, streamSeries: list };
                              return next;
                            });
                          }}
                        >
                          <option value="linear">Lineal</option>
                          <option value="step">Escalón</option>
                        </select>
                      </label>
                      <label className="widget-edit-label">
                        Eje Y
                        <select
                          className="widget-edit-input"
                          value={row.yAxis === '2' || row.yAxis === 'y2' ? '2' : '1'}
                          onChange={(e) => {
                            const v = e.target.value === '2' ? '2' : '1';
                            setDraft((d) => {
                              const next = deepClone(d);
                              const list = [...(next.data?.streamSeries || [])];
                              if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], yAxis: v };
                              next.data = { ...next.data, streamSeries: list };
                              return next;
                            });
                          }}
                        >
                          <option value="1">Eje 1 (izquierda)</option>
                          <option value="2">Eje 2 (derecha)</option>
                        </select>
                      </label>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="widget-edit-add widget-edit-add--ghost"
                    onClick={() => {
                      const list = [...(draft.data?.streamSeries || [])];
                      list.push(defaultStreamSeriesRow(list.length));
                      update('data.streamSeries', list);
                    }}
                  >
                    + Añadir serie
                  </button>
                </div>
              )}
              {editScope === 'value' && !showDownlinkDataSection && !showStreamDataSection && (
                <div className="widget-edit-field-combo">
                  <label className="widget-edit-label">Campo (telemetría del dispositivo)</label>
                  <input
                    type="search"
                    className="widget-edit-input"
                    placeholder="Buscar campo…"
                    value={fieldSearch}
                    onChange={(e) => setFieldSearch(e.target.value)}
                  />
                  <div className="widget-edit-field-list" role="listbox">
                    {fieldOptions.length === 0 ? (
                      <div className="widget-edit-field-empty">
                        {availableDataFields.length === 0
                          ? 'Sin telemetría en vivo. Conecta un dispositivo o escribe la clave abajo.'
                          : 'Ningún campo coincide.'}
                      </div>
                    ) : (
                      fieldOptions.map((key) => (
                        <button
                          key={key}
                          type="button"
                          role="option"
                          className={`widget-edit-field-opt ${draft.data?.fieldKey === key ? 'selected' : ''}`}
                          onClick={() => update('data.fieldKey', key)}
                        >
                          <span>{key}</span>
                          {draft.data?.fieldKey === key ? <span className="widget-edit-field-check">✓</span> : null}
                        </button>
                      ))
                    )}
                  </div>
                  <label className="widget-edit-label widget-edit-label--mt">
                    Clave manual (si no está en la lista)
                    <input
                      type="text"
                      className="widget-edit-input"
                      value={draft.data?.fieldKey ?? ''}
                      onChange={(e) => update('data.fieldKey', e.target.value.trim())}
                      placeholder="p. ej. currentChn1, temperature…"
                    />
                  </label>
                </div>
              )}
              {!showDownlinkDataSection && !showStreamDataSection && (
                <>
                  <label className="widget-edit-label">
                    Unidad
                    <input
                      type="text"
                      className="widget-edit-input"
                      value={draft.data?.unit ?? ''}
                      onChange={(e) => update('data.unit', e.target.value)}
                      placeholder="A, °C, %…"
                    />
                  </label>
                  <label className="widget-edit-label">
                    Decimales
                    <input
                      type="number"
                      className="widget-edit-input widget-edit-input--narrow"
                      min={0}
                      max={6}
                      value={draft.data?.decimals ?? 2}
                      onChange={(e) =>
                        update('data.decimals', Math.min(6, Math.max(0, parseInt(e.target.value, 10) || 0)))
                      }
                    />
                  </label>
                </>
              )}
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="widget-edit-fields">
              <label className="widget-edit-label">
                Color del título
                <div className="widget-edit-color-row">
                  <input
                    type="color"
                    className="widget-edit-color"
                    value={draft.appearance?.titleColor?.startsWith('#') ? draft.appearance.titleColor : '#f97316'}
                    onChange={(e) => update('appearance.titleColor', e.target.value)}
                  />
                  <input
                    type="text"
                    className="widget-edit-input"
                    value={draft.appearance?.titleColor ?? ''}
                    onChange={(e) => update('appearance.titleColor', e.target.value)}
                  />
                </div>
              </label>
            </div>
          )}

          {activeTab === 'gauge' && (
            <div className="widget-edit-fields">
              <p className="widget-edit-hint">
                El tipo de widget (numérico, circular, etc.) se configura en <strong>Básicos</strong>. Aquí defines
                escala y <strong>rangos de color</strong>: el valor actual usa el color del tramo donde cae (también en
                la tarjeta del dashboard).
              </p>
              <div className="widget-edit-scale-row">
                <label className="widget-edit-label">
                  Mín. escala
                  <input
                    type="number"
                    className="widget-edit-input"
                    value={draft.gauge?.scaleMin ?? 0}
                    onChange={(e) => update('gauge.scaleMin', parseFloat(e.target.value) || 0)}
                  />
                </label>
                <label className="widget-edit-label">
                  Máx. escala
                  <input
                    type="number"
                    className="widget-edit-input"
                    value={draft.gauge?.scaleMax ?? 50}
                    onChange={(e) => update('gauge.scaleMax', parseFloat(e.target.value) || 1)}
                  />
                </label>
              </div>
              <p className="widget-edit-hint">Rangos: cada fila define el límite superior del tramo y su color.</p>
              <div className="widget-edit-ranges-head">
                <span>Nombre</span>
                <span>Valores</span>
                <span>Color</span>
                <span />
              </div>
              {(draft.gauge?.ranges || []).map((row) => (
                <div key={row.id} className="widget-edit-range-row">
                  <input
                    type="text"
                    className="widget-edit-input"
                    placeholder="Range name"
                    value={row.name}
                    onChange={(e) => updateRange(row.id, 'name', e.target.value)}
                  />
                  <input
                    type="number"
                    className="widget-edit-input"
                    value={row.value}
                    onChange={(e) => updateRange(row.id, 'value', e.target.value)}
                  />
                  <div className="widget-edit-color-row">
                    <input
                      type="color"
                      className="widget-edit-color"
                      value={row.color?.startsWith('#') ? row.color : '#48bb78'}
                      onChange={(e) => updateRange(row.id, 'color', e.target.value)}
                    />
                    <input
                      type="text"
                      className="widget-edit-input"
                      value={row.color}
                      onChange={(e) => updateRange(row.id, 'color', e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="widget-edit-range-remove"
                    onClick={() => removeRangeRow(row.id)}
                    aria-label="Eliminar rango"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="widget-edit-add" onClick={addRangeRow}>
                Añadir
              </button>
            </div>
          )}

        </div>

        <div className="widget-edit-footer">
          <button type="button" className="widget-edit-btn widget-edit-btn--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="widget-edit-btn widget-edit-btn--primary" onClick={handleSave}>
            <Check size={18} /> Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
