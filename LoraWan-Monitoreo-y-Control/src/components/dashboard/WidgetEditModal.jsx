import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Check, Image, MapPin, Route } from 'lucide-react';
import ValueIndicator from './ValueIndicator';
import { normalizeIndicatorType } from './valueIndicatorUtils';
import {
  mergeWidgetConfig,
  WIDGET_TYPE_OPTIONS,
  WIDGET_PRESETS,
  applyWidgetPresetToDraft,
  dashWidgetIdFromPropertyKey,
  isDashboardFixedWidgetSensor,
  colorForValueInRanges,
  DASH_WIDGET,
  normalizeDownlinkHex,
  parseCssHex,
  resolveDownlinkButtonTextColor,
  isWidgetBackgroundTransparent,
  buildBsdWidgetSurfaceStyle,
  appearanceWithConditionalBackground,
  resolveTelemetryDisplaySource,
  ensureDownlinkButtonsDraft,
  defaultDownlinkButtonRow,
  normalizeDownlinkButtonsForSave,
  ensureStreamSeriesDraftData,
  defaultStreamSeriesRow,
  HISTORY_GRANULARITY_OPTIONS,
  BAR_CHART_WIDGET_GRANULARITY_OPTIONS,
  applyHistoryGranularityPreset,
  normalizeBarChartGranularity,
  resolveTextWidgetRawScalar,
  dashboardWidgetBaseId,
} from './widgetConfigUtils';
import { tryTelemetryDisplayLabel } from '../../utils/telemetryDisplayFormat';
import { resolveMapCoords, openStreetMapEmbedUrl, toFloatCoord } from './mapWidgetCoords';
import {
  PROPERTY_INFER_IGNORE_SET,
  isLikelyLorawanNetworkMetadataKey,
  sortTelemetryPickerKeys,
} from '../../utils/gatewayPayload';
import './WidgetEditModal.css';
import { useTheme } from '../../context/ThemeContext';
import { applyWidgetFormula } from '../../utils/widgetFormula';

const MODAL_TELEMETRY_IGNORE = new Set([...PROPERTY_INFER_IGNORE_SET]);

function isModalTelemetryFieldKey(k) {
  const s = String(k ?? '').trim();
  if (!s) return false;
  if (MODAL_TELEMETRY_IGNORE.has(s)) return false;
  if (s.endsWith('_alarm')) return false;
  if (s.startsWith('__bsd_')) return false;
  return true;
}

function shortHexPreview(hex) {
  const s = String(hex || '').replace(/\s/g, '');
  if (!s) return '—';
  return s.length > 16 ? `${s.slice(0, 14)}…` : s;
}

function resolveSwitchHexLine(dlList, hexNorm) {
  if (!hexNorm) return 'Automático (orden de la lista del dispositivo)';
  const dl = dlList.find((d) => normalizeDownlinkHex(d.hex) === hexNorm);
  if (dl) return `${(dl.name || 'Comando').trim()} · ${shortHexPreview(dl.hex)}`;
  return shortHexPreview(hexNorm);
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
  { id: 'formula', label: 'Fórmulas' },
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
  previewTheme = 'dark',
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
                inverseFill={normalizeIndicatorType(indicatorSelectValue) === 'circular' && Boolean(draft.gauge?.inverseFill)}
                title={d.label}
                titleColor={titleColor}
                subtitle=""
                compact
                theme={previewTheme}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Vista previa del control Switch (downlinks ON/OFF), sin confundir con un sensor numérico. */
function SwitchWidgetPreview({ draft, previewSubtitle, downlinkSelectState, titleColor }) {
  const [demoOn, setDemoOn] = useState(false);
  const title = (draft.basics?.title || '').trim() || 'Switch';
  const tc = titleColor || '#22d3ee';
  const { dlList, swOnN, swOffN } = downlinkSelectState;
  const onLine = resolveSwitchHexLine(dlList, swOnN);
  const offLine = resolveSwitchHexLine(dlList, swOffN);

  return (
    <div className="widget-edit-switch-preview">
      <div className="widget-edit-switch-preview__title" style={{ color: tc }}>
        {title}
      </div>
      <div className="widget-edit-switch-preview__sub">{previewSubtitle}</div>
      <p className="widget-edit-switch-preview__desc">
        En el tablero, cada cambio envía por LoRaWAN el downlink configurado en <strong>Datos</strong> (comandos de la
        plantilla guardados en el dispositivo).
      </p>
      <ul className="widget-edit-switch-preview__cmds">
        <li>
          <span className="widget-edit-switch-preview__tag">ON</span> {onLine}
        </li>
        <li>
          <span className="widget-edit-switch-preview__tag">OFF</span> {offLine}
        </li>
      </ul>
      <button
        type="button"
        className={`widget-edit-switch-preview__track ${demoOn ? 'is-on' : 'is-off'}`}
        onClick={() => setDemoOn((v) => !v)}
        aria-pressed={demoOn}
      >
        <span className="widget-edit-switch-preview__knob" aria-hidden />
        <span className="widget-edit-switch-preview__label">{demoOn ? 'ON' : 'OFF'}</span>
      </button>
      <p className="widget-edit-switch-preview__note">
        Simulación visual: no envía comandos hasta usar el tablero tras guardar.
      </p>
    </div>
  );
}

/** Vista previa de los botones de downlink del panel (solo maquetación). */
function DownlinkWidgetPreview({ draft, previewSubtitle, downlinkSelectState }) {
  const title = (draft.basics?.title || '').trim() || 'Downlink';
  const tc = draft.appearance?.titleColor || '#818cf8';
  const { dlList, downlinkButtons } = downlinkSelectState;
  const rows = (downlinkButtons || [])
    .map((r) => {
      const n = normalizeDownlinkHex(r.hex);
      if (!n) return null;
      const cmd = dlList.find((d) => normalizeDownlinkHex(d.hex) === n);
      const label =
        String(r.label || '').trim() ||
        (cmd?.name || '').trim() ||
        shortHexPreview(n) ||
        'Enviar';
      const bg = parseCssHex(r.buttonColor);
      return { id: r.id, label, buttonBg: bg };
    })
    .filter(Boolean);

  return (
    <div className="widget-edit-downlink-preview">
      <div className="widget-edit-switch-preview__title" style={{ color: tc }}>
        {title}
      </div>
      <div className="widget-edit-switch-preview__sub">{previewSubtitle}</div>
      <p className="widget-edit-switch-preview__desc">
        Cada botón del tablero envía un comando de la plantilla del dispositivo. Lista en <strong>Datos</strong>; color
        de fondo en <strong>Apariencia</strong>.
      </p>
      {rows.length === 0 ? (
        <p className="widget-edit-switch-preview__desc">Añade al menos un comando con HEX válido en Datos.</p>
      ) : (
        <div className="widget-edit-downlink-preview__stack">
          {rows.map((r) => {
            const style = r.buttonBg
              ? {
                  background: r.buttonBg,
                  color: resolveDownlinkButtonTextColor(tc, r.buttonBg),
                  borderColor: 'rgba(99, 102, 241, 0.45)',
                  opacity: 1,
                }
              : undefined;
            return (
              <button
                key={r.id}
                type="button"
                className="widget-edit-downlink-preview__btn"
                style={style}
                disabled
              >
                {r.label}
              </button>
            );
          })}
        </div>
      )}
      <p className="widget-edit-switch-preview__note">Vista previa: el envío real ocurre solo en el tablero.</p>
    </div>
  );
}

function resolveDraftImageUrl(draft, liveProps) {
  const u = draft?.data?.uploadedImageDataUrl;
  if (typeof u === 'string' && u.startsWith('data:image/')) return u;
  const fk = draft?.data?.fieldKey;
  if (
    fk &&
    typeof fk === 'string' &&
    fk.trim() &&
    !String(fk).startsWith('__bsd_') &&
    liveProps &&
    liveProps[fk] != null
  ) {
    const s = String(liveProps[fk]).trim();
    if (/^https?:\/\//i.test(s) || s.startsWith('data:image/')) return s;
  }
  return null;
}

/** Vista previa del widget Imagen del tablero (solo imagen centrada). */
function ImageWidgetPreview({ draft, liveProps, previewSubtitle, titleColor }) {
  const url = useMemo(() => resolveDraftImageUrl(draft, liveProps), [draft, liveProps]);
  const title = (draft?.basics?.title || 'Imagen').trim() || 'Imagen';
  const tc = titleColor || '#f97316';
  return (
    <div className="widget-edit-image-dash-preview">
      <div className="widget-edit-image-dash-preview__head">
        <div className="widget-edit-image-dash-preview__title" style={{ color: tc }}>
          {title}
        </div>
        <div className="widget-edit-image-dash-preview__sub">{previewSubtitle}</div>
      </div>
      <div className="widget-edit-image-dash-preview__frame">
        {url ? (
          <img src={url} alt="" className="widget-edit-image-dash-preview__img" />
        ) : (
          <div className="widget-edit-image-dash-preview__empty">
            <Image size={36} strokeWidth={1.25} aria-hidden />
            <span>Sin imagen aún. Sube una en Datos o usa una URL desde telemetría.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pestaña Datos del widget Imagen: subir / quitar (sin otros campos). */
function ImageWidgetDashDataTab({ draft, setDraft }) {
  const hasUpload =
    typeof draft.data?.uploadedImageDataUrl === 'string' && draft.data.uploadedImageDataUrl.startsWith('data:image/');
  const onFile = (e) => {
    const f = e.target.files?.[0];
    const input = e.target;
    if (input) input.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    if (f.size > 1_200_000) {
      window.alert('Imagen demasiado grande (máx. ~1,2 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      setDraft((d) => {
        const next = deepClone(d);
        next.data = { ...next.data, uploadedImageDataUrl: dataUrl };
        return next;
      });
    };
    reader.readAsDataURL(f);
  };
  const clearUpload = () => {
    setDraft((d) => {
      const next = deepClone(d);
      next.data = { ...next.data, uploadedImageDataUrl: '' };
      return next;
    });
  };
  return (
    <div className="widget-edit-image-dash-data">
      <label className="widget-edit-label">Imagen del tablero</label>
      <p className="widget-edit-hint">
        Sube un PNG o JPEG (máx. ~1,2 MB). Los cambios se aplican al pulsar <strong>Guardar</strong>. Si el dispositivo
        publica una URL de imagen en telemetría, puede mostrarse cuando no hay imagen subida.
      </p>
      <div className="widget-edit-image-dash-data__actions">
        <label className="widget-edit-btn widget-edit-btn--secondary widget-edit-image-file-btn">
          <input type="file" accept="image/*" className="widget-edit-file-input-hidden" onChange={onFile} />
          Subir imagen
        </label>
        {hasUpload ? (
          <button type="button" className="widget-edit-btn widget-edit-btn--secondary" onClick={clearUpload}>
            Quitar imagen subida
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Vista previa del widget Mapa (iframe OSM si hay coordenadas). */
function MapWidgetPreview({ draft, liveProps, previewSubtitle, titleColor }) {
  const coords = useMemo(() => resolveMapCoords(liveProps || {}, draft), [draft, liveProps]);
  const title = (draft?.basics?.title || 'Mapa').trim() || 'Mapa';
  const tc = titleColor || '#f97316';
  return (
    <div className="widget-edit-image-dash-preview">
      <div className="widget-edit-image-dash-preview__head">
        <div className="widget-edit-image-dash-preview__title" style={{ color: tc }}>
          {title}
        </div>
        <div className="widget-edit-image-dash-preview__sub">{previewSubtitle}</div>
      </div>
      <div className="widget-edit-image-dash-preview__frame widget-edit-map-dash-preview__frame">
        {coords ? (
          <iframe
            title="Vista previa mapa"
            className="widget-edit-map-dash-preview__iframe"
            src={openStreetMapEmbedUrl(coords.lat, coords.lng)}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <div className="widget-edit-image-dash-preview__empty">
            <MapPin size={36} strokeWidth={1.25} aria-hidden />
            <span>
              Indica latitud y longitud en <strong>Datos</strong> o publica coordenadas en telemetría para ver el mapa.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pestaña Datos: coordenadas fijas opcionales para el mapa estático. */
function MapWidgetDashDataTab({ draft, setDraft }) {
  const latVal =
    draft.data?.savedLatitude != null && draft.data.savedLatitude !== ''
      ? String(draft.data.savedLatitude)
      : '';
  const lngVal =
    draft.data?.savedLongitude != null && draft.data.savedLongitude !== ''
      ? String(draft.data.savedLongitude)
      : '';
  return (
    <div className="widget-edit-image-dash-data">
      <label className="widget-edit-label">Coordenadas fijas (opcional)</label>
      <p className="widget-edit-hint">
        Si las dejas vacías, el mapa usa <code>latitude</code> y <code>longitude</code> de la telemetría en vivo. Pulsa{' '}
        <strong>Guardar</strong> para aplicar.
      </p>
      <div className="widget-edit-map-coords-row">
        <input
          type="text"
          className="widget-edit-input"
          placeholder="Latitud"
          value={latVal}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => {
              const next = deepClone(d);
              next.data = { ...next.data, savedLatitude: v };
              return next;
            });
          }}
          aria-label="Latitud"
        />
        <input
          type="text"
          className="widget-edit-input"
          placeholder="Longitud"
          value={lngVal}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => {
              const next = deepClone(d);
              next.data = { ...next.data, savedLongitude: v };
              return next;
            });
          }}
          aria-label="Longitud"
        />
      </div>
      <div className="widget-edit-image-dash-data__actions">
        <button
          type="button"
          className="widget-edit-btn widget-edit-btn--secondary"
          onClick={() => {
            setDraft((d) => {
              const next = deepClone(d);
              next.data = { ...next.data, savedLatitude: '', savedLongitude: '' };
              return next;
            });
          }}
        >
          Usar solo telemetría
        </button>
      </div>
    </div>
  );
}

function TrackingMapWidgetPreview({ draft, previewSubtitle, titleColor }) {
  const title = (draft?.basics?.title || 'Mapa de rastreo').trim() || 'Mapa de rastreo';
  const tc = titleColor || '#ffffff';
  return (
    <div className="widget-edit-image-dash-preview">
      <div className="widget-edit-image-dash-preview__head">
        <div className="widget-edit-image-dash-preview__title" style={{ color: tc }}>
          {title}
        </div>
        <div className="widget-edit-image-dash-preview__sub">{previewSubtitle}</div>
      </div>
      <div className="widget-edit-image-dash-preview__frame">
        <div className="widget-edit-image-dash-preview__empty">
          <Route size={36} strokeWidth={1.25} aria-hidden />
          <span>
            En el tablero se muestra la trayectoria según el historial (Día / Semana / Mes) y el último punto con icono
            de ubicación. En Datos elige qué campo de telemetría alimenta el mapa.
          </span>
        </div>
      </div>
    </div>
  );
}

/** Pestaña Datos: campo de telemetría que alimenta el mapa (AT101: raíz con latitude/longitude/history). */
function TrackingMapWidgetDashDataTab({ draft, setDraft, telemetryFieldOptions = [] }) {
  const setKey = (field, val) => {
    setDraft((d) => {
      const next = deepClone(d);
      next.data = { ...next.data, [field]: val };
      return next;
    });
  };
  const tf = String(draft.data?.trackingTelemetryField ?? '').trim();
  return (
    <div className="widget-edit-image-dash-data">
      <label className="widget-edit-label">Origen de datos en el mapa</label>
      <p className="widget-edit-hint">
        <strong>Toda la telemetría</strong>: se leen <code>latitude</code>, <code>longitude</code> y el array{' '}
        <code>history</code> en ese objeto (p. ej. Milesight AT101). Si el GPS viene en un subobjeto, elige su nombre de
        campo (debe ser objeto o JSON con las mismas claves).
      </p>
      <label className="widget-edit-label">
        Campo del dispositivo
        <select
          className="widget-edit-input"
          value={tf}
          onChange={(e) => setKey('trackingTelemetryField', e.target.value)}
        >
          <option value="">Toda la telemetría (raíz del payload)</option>
          {telemetryFieldOptions.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="widget-edit-label">
        Periodo por defecto al abrir edición (el tablero usa los botones Día / Semana / Mes)
        <select
          className="widget-edit-input"
          value={['day', 'week', 'month'].includes(String(draft.data?.trackingTimeRange)) ? draft.data.trackingTimeRange : 'day'}
          onChange={(e) => setKey('trackingTimeRange', e.target.value)}
        >
          <option value="day">Día</option>
          <option value="week">Semana</option>
          <option value="month">Mes</option>
        </select>
      </label>
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
  liveDeviceModel = null,
  telemetryHintMap = null,
  availableDataFields = [],
  availableDownlinks = [],
  bsdDashboardVariant = 'panel',
  panelDeviceSelectOptions = null,
  panelFallbackDeviceId = null,
  getPanelTelemetryExpanded,
  getPanelLiveDeviceModel,
  getPanelTelemetryHints,
  getPanelDownlinks,
  /** Panel: avisa al tablero qué `deviceId` está en vista previa para cargar telemetría aunque no esté guardado aún. */
  onPanelPreviewDeviceIdChange,
  /** Panel: claves conocidas del objeto dispositivo (API lista) mientras llega el merge en vivo. */
  panelPreviewExtraDataKeys = [],
}) {
  const { isDarkMode } = useTheme();
  const previewTheme = isDarkMode ? 'dark' : 'light';

  const [tab, setTab] = useState(() => {
    if (!sensor) return 'data';
    return editScope === 'value' ? (isDashboardFixedWidgetSensor(sensor) ? 'basics' : 'data') : 'basics';
  });
  const [fieldSearch, setFieldSearch] = useState('');
  /** Panel: incluir metadatos LoRaWAN (FCnt, DR…) en la lista de «Datos». */
  const [showLorawanMetaInPicker, setShowLorawanMetaInPicker] = useState(false);
  /** Mensaje bajo «Prueba» en la pestaña Fórmulas. */
  const [formulaProbeLine, setFormulaProbeLine] = useState('');
  const [draft, setDraft] = useState(() => {
    if (!sensor) {
      return mergeWidgetConfig(
        { name: '', propertyKey: 'x', unit: '', threshold: 50, value: 0, sourceDeviceId: 'demo' },
        null
      );
    }
    let base = mergeWidgetConfig(sensor, initialConfig);
    const openedWid = dashWidgetIdFromPropertyKey(sensor.propertyKey);
    if (isDashboardFixedWidgetSensor(sensor) && openedWid === DASH_WIDGET.STREAM) {
      base = deepClone(base);
      base.data = ensureStreamSeriesDraftData(base.data || {});
    }
    if (isDashboardFixedWidgetSensor(sensor) && openedWid === DASH_WIDGET.DOWNLINK) {
      base = deepClone(base);
      base.data = ensureDownlinkButtonsDraft(base.data || {});
    }
    return base;
  });

  const fixedDashWidgetId = useMemo(() => {
    if (!sensor || !isDashboardFixedWidgetSensor(sensor)) return null;
    return dashWidgetIdFromPropertyKey(sensor.propertyKey);
  }, [sensor]);

  const showPanelDevicePicker = useMemo(
    () =>
      bsdDashboardVariant === 'panel' &&
      Array.isArray(panelDeviceSelectOptions) &&
      panelDeviceSelectOptions.length > 0 &&
      Boolean(sensor && isDashboardFixedWidgetSensor(sensor)) &&
      fixedDashWidgetId &&
      fixedDashWidgetId !== DASH_WIDGET.PANEL_DEVICE_BAR,
    [bsdDashboardVariant, panelDeviceSelectOptions, sensor, fixedDashWidgetId]
  );

  const previewBoundDeviceId = useMemo(() => {
    if (!showPanelDevicePicker) return null;
    const raw = draft.data?.panelBoundDeviceId;
    if (raw != null && String(raw).trim()) return String(raw).trim();
    return panelFallbackDeviceId != null ? String(panelFallbackDeviceId) : null;
  }, [showPanelDevicePicker, draft.data?.panelBoundDeviceId, panelFallbackDeviceId]);

  useEffect(() => {
    if (typeof onPanelPreviewDeviceIdChange !== 'function') return undefined;
    if (!open || !showPanelDevicePicker) {
      onPanelPreviewDeviceIdChange(null);
      return undefined;
    }
    onPanelPreviewDeviceIdChange(previewBoundDeviceId);
    return () => onPanelPreviewDeviceIdChange(null);
  }, [open, showPanelDevicePicker, previewBoundDeviceId, onPanelPreviewDeviceIdChange]);

  const previewTelemetrySlice = useMemo(() => {
    if (!showPanelDevicePicker) {
      return {
        props: liveProps,
        model: liveDeviceModel,
        hints: telemetryHintMap,
        downlinks: availableDownlinks,
      };
    }
    const id = previewBoundDeviceId;
    const props =
      typeof getPanelTelemetryExpanded === 'function' ? getPanelTelemetryExpanded(id) : liveProps;
    const model =
      typeof getPanelLiveDeviceModel === 'function' ? getPanelLiveDeviceModel(id) : liveDeviceModel;
    const hints =
      typeof getPanelTelemetryHints === 'function' ? getPanelTelemetryHints(id) : telemetryHintMap;
    const downlinks =
      typeof getPanelDownlinks === 'function' ? getPanelDownlinks(id) : availableDownlinks;
    return {
      props: props && typeof props === 'object' ? props : liveProps,
      model,
      hints,
      downlinks: Array.isArray(downlinks) ? downlinks : availableDownlinks,
    };
  }, [
    showPanelDevicePicker,
    previewBoundDeviceId,
    liveProps,
    liveDeviceModel,
    telemetryHintMap,
    availableDownlinks,
    getPanelTelemetryExpanded,
    getPanelLiveDeviceModel,
    getPanelTelemetryHints,
    getPanelDownlinks,
  ]);

  const previewLiveProps = previewTelemetrySlice.props;
  const previewLiveDeviceModel = previewTelemetrySlice.model;
  const previewTelemetryHints = previewTelemetrySlice.hints;
  const previewDownlinks = previewTelemetrySlice.downlinks;

  /** Panel: lista de campos en «Datos» según el dispositivo elegido (telemetría de ese equipo). */
  const effectiveAvailableDataFields = useMemo(() => {
    if (!showPanelDevicePicker) return availableDataFields;
    const props = previewLiveProps;
    const propsOk = props && typeof props === 'object' && !Array.isArray(props);
    const extras = Array.isArray(panelPreviewExtraDataKeys) ? panelPreviewExtraDataKeys : [];
    if (!propsOk && extras.length === 0) return availableDataFields;
    let fromDevice = propsOk ? Object.keys(props).filter(isModalTelemetryFieldKey) : [];
    if (!showLorawanMetaInPicker) {
      fromDevice = fromDevice.filter((key) => !isLikelyLorawanNetworkMetadataKey(key));
    }
    const set = new Set(fromDevice);
    for (const ek of extras) {
      const k = ek != null ? String(ek).trim() : '';
      if (!k || !isModalTelemetryFieldKey(k)) continue;
      if (!showLorawanMetaInPicker && isLikelyLorawanNetworkMetadataKey(k)) continue;
      set.add(k);
    }
    const fk = draft.data?.fieldKey;
    if (fk && String(fk).trim() && !String(fk).startsWith('__bsd_')) set.add(String(fk).trim());
    const tf = draft.data?.trackingTelemetryField;
    if (tf && String(tf).trim()) set.add(String(tf).trim());
    const rows = draft.data?.streamSeries;
    if (Array.isArray(rows)) {
      rows.forEach((r) => {
        if (r?.fieldKey && String(r.fieldKey).trim()) set.add(String(r.fieldKey).trim());
      });
    }
    return sortTelemetryPickerKeys([...set]);
  }, [
    showPanelDevicePicker,
    previewLiveProps,
    availableDataFields,
    showLorawanMetaInPicker,
    draft.data?.fieldKey,
    draft.data?.trackingTelemetryField,
    draft.data?.streamSeries,
    panelPreviewExtraDataKeys,
  ]);

  /** Clave para leer telemetría en la vista previa (tile fijo del tablero o campo explícito). */
  const previewTelemetryKey = useMemo(() => {
    let fk = draft.data?.fieldKey != null ? String(draft.data.fieldKey).trim() : '';
    if (!fk && isDashboardFixedWidgetSensor(sensor) && fixedDashWidgetId) {
      fk = `__bsd_${fixedDashWidgetId}`;
    }
    if (!fk && sensor?.propertyKey != null) fk = String(sensor.propertyKey);
    return fk;
  }, [draft.data?.fieldKey, sensor, fixedDashWidgetId]);

  /** Clave de telemetría de entrada para la fórmula (vista previa); si no hay fórmula activa, coincide con el campo principal. */
  const previewNumericSourceKey = useMemo(() => {
    const fe = Boolean(draft.data?.formulaEnabled);
    const ex = String(draft.data?.formulaExpression ?? '').trim();
    if (fe && ex) {
      const fs = String(draft.data?.formulaSourceKey ?? '').trim();
      return fs || previewTelemetryKey;
    }
    return previewTelemetryKey;
  }, [
    draft.data?.formulaEnabled,
    draft.data?.formulaExpression,
    draft.data?.formulaSourceKey,
    previewTelemetryKey,
  ]);

  const previewVisualKey = useMemo(() => {
    if (fixedDashWidgetId) return fixedDashWidgetId;
    return dashWidgetIdFromPropertyKey(sensor?.propertyKey) || String(sensor?.propertyKey || 'widget');
  }, [sensor, fixedDashWidgetId]);

  useEffect(() => {
    if (!open) setFormulaProbeLine('');
  }, [open]);

  useEffect(() => {
    if (tab !== 'formula') setFormulaProbeLine('');
  }, [tab]);

  /** Número base para la fórmula (misma entrada que usa el tablero al evaluar). */
  const previewFormulaBaseNumber = useMemo(() => {
    const key = previewNumericSourceKey;
    let base = null;
    if (previewLiveProps && key && previewLiveProps[key] !== undefined) {
      base = parseLiveNumber(previewLiveProps[key]);
    }
    if (base == null) {
      const fromSensor = parseLiveNumber(sensor?.value);
      if (fromSensor != null) base = fromSensor;
    }
    if (base == null) {
      const min = Number(draft.gauge?.scaleMin);
      const max = Number(draft.gauge?.scaleMax);
      const lo = Number.isFinite(min) ? min : 0;
      const hi = Number.isFinite(max) && max > lo ? max : lo + 50;
      base = lo + (hi - lo) * 0.55;
    }
    return base;
  }, [
    previewNumericSourceKey,
    previewLiveProps,
    sensor?.value,
    draft.gauge?.scaleMin,
    draft.gauge?.scaleMax,
  ]);

  /** Valor mostrado en la vista previa: en vivo si existe; si no, punto medio de la escala para ver colores/tipo. */
  const previewValue = useMemo(() => {
    const base = previewFormulaBaseNumber;
    const ex = String(draft.data?.formulaExpression ?? '').trim();
    if (Boolean(draft.data?.formulaEnabled) && ex) {
      const t = applyWidgetFormula(base, ex);
      if (t != null && Number.isFinite(t)) return t;
    }
    return base;
  }, [previewFormulaBaseNumber, draft.data?.formulaEnabled, draft.data?.formulaExpression]);

  const runFormulaProbe = useCallback(() => {
    const ex = String(draft.data?.formulaExpression ?? '').trim();
    if (!ex) {
      setFormulaProbeLine('Escribe una expresión en el campo «Expresión».');
      return;
    }
    const base = previewFormulaBaseNumber;
    const t = applyWidgetFormula(base, ex);
    if (t == null || !Number.isFinite(t)) {
      setFormulaProbeLine(
        `No se pudo evaluar con entrada ≈ ${base}. Usa «(Valor)/10» o la forma corta «/10» (equivale a dividir el valor actual).`
      );
      return;
    }
    setFormulaProbeLine(`Entrada: ${base} → resultado que verá el widget: ${t}`);
  }, [draft.data?.formulaExpression, previewFormulaBaseNumber]);

  const previewUsesLiveValue = useMemo(() => {
    const key = previewNumericSourceKey;
    if (previewLiveProps && key && previewLiveProps[key] !== undefined) {
      const n = parseLiveNumber(previewLiveProps[key]);
      if (n != null) return true;
    }
    return parseLiveNumber(sensor?.value) != null;
  }, [previewNumericSourceKey, previewLiveProps, sensor?.propertyKey, sensor?.value]);

  const previewSubtitle = useMemo(() => {
    if (sensor?.sourceDeviceId === 'dashboard' && isDashboardFixedWidgetSensor(sensor)) {
      return 'Vista previa · refleja cambios al instante';
    }
    if (!previewUsesLiveValue) return 'Vista previa · valor de ejemplo (ajusta escala y rangos)';
    if (editScope !== 'value') return 'Vista previa';
    return 'Valor en vivo';
  }, [sensor, previewUsesLiveValue, editScope]);

  const indicatorSelectValue = useMemo(() => {
    const raw = draft.gauge?.indicatorType || 'numeric';
    const n = normalizeIndicatorType(raw);
    if (WIDGET_TYPE_OPTIONS.some((o) => o.value === n)) return n;
    return 'numeric';
  }, [draft.gauge?.indicatorType]);

  const fieldOptions = useMemo(() => {
    const fk = draft.data?.fieldKey;
    const set = new Set((effectiveAvailableDataFields || []).filter((k) => k && !String(k).startsWith('__bsd_')));
    if (fk && String(fk).trim() && !String(fk).trim().startsWith('__bsd_')) set.add(String(fk).trim());
    const q = fieldSearch.trim().toLowerCase();
    return [...set].filter((k) => !q || k.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [effectiveAvailableDataFields, draft.data?.fieldKey, fieldSearch]);

  const trackingMapTelemetryOptions = useMemo(() => {
    const set = new Set((effectiveAvailableDataFields || []).filter((k) => k && !String(k).startsWith('__bsd_')));
    const cur = String(draft.data?.trackingTelemetryField || '').trim();
    if (cur) set.add(cur);
    return [...set].filter((k) => String(k).trim()).sort((a, b) => a.localeCompare(b));
  }, [effectiveAvailableDataFields, draft.data?.trackingTelemetryField]);

  const formulaFieldOptions = useMemo(() => {
    const set = new Set((effectiveAvailableDataFields || []).filter((k) => k && !String(k).startsWith('__bsd_')));
    const fk = String(draft.data?.fieldKey ?? '').trim();
    if (fk) set.add(fk);
    const fs = String(draft.data?.formulaSourceKey ?? '').trim();
    if (fs) set.add(fs);
    return sortTelemetryPickerKeys([...set]);
  }, [effectiveAvailableDataFields, draft.data?.fieldKey, draft.data?.formulaSourceKey]);

  const previewDashWidgetId = useMemo(() => {
    if (fixedDashWidgetId) return fixedDashWidgetId;
    return dashWidgetIdFromPropertyKey(sensor?.propertyKey);
  }, [sensor, fixedDashWidgetId]);

  const showDownlinkDataSection =
    previewDashWidgetId === DASH_WIDGET.SWITCH || previewDashWidgetId === DASH_WIDGET.DOWNLINK;

  const showStreamDataSection = previewDashWidgetId === DASH_WIDGET.STREAM;

  const showBarChartSection = previewDashWidgetId === DASH_WIDGET.BAR_CHART;

  const showTextWidgetSection = previewDashWidgetId === DASH_WIDGET.TEXT;

  const showImageDataSection = previewDashWidgetId === DASH_WIDGET.IMAGE;

  const showMapDataSection = previewDashWidgetId === DASH_WIDGET.MAP;

  const showTrackingMapDataSection = previewDashWidgetId === DASH_WIDGET.TRACKING_MAP;

  const hideGaugeForWidget =
    showDownlinkDataSection ||
    showStreamDataSection ||
    showBarChartSection ||
    showTextWidgetSection ||
    showImageDataSection ||
    showMapDataSection ||
    showTrackingMapDataSection;

  /** Pestaña «Fórmulas» solo en widgets con valor numérico configurable (no cuadrícula multi-campo ni mapas/imagen). */
  const hideFormulaTabForWidget = useMemo(() => {
    if (!previewDashWidgetId) return false;
    const base = dashboardWidgetBaseId(previewDashWidgetId);
    const withFormula = new Set([
      DASH_WIDGET.SATISFACTION,
      DASH_WIDGET.METRIC_CIRCULAR,
      DASH_WIDGET.TEXT,
      DASH_WIDGET.STREAM,
      DASH_WIDGET.BAR_CHART,
    ]);
    return !withFormula.has(base);
  }, [previewDashWidgetId]);

  const showInverseGaugeOption = useMemo(() => {
    const circ = normalizeIndicatorType(draft.gauge?.indicatorType) === 'circular';
    return (
      circ ||
      previewDashWidgetId === DASH_WIDGET.SATISFACTION ||
      previewDashWidgetId === DASH_WIDGET.METRIC_CIRCULAR
    );
  }, [draft.gauge?.indicatorType, previewDashWidgetId]);

  const visibleTabs = useMemo(() => {
    let tabs = tabsForScope(editScope);
    if (hideGaugeForWidget) tabs = tabs.filter((t) => t.id !== 'gauge');
    if (hideFormulaTabForWidget) tabs = tabs.filter((t) => t.id !== 'formula');
    return tabs;
  }, [editScope, hideGaugeForWidget, hideFormulaTabForWidget]);

  /** Panel Control: [Básicos] [Dispositivo ▼] [Datos] [Apariencia] […] según tipo de widget. */
  const panelToolbarTabs = useMemo(() => {
    if (!showPanelDevicePicker) return null;
    const basics = visibleTabs.find((t) => t.id === 'basics');
    const rest = visibleTabs.filter((t) => t.id !== 'basics');
    if (!basics) return null;
    return { basics, rest };
  }, [showPanelDevicePicker, visibleTabs]);

  /** Si la pestaña «Indicador» o «Fórmulas» deja de existir, mostramos «Datos» sin setState en un effect. */
  const formulaTabVisible = visibleTabs.some((t) => t.id === 'formula');
  const activeTab =
    tab === 'gauge' && hideGaugeForWidget
      ? 'data'
      : tab === 'formula' && !formulaTabVisible
        ? 'data'
        : tab;

  const downlinkSelectState = useMemo(() => {
    const dlList = Array.isArray(previewDownlinks) ? previewDownlinks : [];
    const swOnN = normalizeDownlinkHex(draft.data?.switchHexOn);
    const swOffN = normalizeDownlinkHex(draft.data?.switchHexOff);
    const listed = (n) => !!(n && dlList.some((d) => normalizeDownlinkHex(d.hex) === n));
    const downlinkButtons = ensureDownlinkButtonsDraft(draft.data || {}).downlinkButtons || [];
    return {
      dlList,
      swOnN,
      swOffN,
      downlinkButtons,
      swOnListed: listed(swOnN),
      swOffListed: listed(swOffN),
    };
  }, [previewDownlinks, draft.data?.switchHexOn, draft.data?.switchHexOff, draft.data?.downlinkButtons]);

  const streamSeriesFieldOptions = useMemo(() => {
    const set = new Set((effectiveAvailableDataFields || []).filter((k) => k && !String(k).startsWith('__bsd_')));
    const rows = draft.data?.streamSeries;
    if (Array.isArray(rows)) {
      rows.forEach((r) => {
        if (r?.fieldKey && String(r.fieldKey).trim()) set.add(String(r.fieldKey).trim());
      });
    }
    const q = fieldSearch.trim().toLowerCase();
    return [...set].filter((k) => !q || k.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [effectiveAvailableDataFields, draft.data?.streamSeries, fieldSearch]);

  const showSensorGridPreview = previewDashWidgetId === DASH_WIDGET.SENSOR_GRID;

  /** Valores para la regla de fondo (misma lógica que el tablero: etiqueta en pantalla + escalar crudo en widget Texto). */
  const previewConditionalSources = useMemo(() => {
    const key = previewTelemetryKey;
    const fallback =
      sensor?.value !== undefined && sensor?.value !== null ? sensor.value : previewValue;
    if (!key || String(key).startsWith('__bsd_') || !previewLiveProps || typeof previewLiveProps !== 'object') {
      return { primary: fallback, alternate: undefined };
    }
    const cfg = draft;
    if (previewDashWidgetId === DASH_WIDGET.TEXT) {
      const scalar = resolveTextWidgetRawScalar(previewLiveProps, key, cfg);
      if (scalar !== undefined && scalar !== null) {
        if (previewLiveDeviceModel) {
          const friendly = tryTelemetryDisplayLabel(
            previewLiveDeviceModel,
            key,
            scalar,
            previewTelemetryHints
          );
          if (friendly != null && String(friendly).trim()) {
            return { primary: String(friendly).trim(), alternate: scalar };
          }
        }
        return { primary: scalar, alternate: undefined };
      }
      const r = resolveTelemetryDisplaySource(previewLiveProps, key);
      if (r !== undefined) return { primary: r, alternate: undefined };
    } else {
      const r = resolveTelemetryDisplaySource(previewLiveProps, key);
      if (r !== undefined) return { primary: r, alternate: undefined };
    }
    return { primary: fallback, alternate: undefined };
  }, [
    previewTelemetryKey,
    previewLiveProps,
    draft,
    previewDashWidgetId,
    previewLiveDeviceModel,
    previewTelemetryHints,
    sensor?.value,
    previewValue,
  ]);

  const previewEffectiveAppearance = useMemo(
    () =>
      appearanceWithConditionalBackground(
        draft.appearance,
        previewConditionalSources.primary,
        previewConditionalSources.alternate
      ),
    [draft.appearance, previewConditionalSources]
  );
  const previewShellSurfaceStyle = useMemo(
    () => buildBsdWidgetSurfaceStyle(previewEffectiveAppearance),
    [previewEffectiveAppearance]
  );
  const previewShellClear = useMemo(
    () => isWidgetBackgroundTransparent(previewEffectiveAppearance),
    [previewEffectiveAppearance]
  );

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
      cfg.data = ensureStreamSeriesDraftData(cfg.data || {});
      const rows = cfg.data?.streamSeries;
      if (Array.isArray(rows) && rows[0]?.fieldKey) {
        cfg.data.fieldKey = String(rows[0].fieldKey).trim();
      }
    }
    if (dashWid === DASH_WIDGET.DOWNLINK) {
      cfg.data = normalizeDownlinkButtonsForSave(cfg.data || {});
    }
    if (dashWid === DASH_WIDGET.MAP) {
      cfg.data = cfg.data || {};
      const lat = toFloatCoord(cfg.data.savedLatitude);
      const lng = toFloatCoord(cfg.data.savedLongitude);
      if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        cfg.data.savedLatitude = lat;
        cfg.data.savedLongitude = lng;
      } else {
        cfg.data.savedLatitude = '';
        cfg.data.savedLongitude = '';
      }
    }
    if (dashWid === DASH_WIDGET.TRACKING_MAP) {
      cfg.data = cfg.data || {};
      const tr = String(cfg.data.trackingTimeRange || '').toLowerCase();
      cfg.data.trackingTimeRange = tr === 'week' || tr === 'month' ? tr : 'day';
      const tf = String(cfg.data.trackingTelemetryField ?? '').trim();
      cfg.data.trackingTelemetryField = tf.startsWith('__bsd_') ? '' : tf;
      delete cfg.data.latitudeKey;
      delete cfg.data.longitudeKey;
      delete cfg.data.historyKey;
    }
    onSave(cfg);
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
              Se actualiza al instante mientras editas; pulsa Guardar para aplicar en el tablero.
            </span>
          </div>
          <div
            className={`widget-edit-preview${previewShellClear ? ' bsd-widget-surface--clear' : ''}`}
            style={previewShellSurfaceStyle || undefined}
          >
            {showSensorGridPreview ? (
              <SensorGridWidgetPreview
                draft={draft}
                indicatorSelectValue={indicatorSelectValue}
                previewSubtitle={previewSubtitle}
                liveProps={previewLiveProps}
                availableDataFields={effectiveAvailableDataFields}
                sensorTitleFallback={sensor.name}
                previewTheme={previewTheme}
              />
            ) : previewDashWidgetId === DASH_WIDGET.SWITCH ? (
              <SwitchWidgetPreview
                key={previewVisualKey}
                draft={draft}
                previewSubtitle={previewSubtitle}
                downlinkSelectState={downlinkSelectState}
                titleColor={draft.appearance?.titleColor}
              />
            ) : previewDashWidgetId === DASH_WIDGET.DOWNLINK ? (
              <DownlinkWidgetPreview
                key={previewVisualKey}
                draft={draft}
                previewSubtitle={previewSubtitle}
                downlinkSelectState={downlinkSelectState}
              />
            ) : previewDashWidgetId === DASH_WIDGET.IMAGE ? (
              <ImageWidgetPreview
                key={previewVisualKey}
                draft={draft}
                liveProps={previewLiveProps}
                previewSubtitle={previewSubtitle}
                titleColor={draft.appearance?.titleColor}
              />
            ) : previewDashWidgetId === DASH_WIDGET.MAP ? (
              <MapWidgetPreview
                key={previewVisualKey}
                draft={draft}
                liveProps={previewLiveProps}
                previewSubtitle={previewSubtitle}
                titleColor={draft.appearance?.titleColor}
              />
            ) : previewDashWidgetId === DASH_WIDGET.TRACKING_MAP ? (
              <TrackingMapWidgetPreview
                key={previewVisualKey}
                draft={draft}
                previewSubtitle={previewSubtitle}
                titleColor={draft.appearance?.titleColor}
              />
            ) : (
              <ValueIndicator
                key={`${previewVisualKey}-${indicatorSelectValue}`}
                type={indicatorSelectValue}
                value={previewValue}
                unit={draft.data?.unit || ''}
                decimals={Number(draft.data?.decimals) || 0}
                scaleMin={Number(draft.gauge?.scaleMin) || 0}
                scaleMax={Number(draft.gauge?.scaleMax) || 50}
                ranges={draft.gauge?.ranges || []}
                inverseFill={Boolean(draft.gauge?.inverseFill)}
                title={draft.basics?.title || sensor.name}
                titleColor={draft.appearance?.titleColor || '#f97316'}
                subtitle={previewSubtitle}
                theme={previewTheme}
              />
            )}
          </div>
        </div>

        <div
          className={`widget-edit-tabs-row${showPanelDevicePicker && panelToolbarTabs ? ' widget-edit-tabs-row--panel-device' : ''}`}
        >
          {showPanelDevicePicker && panelToolbarTabs ? (
            <div className="widget-edit-tabs-toolbar" role="toolbar" aria-label="Configuración del widget">
              <div className="widget-edit-tabs widget-edit-tabs--panel-toolbar" role="tablist">
                <button
                  key={panelToolbarTabs.basics.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === panelToolbarTabs.basics.id}
                  className={`widget-edit-tab ${activeTab === panelToolbarTabs.basics.id ? 'active' : ''}`}
                  onClick={() => setTab(panelToolbarTabs.basics.id)}
                >
                  {panelToolbarTabs.basics.label}
                </button>
              </div>
              <div className="widget-edit-panel-device widget-edit-panel-device--toolbar">
                <label className="widget-edit-panel-device-label" htmlFor="bsd-panel-widget-device-select">
                  Dispositivo
                </label>
                <select
                  id="bsd-panel-widget-device-select"
                  className="widget-edit-panel-device-select"
                  value={
                    draft.data?.panelBoundDeviceId != null && String(draft.data.panelBoundDeviceId).trim()
                      ? String(draft.data.panelBoundDeviceId).trim()
                      : panelFallbackDeviceId != null
                        ? String(panelFallbackDeviceId)
                        : ''
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraft((d) => {
                      const next = deepClone(d);
                      next.data = { ...next.data, panelBoundDeviceId: v || undefined };
                      return next;
                    });
                  }}
                >
                  {panelDeviceSelectOptions.map((o) => (
                    <option key={o.deviceId} value={o.deviceId}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="widget-edit-tabs widget-edit-tabs--panel-toolbar" role="tablist">
                {panelToolbarTabs.rest.map((t) => (
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
            </div>
          ) : (
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
          )}
        </div>

        <div className="widget-edit-body">
          {activeTab === 'basics' && (
            <div className="widget-edit-fields">
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
              {showImageDataSection ? (
                <ImageWidgetDashDataTab draft={draft} setDraft={setDraft} />
              ) : showMapDataSection ? (
                <MapWidgetDashDataTab draft={draft} setDraft={setDraft} />
              ) : showTrackingMapDataSection ? (
                <TrackingMapWidgetDashDataTab
                  draft={draft}
                  setDraft={setDraft}
                  telemetryFieldOptions={trackingMapTelemetryOptions}
                />
              ) : (
                <>
              {showDownlinkDataSection && (
                <div className="widget-edit-downlink-block">
                  <label className="widget-edit-label">Downlinks del dispositivo</label>
                  <p className="widget-edit-hint">
                    {previewDashWidgetId === DASH_WIDGET.SWITCH
                      ? 'Los mismos que en Dispositivos → acciones → Downlink. Asigna qué HEX envía cada posición del interruptor.'
                      : 'Los mismos que en Dispositivos → acciones → Downlink. Cada fila es un botón en el tablero; la etiqueta es opcional (si la dejas vacía, se usa el nombre del comando).'}
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
                    <>
                      {(Array.isArray(draft.data?.downlinkButtons) ? draft.data.downlinkButtons : []).map(
                        (row, rowIdx) => {
                          const rowHexN = normalizeDownlinkHex(row.hex);
                          const rowListed = rowHexN && downlinkSelectState.dlList.some((d) => normalizeDownlinkHex(d.hex) === rowHexN);
                          return (
                            <div key={row.id || rowIdx} className="widget-edit-downlink-cmd-row">
                              <button
                                type="button"
                                className="widget-edit-stream-remove"
                                aria-label="Quitar botón"
                                disabled={(draft.data?.downlinkButtons || []).length <= 1}
                                onClick={() => {
                                  const list = [...(draft.data?.downlinkButtons || [])].filter((_, j) => j !== rowIdx);
                                  if (list.length) update('data.downlinkButtons', list);
                                }}
                              >
                                ×
                              </button>
                              <label className="widget-edit-label">
                                Etiqueta del botón (opcional)
                                <input
                                  type="text"
                                  className="widget-edit-input"
                                  value={row.label ?? ''}
                                  placeholder="p. ej. Modo frío 22 °C"
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setDraft((d) => {
                                      const next = deepClone(d);
                                      const list = [...(next.data?.downlinkButtons || [])];
                                      if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], label: v };
                                      next.data = { ...next.data, downlinkButtons: list };
                                      return next;
                                    });
                                  }}
                                />
                              </label>
                              <label className="widget-edit-label">
                                Comando (downlink)
                                <select
                                  className="widget-edit-input"
                                  value={rowHexN || ''}
                                  onChange={(e) => {
                                    const v = e.target.value ? normalizeDownlinkHex(e.target.value) : '';
                                    setDraft((d) => {
                                      const next = deepClone(d);
                                      const list = [...(next.data?.downlinkButtons || [])];
                                      if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], hex: v };
                                      next.data = { ...next.data, downlinkButtons: list };
                                      return next;
                                    });
                                  }}
                                >
                                  <option value="">— Elegir —</option>
                                  {rowHexN && !rowListed ? (
                                    <option value={rowHexN}>Hex guardado ({shortHexPreview(rowHexN)})</option>
                                  ) : null}
                                  {downlinkSelectState.dlList.map((dl, i) => {
                                    const v = normalizeDownlinkHex(dl.hex);
                                    return (
                                      <option key={`dl_row_${rowIdx}_${i}_${v}`} value={v}>
                                        {(dl.name || `Downlink ${i + 1}`).trim()} · {shortHexPreview(dl.hex)}
                                      </option>
                                    );
                                  })}
                                </select>
                              </label>
                            </div>
                          );
                        }
                      )}
                      <button
                        type="button"
                        className="widget-edit-add widget-edit-add--ghost"
                        onClick={() => {
                          setDraft((d) => {
                            const next = deepClone(d);
                            const list = [...(next.data?.downlinkButtons || [])];
                            list.push(defaultDownlinkButtonRow());
                            next.data = { ...next.data, downlinkButtons: list };
                            return next;
                          });
                        }}
                      >
                        + Añadir botón
                      </button>
                    </>
                  )}
                </div>
              )}
              {showStreamDataSection && editScope === 'value' && (
                <div className="widget-edit-stream-block">
                  <label className="widget-edit-label">Series del gráfico (Grafico Lineal)</label>
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
                  {showPanelDevicePicker && (
                    <>
                      <p className="widget-edit-hint widget-edit-hint--data-device">
                        Campos según el dispositivo elegido arriba (telemetría en vivo). Se priorizan sensores y lecturas
                        de aplicación; los metadatos de red LoRaWAN van ocultos salvo que los actives abajo.
                      </p>
                      <label className="widget-edit-label widget-edit-label--inline widget-edit-lorawan-toggle">
                        <input
                          type="checkbox"
                          checked={showLorawanMetaInPicker}
                          onChange={(e) => setShowLorawanMetaInPicker(e.target.checked)}
                        />
                        Mostrar también campos LoRaWAN / red (FCnt, DR, DevAddr…)
                      </label>
                    </>
                  )}
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
                        {effectiveAvailableDataFields.length === 0
                          ? showPanelDevicePicker
                            ? 'Sin campos para este dispositivo aún. Espera telemetría o escribe la clave abajo.'
                            : 'Sin telemetría en vivo. Conecta un dispositivo o escribe la clave abajo.'
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
                  {previewDashWidgetId === DASH_WIDGET.METRIC_CIRCULAR && (
                    <>
                      <label className="widget-edit-label">
                        Subtítulo (debajo del valor)
                        <input
                          type="text"
                          className="widget-edit-input"
                          value={draft.data?.metricSubtitle ?? ''}
                          onChange={(e) => update('data.metricSubtitle', e.target.value)}
                          placeholder="p. ej. Margen, Tanque A…"
                        />
                      </label>
                      <label className="widget-edit-label">
                        Degradado del arco
                        <select
                          className="widget-edit-input"
                          value={draft.data?.metricGradient === 'thermal' ? 'thermal' : 'traffic'}
                          onChange={(e) => update('data.metricGradient', e.target.value)}
                        >
                          <option value="traffic">Rojo → verde (nivel / margen)</option>
                          <option value="thermal">Azul → rojo (temperatura)</option>
                        </select>
                      </label>
                    </>
                  )}
                  {previewDashWidgetId === DASH_WIDGET.BAR_CHART && (
                    <>
                      <p className="widget-edit-hint">
                        Hora = últimos 60 minutos; Día = 24 barras por hora; Semana = 7 días; Mes = 30 días. Los botones
                        ajustan el intervalo sugerido (puedes refinar desde/hasta abajo).
                      </p>
                      <div className="widget-edit-label">Agrupar por</div>
                      <div className="widget-edit-granularity-row">
                        {(() => {
                          const raw = normalizeBarChartGranularity(draft.timeframe?.granularity);
                          const active = BAR_CHART_WIDGET_GRANULARITY_OPTIONS.some((x) => x.value === raw)
                            ? raw
                            : 'hour';
                          return BAR_CHART_WIDGET_GRANULARITY_OPTIONS.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              className={`widget-edit-granularity-btn ${active === o.value ? 'is-active' : ''}`}
                              onClick={() => {
                                setDraft((d) => {
                                  const next = deepClone(d);
                                  applyHistoryGranularityPreset(next, o.value);
                                  return next;
                                });
                              }}
                            >
                              {o.label}
                            </button>
                          ));
                        })()}
                      </div>
                      <label className="widget-edit-label">
                        Desde (texto relativo o fecha ISO)
                        <input
                          type="text"
                          className="widget-edit-input"
                          value={draft.timeframe?.from ?? ''}
                          onChange={(e) => update('timeframe.from', e.target.value)}
                          placeholder="90 días atrás"
                        />
                      </label>
                      <label className="widget-edit-label">
                        Hasta
                        <input
                          type="text"
                          className="widget-edit-input"
                          value={draft.timeframe?.to ?? ''}
                          onChange={(e) => update('timeframe.to', e.target.value)}
                          placeholder="now"
                        />
                      </label>
                      <label className="widget-edit-label">
                        Operación de agregación
                        <select
                          className="widget-edit-input"
                          value={draft.timeframe?.operation ?? 'avg'}
                          onChange={(e) => update('timeframe.operation', e.target.value)}
                        >
                          <option value="avg">Promedio</option>
                          <option value="min">Mínimo</option>
                          <option value="max">Máximo</option>
                          <option value="sum">Suma</option>
                        </select>
                      </label>
                      <label className="widget-edit-label">
                        Valor objetivo / presupuesto (línea roja; vacío = ocultar)
                        <input
                          type="text"
                          className="widget-edit-input"
                          inputMode="decimal"
                          value={draft.data?.barChartTarget ?? ''}
                          onChange={(e) => update('data.barChartTarget', e.target.value)}
                          placeholder="p. ej. 5600"
                        />
                      </label>
                      <label className="widget-edit-label">
                        Leyenda — barras (teal)
                        <input
                          type="text"
                          className="widget-edit-input"
                          value={draft.data?.barLegendActual ?? ''}
                          onChange={(e) => update('data.barLegendActual', e.target.value)}
                          placeholder="Actual"
                        />
                      </label>
                      <label className="widget-edit-label">
                        Leyenda — línea objetivo
                        <input
                          type="text"
                          className="widget-edit-input"
                          value={draft.data?.barLegendTarget ?? ''}
                          onChange={(e) => update('data.barLegendTarget', e.target.value)}
                          placeholder="Objetivo"
                        />
                      </label>
                    </>
                  )}
                </>
              )}
                </>
              )}
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="widget-edit-fields">
              <div className="widget-edit-appearance-twin">
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
                <label className="widget-edit-label">
                  Fondo del widget
                  <div className="widget-edit-color-row widget-edit-color-row--widget-surface">
                    <input
                      type="color"
                      className="widget-edit-color"
                      disabled={isWidgetBackgroundTransparent(draft.appearance)}
                      value={
                        parseCssHex(String(draft.appearance?.widgetBackgroundColor ?? '').trim()) || '#38bdf8'
                      }
                      onChange={(e) => update('appearance.widgetBackgroundColor', e.target.value)}
                      aria-label="Muestra de color del fondo del widget"
                    />
                    <input
                      type="text"
                      className="widget-edit-input"
                      value={draft.appearance?.widgetBackgroundColor ?? ''}
                      placeholder="Vacío = cristal; transparent"
                      onChange={(e) => update('appearance.widgetBackgroundColor', e.target.value)}
                    />
                    <button
                      type="button"
                      className="widget-edit-downlink-appearance-clear"
                      onClick={() => update('appearance.widgetBackgroundColor', '')}
                    >
                      Predet.
                    </button>
                    <button
                      type="button"
                      className="widget-edit-downlink-appearance-clear"
                      onClick={() => update('appearance.widgetBackgroundColor', 'transparent')}
                    >
                      Sin fondo
                    </button>
                  </div>
                </label>
              </div>
              <p className="widget-edit-hint widget-edit-hint--preset">
                Cristal por defecto del tablero. «Sin fondo» deja solo el desenfoque y el borde; un color hex aplica un
                gradiente suave en la misma familia visual.
              </p>
              <div className="widget-edit-conditional-bg">
                <h3 className="widget-edit-subsection-title">Resalte condicional (opcional)</h3>
                <p className="widget-edit-hint">
                  Si el valor del campo cumple la condición, se usa el color de fondo elegido (sustituye el fondo base
                  mientras se cumpla).
                </p>
                <label className="widget-edit-label widget-edit-label--inline">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.appearance?.conditionalBackground?.enabled)}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setDraft((d) => {
                        const next = deepClone(d);
                        next.appearance = next.appearance || {};
                        const prev = next.appearance.conditionalBackground || {};
                        next.appearance.conditionalBackground = {
                          enabled: on,
                          operator: prev.operator || 'eq',
                          compareValue: prev.compareValue ?? '',
                          backgroundColor: prev.backgroundColor || '#22c55e',
                        };
                        return next;
                      });
                    }}
                  />
                  <span>Activar regla</span>
                </label>
                {draft.appearance?.conditionalBackground?.enabled ? (
                  <div className="widget-edit-conditional-bg-rule" aria-label="Regla Si entonces">
                    <span className="widget-edit-conditional-bg-kw">Si</span>
                    <span className="widget-edit-conditional-bg-muted">el valor es</span>
                    <select
                      className="widget-edit-input widget-edit-input--operator-select"
                      value={String(draft.appearance?.conditionalBackground?.operator || 'eq')}
                      onChange={(e) => update('appearance.conditionalBackground.operator', e.target.value)}
                    >
                      <option value="eq">igual a</option>
                      <option value="gt">mayor que</option>
                      <option value="gte">mayor o igual que</option>
                      <option value="lt">menor que</option>
                      <option value="lte">menor o igual que</option>
                    </select>
                    <input
                      type="text"
                      className="widget-edit-input widget-edit-input--conditional-val"
                      value={draft.appearance?.conditionalBackground?.compareValue ?? ''}
                      onChange={(e) => update('appearance.conditionalBackground.compareValue', e.target.value)}
                      placeholder="Umbral (número o texto)"
                      aria-label="Valor de comparación"
                    />
                    <span className="widget-edit-conditional-bg-kw">entonces</span>
                    <span className="widget-edit-conditional-bg-muted">fondo</span>
                    <div className="widget-edit-color-row widget-edit-color-row--conditional">
                      <input
                        type="color"
                        className="widget-edit-color"
                        value={
                          parseCssHex(String(draft.appearance?.conditionalBackground?.backgroundColor ?? '').trim()) ||
                          '#22c55e'
                        }
                        onChange={(e) =>
                          update('appearance.conditionalBackground.backgroundColor', e.target.value)
                        }
                        aria-label="Color de fondo si se cumple la condición"
                      />
                      <input
                        type="text"
                        className="widget-edit-input"
                        value={draft.appearance?.conditionalBackground?.backgroundColor ?? ''}
                        onChange={(e) =>
                          update('appearance.conditionalBackground.backgroundColor', e.target.value)
                        }
                        placeholder="#22c55e"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
              {previewDashWidgetId === DASH_WIDGET.DOWNLINK && (
                <div className="widget-edit-downlink-appearance">
                  <p className="widget-edit-hint widget-edit-hint--preset">
                    Fondo opcional por botón. El texto usa el color del título; si no hay contraste suficiente sobre el
                    fondo elegido, se aclara u oscurece automáticamente (mín. 4,5:1).
                  </p>
                  {(draft.data?.downlinkButtons || []).map((row, rowIdx) => {
                    const n = normalizeDownlinkHex(row.hex);
                    if (!n) return null;
                    const cmd = (availableDownlinks || []).find((d) => normalizeDownlinkHex(d.hex) === n);
                    const shortLabel =
                      String(row.label || '').trim() ||
                      (cmd?.name || '').trim() ||
                      shortHexPreview(n) ||
                      `Botón ${rowIdx + 1}`;
                    const parsedBg = parseCssHex(row.buttonColor);
                    const colorPickerValue = parsedBg || '#6366f1';
                    return (
                      <div key={row.id || rowIdx} className="widget-edit-downlink-appearance-row">
                        <label className="widget-edit-label">
                          {`Fondo · ${shortLabel}`}
                          <div className="widget-edit-color-row">
                            <input
                              type="color"
                              className="widget-edit-color"
                              value={colorPickerValue}
                              onChange={(e) => {
                                const v = e.target.value;
                                setDraft((d) => {
                                  const next = deepClone(d);
                                  const list = [...(next.data?.downlinkButtons || [])];
                                  if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], buttonColor: v };
                                  next.data = { ...next.data, downlinkButtons: list };
                                  return next;
                                });
                              }}
                              aria-label={`Color de fondo ${shortLabel}`}
                            />
                            <input
                              type="text"
                              className="widget-edit-input"
                              value={row.buttonColor ?? ''}
                              placeholder="Vacío = cristal del tablero"
                              onChange={(e) => {
                                const v = e.target.value;
                                setDraft((d) => {
                                  const next = deepClone(d);
                                  const list = [...(next.data?.downlinkButtons || [])];
                                  if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], buttonColor: v };
                                  next.data = { ...next.data, downlinkButtons: list };
                                  return next;
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="widget-edit-downlink-appearance-clear"
                              onClick={() => {
                                setDraft((d) => {
                                  const next = deepClone(d);
                                  const list = [...(next.data?.downlinkButtons || [])];
                                  if (list[rowIdx]) list[rowIdx] = { ...list[rowIdx], buttonColor: '' };
                                  next.data = { ...next.data, downlinkButtons: list };
                                  return next;
                                });
                              }}
                            >
                              Predet.
                            </button>
                          </div>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
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
              {showInverseGaugeOption ? (
                <label className="widget-edit-label widget-edit-label--inline widget-edit-lorawan-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.gauge?.inverseFill)}
                    onChange={(e) => update('gauge.inverseFill', e.target.checked)}
                  />
                  Lógica inversa (menor valor en escala = mayor llenado del arco; útil p. ej. distancia ultrasónica al
                  líquido)
                </label>
              ) : null}
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

          {activeTab === 'formula' && editScope === 'value' && (
            <div className="widget-edit-fields">
              <p className="widget-edit-hint">
                Usa el valor de telemetría como <strong>Valor</strong> o <strong>(Valor)</strong> en la expresión.
                Operadores: <code>*</code> <code>/</code> <code>+</code> <code>-</code> y paréntesis; también{' '}
                <code>×</code> y <code>÷</code>. Puede omitir «Valor» al inicio: <code>/10</code> equivale a{' '}
                <code>(Valor)/10</code>. Ejemplos: <code>(Valor) / 1000</code>, <code>(127×10×5) / 1000</code>. Puede
                terminar en <code>=</code>.
              </p>
              <label className="widget-edit-label widget-edit-label--inline widget-edit-lorawan-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(draft.data?.formulaEnabled)}
                  onChange={(e) => update('data.formulaEnabled', e.target.checked)}
                />
                Activar fórmula sobre el valor mostrado
              </label>
              <label className="widget-edit-label">
                Campo de entrada para la fórmula
                <select
                  className="widget-edit-input"
                  value={draft.data?.formulaSourceKey ?? ''}
                  onChange={(e) => update('data.formulaSourceKey', e.target.value)}
                  disabled={!draft.data?.formulaEnabled}
                >
                  <option value="">Mismo que «Campo de datos»</option>
                  {formulaFieldOptions.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              <label className="widget-edit-label">
                Expresión
                <textarea
                  className="widget-edit-input widget-edit-formula-textarea"
                  rows={3}
                  placeholder="(Valor) / 1000  o  /10"
                  value={draft.data?.formulaExpression ?? ''}
                  onChange={(e) => update('data.formulaExpression', e.target.value)}
                  disabled={!draft.data?.formulaEnabled}
                  spellCheck={false}
                />
              </label>
              <div className="widget-edit-formula-probe-row">
                <button type="button" className="widget-edit-btn widget-edit-btn--secondary" onClick={runFormulaProbe}>
                  Prueba
                </button>
                <span className="widget-edit-hint widget-edit-hint--inline">
                  Calcula con la entrada actual (en vivo o de ejemplo) sin guardar.
                </span>
              </div>
              {formulaProbeLine ? (
                <p className="widget-edit-formula-probe-result" role="status">
                  {formulaProbeLine}
                </p>
              ) : null}
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
