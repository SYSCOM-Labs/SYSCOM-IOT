import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
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
  normalizeStreamSeriesConfig,
  resolveTextWidgetRawScalar,
  dashboardWidgetBaseId,
  MAX_WIDGET_IMAGE_DATA_URL_CHARS,
} from './widgetConfigUtils';
import { tryTelemetryDisplayLabel } from '../../utils/telemetryDisplayFormat';
import { resolveMapCoords, openStreetMapEmbedUrl, toFloatCoord } from './mapWidgetCoords';
import {
  PROPERTY_INFER_IGNORE_SET,
  expandNestedGatewayTelemetry,
  isLikelyLorawanNetworkMetadataKey,
  sortTelemetryPickerKeys,
  parseTelemetryScalar,
} from '../../utils/gatewayPayload';
import { fetchDeviceProperties } from '../../services/api';
import './WidgetEditModal.css';
import { applyWidgetFormula, transformWidgetNumeric } from '../../utils/widgetFormula';
import {
  BSD_CIRCULAR_GAUGE_R,
  BSD_CIRCULAR_GAUGE_LEN,
  MC_CX,
  MC_CY,
  MC_R,
  MC_ARC_START,
  MC_ARC_SWEEP,
  MC_ARC_PATH_D,
  MC_ARC_GEOM_LEN,
  mcPoint,
  buildMetricCircularTicksFromUi,
  computeMetricCircularUi,
  computeSatisfactionRingUi,
  computeContainerTankUi,
  computeBatteryLevelUi,
} from './metricCircularUi';
import BsdContainerTankView from './BsdContainerTankView';
import BsdBatteryLevelView from './BsdBatteryLevelView';

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

function modalTelemetryTsToMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}

/** Igual que en el tablero: lecturas bajo `properties` visibles en el plano raíz. */
function modalHoistTelemetryPropertiesLayer(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src;
  const out = { ...src };
  const nest = out.properties;
  if (nest && typeof nest === 'object' && !Array.isArray(nest)) {
    for (const [k, v] of Object.entries(nest)) {
      const has = Object.prototype.hasOwnProperty.call(out, k);
      if (
        (!has || out[k] === undefined || out[k] === null) &&
        v !== undefined &&
        v !== null &&
        !(typeof v === 'string' && !String(v).trim()) &&
        !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      ) {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Último estado persistido (API) listo para mezclar con telemetría en memoria en la vista previa. */
function normalizeStoredPropertiesForModalPreview(apiData, propertiesRaw) {
  const props =
    propertiesRaw && typeof propertiesRaw === 'object' && !Array.isArray(propertiesRaw) ? { ...propertiesRaw } : {};
  const ts = modalTelemetryTsToMs(apiData?.lastTimestamp ?? apiData?.lastUpdateTime);
  if (ts != null) props.lastUpdateTime = ts;
  return expandNestedGatewayTelemetry(modalHoistTelemetryPropertiesLayer(props));
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

/** Clave de telemetría de entrada para la fórmula (misma regla que el tablero). */
function telemetryFieldKeyForFormulaModal(cfg, defaultKey) {
  const fs = cfg?.data?.formulaSourceKey != null ? String(cfg.data.formulaSourceKey).trim() : '';
  return fs || String(defaultKey ?? '').trim();
}

function formatModalLastUpdateLine(ts) {
  if (ts == null) return '';
  const n = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(n)) return '';
  return `Última actualización: ${new Date(n).toLocaleString()}`;
}

/** Texto del widget «Texto» en la vista previa (misma lógica que `computeTextWidgetUiForSlot` del tablero). */
function computeModalTextWidgetUi(liveProps, draft, liveDeviceModel, telemetryHintMap) {
  const fkRaw = draft?.data?.fieldKey;
  const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
  const readFk = telemetryFieldKeyForFormulaModal(draft, fkStr);
  const rawScalar =
    liveProps && typeof liveProps === 'object' && !Array.isArray(liveProps)
      ? resolveTextWidgetRawScalar(liveProps, readFk, draft)
      : undefined;
  const useLive = Boolean(readFk) && !readFk.startsWith('__bsd_') && rawScalar !== undefined;
  const raw = useLive ? rawScalar : undefined;
  const decRaw = draft?.data?.decimals;
  const dec =
    decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
      ? Math.min(20, Math.max(0, Number(decRaw)))
      : 2;
  const unit = draft?.data?.unit != null ? String(draft.data.unit) : '';
  const lastAtLine = formatModalLastUpdateLine(liveProps?.lastUpdateTime);
  const formulaActive =
    Boolean(draft?.data?.formulaEnabled) && String(draft?.data?.formulaExpression ?? '').trim() !== '';

  if (raw === undefined || raw === null) {
    const hint = !fkStr || fkStr.startsWith('__bsd_') ? 'Configura el campo en edición' : 'Sin dato en vivo';
    return { display: '—', hint, lastAtLine };
  }
  const friendly = formulaActive
    ? null
    : tryTelemetryDisplayLabel(liveDeviceModel, fkStr, raw, telemetryHintMap);
  if (friendly != null && String(friendly).trim()) {
    return { display: String(friendly).trim(), hint: fkStr, lastAtLine };
  }
  const n = parseTelemetryScalar(raw);
  if (n !== null && Number.isFinite(n)) {
    const nd = transformWidgetNumeric(draft, n);
    return { display: `${nd.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim(), hint: fkStr, lastAtLine };
  }
  if (typeof raw === 'boolean') return { display: raw ? 'Sí' : 'No', hint: fkStr, lastAtLine };
  if (typeof raw === 'object') {
    try {
      return { display: JSON.stringify(raw), hint: fkStr, lastAtLine };
    } catch {
      return { display: String(raw), hint: fkStr, lastAtLine };
    }
  }
  const s = String(raw).trim();
  return { display: s.length ? s : '—', hint: fkStr, lastAtLine };
}

function shellClassName(clear) {
  return ['widget-edit-preview-root', clear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ');
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
  liveProps,
  availableDataFields,
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
  const indType = normalizeIndicatorType(indicatorSelectValue);
  const useNumeric = indType === 'numeric';

  return (
    <div className="widget-edit-sensor-grid-preview">
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
function SwitchWidgetPreview({ downlinkSelectState }) {
  const [demoOn, setDemoOn] = useState(false);
  const { dlList, swOnN, swOffN } = downlinkSelectState;
  const onLine = resolveSwitchHexLine(dlList, swOnN);
  const offLine = resolveSwitchHexLine(dlList, swOffN);

  return (
    <div className="widget-edit-switch-preview">
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
    </div>
  );
}

/** Vista previa de los botones de downlink del panel (solo maquetación). */
function DownlinkWidgetPreview({ draft, downlinkSelectState }) {
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
    </div>
  );
}

const MAX_IMAGE_UPLOAD_BYTES = 2_500_000;
const IMAGE_RESCALE_MAX_EDGE = 1400;
const IMAGE_JPEG_QUALITY = 0.82;

function isEmbeddedImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value.trim());
}

function isLikelyRasterImageFile(file) {
  if (!file || typeof file !== 'object') return false;
  const t = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (t.startsWith('image/')) return true;
  const n = typeof file.name === 'string' ? file.name : '';
  return /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(n);
}

/** Clona el borrador tocando solo `data` (sin `JSON.stringify` completo: evita fallos con PNG/data URL grandes). */
function draftWithDataPatch(d, patch) {
  if (!d || typeof d !== 'object') return d;
  const data = d.data && typeof d.data === 'object' ? d.data : {};
  return {
    ...d,
    basics: d.basics && typeof d.basics === 'object' ? { ...d.basics } : {},
    appearance:
      d.appearance && typeof d.appearance === 'object'
        ? {
            ...d.appearance,
            conditionalBackground:
              d.appearance.conditionalBackground && typeof d.appearance.conditionalBackground === 'object'
                ? { ...d.appearance.conditionalBackground }
                : {},
          }
        : {},
    data: { ...data, ...patch },
    gauge:
      d.gauge && typeof d.gauge === 'object'
        ? {
            ...d.gauge,
            ranges: Array.isArray(d.gauge.ranges) ? d.gauge.ranges.map((r) => ({ ...r })) : d.gauge.ranges || [],
          }
        : {},
    timeframe: d.timeframe && typeof d.timeframe === 'object' ? { ...d.timeframe } : {},
  };
}

/** Codifica la imagen como JPEG en data URL y reduce tamaño hasta caber en `maxChars` (longitud de texto, no KB del archivo). */
function jpegDataUrlFromImage(img, maxEdgePx, quality) {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, maxEdgePx / Math.max(w0, h0));
  const tw = Math.max(1, Math.round(w0 * scale));
  const th = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(img, 0, 0, tw, th);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

/**
 * Reduce la imagen incrustada para `localStorage`.
 * El límite es la longitud del string `data:image/...` (base64), que suele ser ~30–40 % mayor que el peso en disco del PNG.
 */
async function compressImageDataUrlForStorage(dataUrl) {
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl;
    if (typeof dataUrl !== 'string' || !isEmbeddedImageDataUrl(dataUrl)) return dataUrl;
    const trimmed = dataUrl.trim();
    const maxChars = MAX_WIDGET_IMAGE_DATA_URL_CHARS;
    if (trimmed.length <= maxChars) return trimmed;

    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image-decode'));
      el.src = trimmed;
    });

    const qualities = [IMAGE_JPEG_QUALITY, 0.72, 0.62, 0.52, 0.42, 0.32, 0.24, 0.18, 0.14];
    let best = trimmed;
    let bestLen = trimmed.length;
    let maxEdge = IMAGE_RESCALE_MAX_EDGE;

    while (maxEdge >= 64) {
      for (const q of qualities) {
        const candidate = jpegDataUrlFromImage(img, maxEdge, q);
        if (!candidate) continue;
        if (candidate.length <= maxChars) return candidate;
        if (candidate.length < bestLen) {
          best = candidate;
          bestLen = candidate.length;
        }
      }
      maxEdge = Math.floor(maxEdge * 0.75);
    }
    return best;
  } catch {
    return typeof dataUrl === 'string' ? dataUrl.trim() : dataUrl;
  }
}

function resolveDraftImageUrl(draft, liveProps) {
  const u = draft?.data?.uploadedImageDataUrl;
  if (isEmbeddedImageDataUrl(u)) return String(u).trim();
  const staticUrl = draft?.data?.staticImageUrl;
  if (typeof staticUrl === 'string' && staticUrl.trim()) {
    const s = staticUrl.trim();
    if (/^https?:\/\//i.test(s) || isEmbeddedImageDataUrl(s)) return s;
  }
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
    if (/^https?:\/\//i.test(s) || isEmbeddedImageDataUrl(s)) return s;
  }
  return null;
}

/** Vista previa del widget Imagen del tablero (solo imagen centrada). */
function ImageWidgetPreview({ draft, liveProps }) {
  const url = useMemo(() => resolveDraftImageUrl(draft, liveProps), [draft, liveProps]);
  return (
    <div className="widget-edit-image-dash-preview">
      <div className="widget-edit-image-dash-preview__frame">
        {url ? (
          <img src={url} alt="" className="widget-edit-image-dash-preview__img" />
        ) : (
          <div className="widget-edit-image-dash-preview__empty">
            <Image size={36} strokeWidth={1.25} aria-hidden />
            <span>Sin imagen aún. Elige un archivo o escribe una URL en Básicos.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Widget Imagen: solo archivo (PC) y URL; vive en la pestaña Básicos (sin Datos ni selector de dispositivo). */
function ImageWidgetBasicsImageSource({ draft, setDraft }) {
  const hasUpload = isEmbeddedImageDataUrl(draft.data?.uploadedImageDataUrl);
  const urlVal = draft.data?.staticImageUrl != null ? String(draft.data.staticImageUrl) : '';
  const onFile = (e) => {
    const f = e.target.files?.[0];
    const input = e.target;
    if (input) input.value = '';
    if (!f) return;
    if (!isLikelyRasterImageFile(f)) {
      window.alert('Elija un archivo de imagen (PNG, JPEG, WebP, GIF…). Si ya es imagen y no la reconoce, renombre con extensión .png o .jpg.');
      return;
    }
    if (f.size > MAX_IMAGE_UPLOAD_BYTES) {
      window.alert('Imagen demasiado grande (máx. ~2,5 MB). Reduzca el archivo o use una URL https://.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      window.alert('No se pudo leer el archivo. Pruebe con PNG o JPEG, o use una URL https://.');
    };
    reader.onload = () => {
      const raw = reader.result;
      if (typeof raw !== 'string') return;
      if (!isEmbeddedImageDataUrl(raw)) {
        window.alert('El navegador no generó una vista previa de esta imagen. Use PNG/JPEG o una URL https://.');
        return;
      }
      void (async () => {
        try {
          const dataUrl = await compressImageDataUrlForStorage(raw);
          if (dataUrl.length > MAX_WIDGET_IMAGE_DATA_URL_CHARS) {
            window.alert(
              `Tras comprimir al máximo, la imagen incrustada sigue superando el límite del navegador (${MAX_WIDGET_IMAGE_DATA_URL_CHARS.toLocaleString(
                'es'
              )} caracteres de texto codificado, no el tamaño del archivo en KB). Use una imagen con menos píxeles, exporte un JPEG más pequeño, o una URL https://.`
            );
            return;
          }
          setDraft((d) => draftWithDataPatch(d, { uploadedImageDataUrl: dataUrl }));
        } catch (err) {
          console.error('[WidgetEditModal] imagen incrustada', err);
          window.alert(
            'No se pudo guardar la imagen en el borrador (p. ej. archivo demasiado grande para el navegador). Pruebe una imagen más pequeña, otra copia en PNG/JPEG, o use una URL https://.'
          );
        }
      })();
    };
    reader.readAsDataURL(f);
  };
  const clearUpload = () => {
    setDraft((d) => draftWithDataPatch(d, { uploadedImageDataUrl: '' }));
  };
  const setStaticUrl = (raw) => {
    setDraft((d) => draftWithDataPatch(d, { staticImageUrl: raw }));
  };
  return (
    <div className="widget-edit-image-dash-data widget-edit-image-basics-source">
      <label className="widget-edit-label">Imagen del tablero</label>
      <p className="widget-edit-hint">
        Elige PNG o JPEG (máx. ~2,5 MB al subir) o pega una URL <code>https://</code>. Al guardar en el tablero, la
        imagen se convierte en texto (base64): el límite seguro es unos{' '}
        <strong>{MAX_WIDGET_IMAGE_DATA_URL_CHARS.toLocaleString('es')} caracteres</strong> de cadena codificada (un PNG
        de varios cientos de KB en disco puede superarlo; se comprime automáticamente a JPEG). Para fotos muy grandes
        use siempre una URL. Pulsa <strong>Guardar</strong> para aplicar.
      </p>
      <div className="widget-edit-image-dash-data__actions">
        <label className="widget-edit-btn widget-edit-btn--secondary widget-edit-image-file-btn">
          <input type="file" accept="image/*" className="widget-edit-file-input-hidden" onChange={onFile} />
          Buscar imagen en el equipo
        </label>
        {hasUpload ? (
          <button type="button" className="widget-edit-btn widget-edit-btn--secondary" onClick={clearUpload}>
            Quitar imagen subida
          </button>
        ) : null}
      </div>
      <label className="widget-edit-label widget-edit-label--mt">
        URL de la imagen
        <input
          type="url"
          className="widget-edit-input"
          placeholder="https://ejemplo.com/imagen.png"
          value={urlVal}
          onChange={(e) => setStaticUrl(e.target.value)}
          autoComplete="off"
        />
      </label>
    </div>
  );
}

/** Vista previa del widget Mapa (iframe OSM si hay coordenadas). */
function MapWidgetPreview({ draft, liveProps }) {
  const coords = useMemo(() => resolveMapCoords(liveProps || {}, draft), [draft, liveProps]);
  return (
    <div className="widget-edit-image-dash-preview">
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
              Indica <strong>latitud</strong> y <strong>longitud</strong> en Básicos para ver el mapa (o deja vacío y
              usa telemetría si el dispositivo publica coordenadas).
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Widget Mapa estático: lat/long en Básicos (sin pestaña Datos ni selector de dispositivo en panel). */
function MapWidgetBasicsCoords({ draft, setDraft }) {
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
      <label className="widget-edit-label">Ubicación del mapa</label>
      <p className="widget-edit-hint">
        Escribe la latitud y la longitud en grados decimales (p. ej. 19.4326, -99.1332). Pulsa <strong>Guardar</strong>{' '}
        para aplicar. Si las dejas vacías, el tablero puede seguir usando <code>latitude</code> y <code>longitude</code>{' '}
        de la telemetría.
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
          Borrar coordenadas
        </button>
      </div>
    </div>
  );
}

function TrackingMapWidgetPreview() {
  return (
    <div className="widget-edit-image-dash-preview">
      <div
        className="widget-edit-image-dash-preview__frame"
        role="region"
        aria-label="Mapa de rastreo: la trayectoria se muestra en el tablero tras guardar"
      >
        <div className="widget-edit-image-dash-preview__empty">
          <Route size={36} strokeWidth={1.25} aria-hidden />
          <span>Mapa de rastreo</span>
        </div>
      </div>
    </div>
  );
}

/** Vista previa del medidor semicircular (misma estructura DOM/CSS que el tablero). */
function ModalMetricCircularPreview({
  draft,
  previewMergedLiveProps,
  previewLiveDeviceModel,
  previewTelemetryHints,
  title,
  titleColor,
  mergedSurface,
  previewShellClear,
  previewVisualKey,
}) {
  const gid = useId().replace(/:/g, '');
  const ui = useMemo(
    () => computeMetricCircularUi(draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints),
    [draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints]
  );
  const mcTicks = useMemo(() => buildMetricCircularTicksFromUi(ui), [ui]);
  const mcRanges = Array.isArray(ui?.ranges) ? ui.ranges : [];
  const mcUseRangeColors = mcRanges.length > 0;
  const mcT = ui?.needleT != null ? ui.needleT : 0;
  const mcHasLive = ui?.rawValue != null && Number.isFinite(ui.rawValue);
  const mcRangeStroke =
    mcUseRangeColors && mcHasLive
      ? colorForValueInRanges(ui.rawValue, mcRanges, ui.scaleLo, ui.scaleHi) || '#a5b4fc'
      : null;
  const mcArcStroke = mcUseRangeColors
    ? mcRangeStroke || 'rgba(255,255,255,0.22)'
    : ui?.gradientMode === 'thermal'
      ? `url(#bsd-mc-thermal-${gid})`
      : `url(#bsd-mc-traffic-${gid})`;
  const arcProgressT = mcHasLive ? Math.min(1, Math.max(0, mcT)) : 0;
  const mcArcDash = MC_ARC_GEOM_LEN;
  const mcArcDashOff = MC_ARC_GEOM_LEN * (1 - arcProgressT);
  const mcArcFilterStyle = mcUseRangeColors ? { filter: 'drop-shadow(0 2px 10px rgba(15,23,42,0.28))' } : undefined;
  const mcNeedleFill = mcUseRangeColors && mcRangeStroke ? mcRangeStroke : undefined;

  return (
    <div
      key={`bsd-mc-preview-${previewVisualKey}`}
      className={['widget', 'widget--metric-circular', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
      style={{ width: '100%', ...mergedSurface }}
    >
      <div className="widget-header">
        <div className="widget-title" style={{ color: titleColor }}>
          <span aria-hidden>◔</span> {title}
        </div>
      </div>
      <div className="bsd-metric-circular">
        <div className="bsd-metric-circular__chart">
          <svg
            className="bsd-metric-circular__svg"
            viewBox="0 0 240 152"
            preserveAspectRatio="xMidYMid meet"
            width="100%"
            aria-hidden
          >
            {!mcUseRangeColors ? (
              <defs>
                <linearGradient
                  id={`bsd-mc-traffic-${gid}`}
                  x1="4%"
                  y1="92%"
                  x2="96%"
                  y2="8%"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor="#ff4d2d" />
                  <stop offset="28%" stopColor="#ff9f1c" />
                  <stop offset="52%" stopColor="#ffd60a" />
                  <stop offset="78%" stopColor="#84cc16" />
                  <stop offset="100%" stopColor="#16a34a" />
                </linearGradient>
                <linearGradient
                  id={`bsd-mc-thermal-${gid}`}
                  x1="8%"
                  y1="88%"
                  x2="92%"
                  y2="12%"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor="#1d4ed8" />
                  <stop offset="30%" stopColor="#22d3ee" />
                  <stop offset="55%" stopColor="#facc15" />
                  <stop offset="82%" stopColor="#fb923c" />
                  <stop offset="100%" stopColor="#dc2626" />
                </linearGradient>
              </defs>
            ) : null}
            <path className="bsd-metric-circular__track" d={MC_ARC_PATH_D} fill="none" strokeWidth={17} strokeLinecap="round" />
            <path
              className="bsd-metric-circular__arc"
              d={MC_ARC_PATH_D}
              fill="none"
              strokeWidth={17}
              strokeLinecap="round"
              stroke={mcArcStroke}
              strokeDasharray={mcArcDash}
              strokeDashoffset={mcArcDashOff}
              style={mcArcFilterStyle}
            />
            {mcTicks.map((tk) => {
              const inner = mcPoint(MC_CX, MC_CY, MC_R + 10, tk.theta);
              const outer = mcPoint(MC_CX, MC_CY, MC_R + 20, tk.theta);
              const lab = mcPoint(MC_CX, MC_CY, MC_R + 34, tk.theta);
              return (
                <g key={tk.f}>
                  <line className="bsd-metric-circular__tick" x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
                  <text
                    className="bsd-metric-circular__tick-label"
                    x={lab.x}
                    y={lab.y}
                    dominantBaseline="middle"
                    textAnchor="middle"
                  >
                    {tk.label}
                  </text>
                </g>
              );
            })}
            {(() => {
              const t = ui?.needleT != null ? ui.needleT : 0;
              const th = MC_ARC_START + t * MC_ARC_SWEEP;
              const deg = (th * 180) / Math.PI;
              const fade = ui?.needleT != null ? 1 : 0.38;
              return (
                <g
                  className="bsd-metric-circular__needle"
                  style={{ opacity: fade }}
                  transform={`translate(${MC_CX},${MC_CY}) rotate(${deg})`}
                >
                  <polygon points="58,-5 78,0 58,5" className="bsd-metric-circular__needle-shape" fill={mcNeedleFill} />
                </g>
              );
            })()}
            <text className="bsd-metric-circular__center-val" x={MC_CX} y={MC_CY - 4} textAnchor="middle">
              {ui?.centerMain}
            </text>
            {ui?.svgSubtitleLine ? (
              <text className="bsd-metric-circular__center-sub" x={MC_CX} y={MC_CY + 16} textAnchor="middle">
                {ui.svgSubtitleLine}
              </text>
            ) : null}
          </svg>
        </div>
        {ui?.lastAtLine ? (
          <div className="bsd-metric-circular__lastat" style={{ color: titleColor }}>
            {ui.lastAtLine}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Vista previa del widget Circular (anillo), alineada con el tablero. */
function ModalSatisfactionRingPreview({
  draft,
  previewMergedLiveProps,
  previewLiveDeviceModel,
  previewTelemetryHints,
  title,
  titleColor,
  mergedSurface,
  previewShellClear,
}) {
  const gid = useId().replace(/:/g, '');
  const satUi = useMemo(
    () => computeSatisfactionRingUi(draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints),
    [draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints]
  );
  const satArcStroke =
    satUi.ranges?.length > 0 && satUi.rawValue != null && Number.isFinite(satUi.rawValue)
      ? colorForValueInRanges(satUi.rawValue, satUi.ranges, satUi.scaleMin, satUi.scaleMax) || `url(#bsd-circ-grad-${gid})`
      : `url(#bsd-circ-grad-${gid})`;
  const satArcDashOffset = BSD_CIRCULAR_GAUGE_LEN - (satUi.ringPct / 100) * BSD_CIRCULAR_GAUGE_LEN;

  return (
    <div
      className={['widget', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
      style={{ width: '100%', ...mergedSurface }}
    >
      <div className="widget-header">
        <div className="widget-title" style={{ color: titleColor }}>
          <span aria-hidden>◎</span> {title}
        </div>
      </div>
      <div className="bsd-circular-gauge">
        <svg className="bsd-circular-gauge__svg" viewBox="0 0 200 200" width="100%" height="100%" aria-hidden>
          <defs>
            <linearGradient id={`bsd-circ-grad-${gid}`} x1="28%" y1="12%" x2="72%" y2="92%">
              <stop offset="0%" stopColor="#ff9a8b" />
              <stop offset="45%" stopColor="#ff7b7a" />
              <stop offset="100%" stopColor="#ff5569" />
            </linearGradient>
          </defs>
          <circle
            className="bsd-circular-gauge__track"
            cx="100"
            cy="100"
            r={BSD_CIRCULAR_GAUGE_R}
            fill="none"
            stroke="#e4e4ec"
            strokeWidth="18"
          />
          <circle
            className="bsd-circular-gauge__arc"
            cx="100"
            cy="100"
            r={BSD_CIRCULAR_GAUGE_R}
            fill="none"
            stroke={satArcStroke}
            strokeWidth="18"
            strokeLinecap="round"
            strokeDasharray={BSD_CIRCULAR_GAUGE_LEN}
            strokeDashoffset={satArcDashOffset}
          />
        </svg>
        <div className="bsd-circular-gauge__hub">
          <span className="bsd-circular-gauge__value">{satUi.centerLabel}</span>
        </div>
      </div>
      {satUi.lastAtLine ? (
        <div className="bsd-circular-gauge__foot-at" style={{ color: titleColor }}>
          {satUi.lastAtLine}
        </div>
      ) : null}
    </div>
  );
}

/** Vista previa del widget Contenedor (tanque), misma lógica de valor que Circular. */
function ModalContainerTankPreview({
  draft,
  previewMergedLiveProps,
  previewLiveDeviceModel,
  previewTelemetryHints,
  title,
  titleColor,
  mergedSurface,
  previewShellClear,
}) {
  const tankUi = useMemo(
    () => computeContainerTankUi(draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints),
    [draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints]
  );
  const liquidColor = useMemo(() => {
    const lo = tankUi.scaleMin;
    const hi = tankUi.scaleMax;
    const span = hi - lo;
    const val =
      tankUi.rawValue != null && Number.isFinite(tankUi.rawValue)
        ? tankUi.rawValue
        : lo + (tankUi.ringPct / 100) * span;
    return colorForValueInRanges(val, tankUi.ranges, lo, hi) || '#22c55e';
  }, [tankUi]);

  return (
    <div
      className={['widget', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
      style={{ width: '100%', ...mergedSurface }}
    >
      <div className="widget-header">
        <div className="widget-title" style={{ color: titleColor }}>
          <span aria-hidden>🛢</span> {title}
        </div>
      </div>
      <BsdContainerTankView
        fillPct={tankUi.ringPct}
        fillColor={liquidColor}
        centerLabel={tankUi.centerLabel}
        lastAtLine={tankUi.lastAtLine}
        titleColor={titleColor}
      />
    </div>
  );
}

/** Vista previa del widget Nivel Batería, misma lógica de valor que Circular. */
function ModalBatteryLevelPreview({
  draft,
  previewMergedLiveProps,
  previewLiveDeviceModel,
  previewTelemetryHints,
  title,
  titleColor,
  mergedSurface,
  previewShellClear,
}) {
  const batUi = useMemo(
    () => computeBatteryLevelUi(draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints),
    [draft, previewMergedLiveProps, previewLiveDeviceModel, previewTelemetryHints]
  );
  const fillColor = useMemo(() => {
    const lo = batUi.scaleMin;
    const hi = batUi.scaleMax;
    const span = hi - lo;
    const val =
      batUi.rawValue != null && Number.isFinite(batUi.rawValue)
        ? batUi.rawValue
        : lo + (batUi.ringPct / 100) * span;
    return colorForValueInRanges(val, batUi.ranges, lo, hi) || '#f97316';
  }, [batUi]);

  return (
    <div
      className={['widget', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
      style={{ width: '100%', ...mergedSurface }}
    >
      <div className="widget-header">
        <div className="widget-title" style={{ color: titleColor }}>
          <span aria-hidden>🔋</span> {title}
        </div>
      </div>
      <BsdBatteryLevelView
        fillPct={batUi.ringPct}
        fillColor={fillColor}
        centerLabel={batUi.centerLabel}
        lastAtLine={batUi.lastAtLine}
        titleColor={titleColor}
      />
    </div>
  );
}

/**
 * Vista previa alineada con el tablero BSD: misma tarjeta cristal / sensor-card / widget shell que al guardar.
 */
function ModalLivePreviewBlock({
  sensor,
  draft,
  showSensorGridPreview,
  previewDashWidgetId,
  previewBaseDashId,
  previewVisualKey,
  indicatorSelectValue,
  previewMergedLiveProps,
  previewValue,
  previewShellSurfaceStyle,
  previewShellClear,
  previewRangeAccent,
  previewTelemetryDisplayLabel,
  previewSensorSubtitle,
  modalTextWidgetUi,
  effectiveAvailableDataFields,
  downlinkSelectState,
  previewLiveDeviceModel,
  previewTelemetryHints,
}) {
  const surfaceStyle = previewShellSurfaceStyle || undefined;
  const accentBox =
    previewRangeAccent != null
      ? { borderColor: `${previewRangeAccent}aa`, boxShadow: `0 0 26px ${previewRangeAccent}40` }
      : undefined;
  const mergedSurface = surfaceStyle && accentBox ? { ...surfaceStyle, ...accentBox } : accentBox || surfaceStyle;

  const title = draft.basics?.title || sensor?.name || '';
  const titleColor = draft.appearance?.titleColor || '#f97316';
  const unit = draft.data?.unit != null ? String(draft.data.unit) : '';
  const decRaw = draft.data?.decimals;
  const decimals = decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw)) ? Number(decRaw) : 1;
  const ranges = draft.gauge?.ranges || [];
  const scaleMin = Number(draft.gauge?.scaleMin) || 0;
  const scaleMax = Number(draft.gauge?.scaleMax) || 50;
  const valueSensor = sensor && !isDashboardFixedWidgetSensor(sensor);
  const numericValue = indicatorSelectValue === 'numeric';

  if (showSensorGridPreview) {
    return (
      <div className={shellClassName(previewShellClear)} style={mergedSurface}>
        <SensorGridWidgetPreview
          draft={draft}
          indicatorSelectValue={indicatorSelectValue}
          liveProps={previewMergedLiveProps}
          availableDataFields={effectiveAvailableDataFields}
          previewTheme="dark"
        />
      </div>
    );
  }
  if (previewDashWidgetId === DASH_WIDGET.SWITCH) {
    return (
      <div className={shellClassName(previewShellClear)} style={mergedSurface}>
        <SwitchWidgetPreview key={previewVisualKey} downlinkSelectState={downlinkSelectState} />
      </div>
    );
  }
  if (previewDashWidgetId === DASH_WIDGET.DOWNLINK) {
    return (
      <div className={shellClassName(previewShellClear)} style={mergedSurface}>
        <DownlinkWidgetPreview key={previewVisualKey} draft={draft} downlinkSelectState={downlinkSelectState} />
      </div>
    );
  }
  if (previewDashWidgetId === DASH_WIDGET.IMAGE) {
    return (
      <div className={shellClassName(previewShellClear)} style={mergedSurface}>
        <ImageWidgetPreview key={previewVisualKey} draft={draft} liveProps={previewMergedLiveProps} />
      </div>
    );
  }
  if (previewDashWidgetId === DASH_WIDGET.MAP) {
    return (
      <div className={shellClassName(previewShellClear)} style={mergedSurface}>
        <MapWidgetPreview key={previewVisualKey} draft={draft} liveProps={previewMergedLiveProps} />
      </div>
    );
  }
  if (previewDashWidgetId === DASH_WIDGET.TRACKING_MAP) {
    return (
      <div className={shellClassName(previewShellClear)} style={mergedSurface}>
        <TrackingMapWidgetPreview key={previewVisualKey} />
      </div>
    );
  }

  if (previewBaseDashId === DASH_WIDGET.METRIC_CIRCULAR) {
    return (
      <ModalMetricCircularPreview
        draft={draft}
        previewMergedLiveProps={previewMergedLiveProps}
        previewLiveDeviceModel={previewLiveDeviceModel}
        previewTelemetryHints={previewTelemetryHints}
        title={title}
        titleColor={titleColor}
        mergedSurface={mergedSurface}
        previewShellClear={previewShellClear}
        previewVisualKey={previewVisualKey}
      />
    );
  }

  if (previewBaseDashId === DASH_WIDGET.SATISFACTION) {
    return (
      <ModalSatisfactionRingPreview
        draft={draft}
        previewMergedLiveProps={previewMergedLiveProps}
        previewLiveDeviceModel={previewLiveDeviceModel}
        previewTelemetryHints={previewTelemetryHints}
        title={title}
        titleColor={titleColor}
        mergedSurface={mergedSurface}
        previewShellClear={previewShellClear}
      />
    );
  }

  if (previewBaseDashId === DASH_WIDGET.CONTAINER) {
    return (
      <ModalContainerTankPreview
        draft={draft}
        previewMergedLiveProps={previewMergedLiveProps}
        previewLiveDeviceModel={previewLiveDeviceModel}
        previewTelemetryHints={previewTelemetryHints}
        title={title}
        titleColor={titleColor}
        mergedSurface={mergedSurface}
        previewShellClear={previewShellClear}
      />
    );
  }

  if (previewBaseDashId === DASH_WIDGET.BATTERY_LEVEL) {
    return (
      <ModalBatteryLevelPreview
        draft={draft}
        previewMergedLiveProps={previewMergedLiveProps}
        previewLiveDeviceModel={previewLiveDeviceModel}
        previewTelemetryHints={previewTelemetryHints}
        title={title}
        titleColor={titleColor}
        mergedSurface={mergedSurface}
        previewShellClear={previewShellClear}
      />
    );
  }

  if (valueSensor && numericValue) {
    const v =
      typeof previewValue === 'number' && !Number.isInteger(previewValue)
        ? previewValue.toFixed(decimals)
        : previewValue;
    const hasCustomLabel = previewTelemetryDisplayLabel != null && String(previewTelemetryDisplayLabel).trim();
    const displayMain = hasCustomLabel ? String(previewTelemetryDisplayLabel).trim() : v;
    return (
      <div
        className={['sensor-card', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
        style={{ width: '100%', ...mergedSurface }}
      >
        <div className="sensor-icon" aria-hidden>
          {sensor?.icon || '📟'}
        </div>
        <div className="sensor-name">{title}</div>
        <div className="sensor-value">
          {displayMain}
          {!hasCustomLabel && unit ? <span className="sensor-unit">{unit}</span> : null}
        </div>
        <div className="sensor-status status-normal">✓ NORMAL</div>
      </div>
    );
  }

  if (valueSensor) {
    return (
      <div
        className={['sensor-card', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
        style={{ width: '100%', ...mergedSurface }}
      >
        <ValueIndicator
          key={`${previewVisualKey}-${indicatorSelectValue}`}
          type={indicatorSelectValue}
          value={previewValue}
          unit={unit}
          decimals={decimals}
          scaleMin={scaleMin}
          scaleMax={scaleMax}
          ranges={ranges}
          inverseFill={Boolean(draft.gauge?.inverseFill)}
          title={title}
          titleColor={titleColor}
          subtitle={previewSensorSubtitle}
          valueLabel={
            previewTelemetryDisplayLabel != null && String(previewTelemetryDisplayLabel).trim()
              ? String(previewTelemetryDisplayLabel).trim()
              : undefined
          }
          compact
          theme="dark"
        />
        <div className="sensor-status status-normal">✓ NORMAL</div>
      </div>
    );
  }

  if (previewBaseDashId === DASH_WIDGET.TEXT) {
    const tw = modalTextWidgetUi;
    return (
      <div
        className={['widget', 'bsd-text-widget', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
        style={{ width: '100%', ...mergedSurface }}
      >
        <div className="widget-header bsd-text-widget__header">
          <div className="widget-title bsd-text-widget__title" style={{ color: titleColor }}>
            <span className="bsd-text-widget__title-icon" aria-hidden>
              📶
            </span>{' '}
          {title}
        </div>
      </div>
        <div className="bsd-text-widget__body">
          <div className="bsd-text-widget__value">{tw?.display ?? '—'}</div>
          {tw?.hint && tw.display !== tw.hint ? <div className="bsd-text-widget__hint">{tw.hint}</div> : null}
        </div>
        {tw?.lastAtLine ? (
          <div className="bsd-text-widget__footer" style={{ color: titleColor }}>
            {tw.lastAtLine}
      </div>
        ) : null}
      </div>
    );
  }

  if (previewBaseDashId === DASH_WIDGET.STREAM) {
    return (
      <div
        className={['widget', 'bsd-stream-widget-wrap', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(
          ' '
        )}
        style={{ width: '100%', ...mergedSurface }}
      >
        <div className="widget-header bsd-stream-widget-header">
          <div className="bsd-stream-widget-head-main">
            <div className="widget-title" style={{ color: titleColor }}>
              <span aria-hidden>📡</span> {title}
            </div>
            <div className="bsd-stream-status" style={{ color: titleColor }}>
              <span className="live-badge" aria-hidden />
              <span>En vivo · vista previa</span>
            </div>
          </div>
        </div>
        <div className="widget-edit-preview-dash-note">
          El gráfico interactivo se muestra en el tablero; aquí solo se reflejan título, fondo y estilo.
        </div>
      </div>
    );
  }

  if (previewBaseDashId === DASH_WIDGET.BAR_CHART) {
    return (
      <div
        className={['widget', 'bsd-bar-chart-widget', previewShellClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(
          ' '
        )}
        style={{ width: '100%', ...mergedSurface }}
      >
        <div className="widget-header bsd-bar-chart-widget__header">
          <div className="widget-title" style={{ color: titleColor }}>
            <span aria-hidden>📊</span> {title}
          </div>
        </div>
        <div className="widget-edit-preview-dash-note">
          Las barras y el historial se renderizan en el tablero; la vista previa muestra el aspecto del marco.
        </div>
      </div>
    );
  }

  return (
    <div className={shellClassName(previewShellClear)} style={mergedSurface}>
      <ValueIndicator
        key={`${previewVisualKey}-${indicatorSelectValue}`}
        type={indicatorSelectValue}
        value={previewValue}
        unit={unit}
        decimals={decimals}
        scaleMin={scaleMin}
        scaleMax={scaleMax}
        ranges={ranges}
        inverseFill={Boolean(draft.gauge?.inverseFill)}
        title={title}
        titleColor={titleColor}
        subtitle={previewSensorSubtitle}
        compact
        theme="dark"
      />
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

  /** Propiedades persistidas (GET /devices/:id/properties) para vista previa con datos reales del servidor. */
  const [dbPreviewProps, setDbPreviewProps] = useState({});

  const fixedDashWidgetId = useMemo(() => {
    if (!sensor || !isDashboardFixedWidgetSensor(sensor)) return null;
    return dashWidgetIdFromPropertyKey(sensor.propertyKey);
  }, [sensor]);

  const previewDashWidgetId = useMemo(() => {
    if (fixedDashWidgetId) return fixedDashWidgetId;
    return dashWidgetIdFromPropertyKey(sensor?.propertyKey);
  }, [sensor, fixedDashWidgetId]);

  const showPanelDevicePicker = useMemo(
    () =>
      bsdDashboardVariant === 'panel' &&
      Array.isArray(panelDeviceSelectOptions) &&
      panelDeviceSelectOptions.length > 0 &&
      Boolean(sensor && isDashboardFixedWidgetSensor(sensor)) &&
      fixedDashWidgetId &&
      fixedDashWidgetId !== DASH_WIDGET.PANEL_DEVICE_BAR &&
      fixedDashWidgetId !== DASH_WIDGET.IMAGE &&
      fixedDashWidgetId !== DASH_WIDGET.MAP,
    [bsdDashboardVariant, panelDeviceSelectOptions, sensor, fixedDashWidgetId]
  );

  const previewBoundDeviceId = useMemo(() => {
    if (!showPanelDevicePicker) return null;
    const raw = draft.data?.panelBoundDeviceId;
    if (raw != null && String(raw).trim()) return String(raw).trim();
    return panelFallbackDeviceId != null ? String(panelFallbackDeviceId) : null;
  }, [showPanelDevicePicker, draft.data?.panelBoundDeviceId, panelFallbackDeviceId]);

  /** Dispositivo cuyo último registro guardado alimenta la vista previa (API). */
  const previewFetchDeviceId = useMemo(() => {
    if (showPanelDevicePicker && previewBoundDeviceId) return previewBoundDeviceId;
    const sid = sensor?.sourceDeviceId;
    if (sid && sid !== 'dashboard' && sid !== 'demo') return String(sid);
    if (bsdDashboardVariant === 'panel' && panelFallbackDeviceId != null && String(panelFallbackDeviceId).trim()) {
      return String(panelFallbackDeviceId).trim();
    }
    return null;
  }, [showPanelDevicePicker, previewBoundDeviceId, sensor?.sourceDeviceId, bsdDashboardVariant, panelFallbackDeviceId]);

  useEffect(() => {
    if (!open || !previewFetchDeviceId) {
      queueMicrotask(() => {
        setDbPreviewProps({});
      });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const propsResp = await fetchDeviceProperties(previewFetchDeviceId, null, null);
        if (cancelled) return;
        const apiData = propsResp.data?.data || {};
        const rawProps = apiData.properties ?? propsResp.data?.properties ?? {};
        const normalized = normalizeStoredPropertiesForModalPreview(apiData, rawProps);
        setDbPreviewProps(normalized);
      } catch {
        if (cancelled) return;
        setDbPreviewProps({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, previewFetchDeviceId]);

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

  /** Telemetría en memoria + último snapshot persistido (servidor tiene prioridad en solapes). */
  const previewMergedLiveProps = useMemo(() => {
    const live =
      previewLiveProps && typeof previewLiveProps === 'object' && !Array.isArray(previewLiveProps)
        ? previewLiveProps
        : {};
    const db =
      dbPreviewProps && typeof dbPreviewProps === 'object' && !Array.isArray(dbPreviewProps) ? dbPreviewProps : {};
    const hasDb = db && Object.keys(db).length > 0;
    if (!hasDb) return live;
    return { ...live, ...db };
  }, [previewLiveProps, dbPreviewProps]);

  /** Panel: lista de campos en «Datos» según el dispositivo elegido (telemetría de ese equipo). */
  const effectiveAvailableDataFields = useMemo(() => {
    if (!showPanelDevicePicker) return availableDataFields;
    const props = previewMergedLiveProps;
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
    previewMergedLiveProps,
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
    if (fk.startsWith('__bsd_')) fk = '';
    /** Misma regla que el tablero: el lineal usa `streamSeries[0].fieldKey`, no `__bsd_dw_stream` (no existe en telemetría). */
    if (fixedDashWidgetId === DASH_WIDGET.STREAM) {
      const series = normalizeStreamSeriesConfig(draft.data);
      const first = series[0]?.fieldKey != null ? String(series[0].fieldKey).trim() : '';
      if (first && !first.startsWith('__bsd_')) fk = first;
    }
    if (!fk && sensor?.propertyKey != null) {
      const pk = String(sensor.propertyKey).trim();
      if (pk && !pk.startsWith('__bsd_')) fk = pk;
    }
    if (!fk && isDashboardFixedWidgetSensor(sensor) && fixedDashWidgetId) {
      fk = `__bsd_${fixedDashWidgetId}`;
    }
    return fk;
  }, [draft.data, sensor, fixedDashWidgetId]);

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
    if (open) return undefined;
    queueMicrotask(() => setFormulaProbeLine(''));
    return undefined;
  }, [open]);

  useEffect(() => {
    if (tab === 'formula') return undefined;
    queueMicrotask(() => setFormulaProbeLine(''));
    return undefined;
  }, [tab]);

  /** Número base para la fórmula (misma entrada que usa el tablero al evaluar). */
  const previewFormulaBaseNumber = useMemo(() => {
    const key = previewNumericSourceKey;
    let base = null;
    if (previewMergedLiveProps && key && previewMergedLiveProps[key] !== undefined) {
      base = parseLiveNumber(previewMergedLiveProps[key]);
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
    previewMergedLiveProps,
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
      DASH_WIDGET.CONTAINER,
      DASH_WIDGET.BATTERY_LEVEL,
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
      previewDashWidgetId === DASH_WIDGET.CONTAINER ||
      previewDashWidgetId === DASH_WIDGET.BATTERY_LEVEL ||
      previewDashWidgetId === DASH_WIDGET.METRIC_CIRCULAR
    );
  }, [draft.gauge?.indicatorType, previewDashWidgetId]);

  const visibleTabs = useMemo(() => {
    let tabs = tabsForScope(editScope);
    if (hideGaugeForWidget) tabs = tabs.filter((t) => t.id !== 'gauge');
    if (hideFormulaTabForWidget) tabs = tabs.filter((t) => t.id !== 'formula');
    if (previewDashWidgetId === DASH_WIDGET.IMAGE || previewDashWidgetId === DASH_WIDGET.MAP) {
      tabs = tabs.filter((t) => t.id !== 'data');
    }
    return tabs;
  }, [editScope, hideGaugeForWidget, hideFormulaTabForWidget, previewDashWidgetId]);

  /** Panel Control: [Básicos] [Dispositivo ▼] [Datos] […] según tipo (Imagen/Mapa: sin dispositivo ni Datos). */
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

  const activeTabResolved = visibleTabs.some((t) => t.id === activeTab) ? activeTab : 'basics';

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
  }, [previewDownlinks, draft.data]);

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
    if (!key || String(key).startsWith('__bsd_') || !previewMergedLiveProps || typeof previewMergedLiveProps !== 'object') {
      return { primary: fallback, alternate: undefined };
    }
    const cfg = draft;
    if (previewDashWidgetId === DASH_WIDGET.TEXT) {
      const scalar = resolveTextWidgetRawScalar(previewMergedLiveProps, key, cfg);
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
      const r = resolveTelemetryDisplaySource(previewMergedLiveProps, key);
      if (r !== undefined) return { primary: r, alternate: undefined };
    } else {
      const r = resolveTelemetryDisplaySource(previewMergedLiveProps, key);
      if (r !== undefined) return { primary: r, alternate: undefined };
    }
    return { primary: fallback, alternate: undefined };
  }, [
    previewTelemetryKey,
    previewMergedLiveProps,
    draft,
    previewDashWidgetId,
    previewLiveDeviceModel,
    previewTelemetryHints,
    sensor,
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

  const previewBaseDashId = useMemo(() => {
    if (!previewDashWidgetId) return null;
    return dashboardWidgetBaseId(previewDashWidgetId);
  }, [previewDashWidgetId]);

  const previewCardFieldKey = useMemo(() => {
    const fk = String(draft.data?.fieldKey ?? '').trim();
    if (fk && !fk.startsWith('__bsd_')) return fk;
    if (sensor?.propertyKey && !String(sensor.propertyKey).startsWith('__bsd_')) {
      return String(sensor.propertyKey).trim();
    }
    return previewTelemetryKey;
  }, [draft.data?.fieldKey, sensor, previewTelemetryKey]);

  const previewRangeAccent = useMemo(
    () =>
      colorForValueInRanges(
        previewValue,
        draft.gauge?.ranges || [],
        Number(draft.gauge?.scaleMin) || 0,
        Number(draft.gauge?.scaleMax) || 50
      ),
    [previewValue, draft.gauge?.ranges, draft.gauge?.scaleMin, draft.gauge?.scaleMax]
  );

  const previewTelemetryDisplayLabel = useMemo(() => {
    if (!previewMergedLiveProps || typeof previewMergedLiveProps !== 'object') return null;
    const fieldForDisplay = previewCardFieldKey;
    if (!fieldForDisplay || String(fieldForDisplay).startsWith('__bsd_')) return null;
    const rawForLabel = resolveTelemetryDisplaySource(previewMergedLiveProps, fieldForDisplay);
    if (rawForLabel !== undefined && rawForLabel !== null) {
      return tryTelemetryDisplayLabel(
        previewLiveDeviceModel,
        fieldForDisplay,
        rawForLabel,
        previewTelemetryHints
      );
    }
    return tryTelemetryDisplayLabel(
      previewLiveDeviceModel,
      fieldForDisplay,
      previewValue,
      previewTelemetryHints
    );
  }, [
    previewMergedLiveProps,
    previewCardFieldKey,
    previewLiveDeviceModel,
    previewTelemetryHints,
    previewValue,
  ]);

  const previewSensorSubtitle = useMemo(() => {
    const gran = draft.timeframe?.granularity;
    return draft.timeframe?.mode === 'interval' ? (gran ? `Historial (${gran})` : 'Intervalo') : 'En vivo';
  }, [draft.timeframe?.mode, draft.timeframe?.granularity]);

  const modalTextWidgetUi = useMemo(
    () => computeModalTextWidgetUi(previewMergedLiveProps, draft, previewLiveDeviceModel, previewTelemetryHints),
    [previewMergedLiveProps, draft, previewLiveDeviceModel, previewTelemetryHints]
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
    if (dashWid === DASH_WIDGET.IMAGE) {
      cfg.data = cfg.data || {};
      cfg.data.staticImageUrl = String(cfg.data.staticImageUrl ?? '').trim();
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

        <div className="widget-edit-modal-scroll">
        <div className="widget-edit-preview-wrap">
          <div
            className="widget-edit-preview widget-edit-preview--chrome-pass"
            role="region"
            aria-label="Vista previa del widget"
          >
            <ModalLivePreviewBlock
              sensor={sensor}
                draft={draft}
              showSensorGridPreview={showSensorGridPreview}
              previewDashWidgetId={previewDashWidgetId}
              previewBaseDashId={previewBaseDashId}
              previewVisualKey={previewVisualKey}
                indicatorSelectValue={indicatorSelectValue}
              previewMergedLiveProps={previewMergedLiveProps}
              previewValue={previewValue}
              previewShellSurfaceStyle={previewShellSurfaceStyle}
              previewShellClear={previewShellClear}
              previewRangeAccent={previewRangeAccent}
              previewTelemetryDisplayLabel={previewTelemetryDisplayLabel}
              previewSensorSubtitle={previewSensorSubtitle}
              modalTextWidgetUi={modalTextWidgetUi}
              effectiveAvailableDataFields={effectiveAvailableDataFields}
                downlinkSelectState={downlinkSelectState}
              previewLiveDeviceModel={previewLiveDeviceModel}
              previewTelemetryHints={previewTelemetryHints}
            />
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
                  aria-selected={activeTabResolved === panelToolbarTabs.basics.id}
                  className={`widget-edit-tab ${activeTabResolved === panelToolbarTabs.basics.id ? 'active' : ''}`}
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
                    aria-selected={activeTabResolved === t.id}
                    className={`widget-edit-tab ${activeTabResolved === t.id ? 'active' : ''}`}
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
                  aria-selected={activeTabResolved === t.id}
                  className={`widget-edit-tab ${activeTabResolved === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="widget-edit-body">
          {activeTabResolved === 'basics' && (
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
              {previewDashWidgetId === DASH_WIDGET.IMAGE && (
                <ImageWidgetBasicsImageSource draft={draft} setDraft={setDraft} />
              )}
              {previewDashWidgetId === DASH_WIDGET.MAP && (
                <MapWidgetBasicsCoords draft={draft} setDraft={setDraft} />
              )}
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

          {activeTabResolved === 'data' && (
            <div className="widget-edit-fields">
              {showTrackingMapDataSection ? (
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
                      <label className="widget-edit-label widget-edit-label--mt">
                        Campo de telemetría para ON/OFF en el tablero
                        <select
                          className="widget-edit-input"
                          value={String(draft.data?.switchTelemetryField || '')}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            update('data.switchTelemetryField', v || undefined);
                          }}
                        >
                          <option value="">Automático (prioriza relay/salida; evita LAST/RSSI/FCNT)</option>
                          {effectiveAvailableDataFields.map((key) => (
                            <option key={`sw_tel_${key}`} value={key}>
                              {key}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="widget-edit-hint">
                        Si el interruptor no coincide con el equipo físico, elige el campo que refleja el estado real del
                        relay o salida digital.
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

          {activeTabResolved === 'appearance' && (
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

          {activeTabResolved === 'gauge' && (
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

          {activeTabResolved === 'formula' && editScope === 'value' && (
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
