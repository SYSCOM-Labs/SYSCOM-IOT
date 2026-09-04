/**
 * Medidor semicircular «Métrica circular» y utilidades compartidas tablero / modal de edición.
 */
import { parseTelemetryScalar } from '../../utils/gatewayPayload';
import { transformWidgetNumeric } from '../../utils/widgetFormula';
import { tryTelemetryDisplayLabel } from '../../utils/telemetryDisplayFormat';
import {
  resolveTextWidgetRawScalar,
  gaugeFillProgressT,
  invertDisplayedValueOnScale,
} from './widgetConfigUtils';

/** Anillo del widget Circular (porcentaje): radio en viewBox 200×200. */
export const BSD_CIRCULAR_GAUGE_R = 76;
export const BSD_CIRCULAR_GAUGE_STROKE = 24;
export const BSD_CIRCULAR_GAUGE_LEN = 2 * Math.PI * BSD_CIRCULAR_GAUGE_R;

/** Métrica circular: arco ~240° (viewBox más alto para no recortar ticks). */
export const MC_CX = 120;
export const MC_CY = 108;
export const MC_R = 72;
export const MC_ARC_START = (150 * Math.PI) / 180;
export const MC_ARC_SWEEP = (240 * Math.PI) / 180;
export const MC_VIEWBOX = '0 0 240 172';
export const MC_ASPECT = '240 / 172';
export const MC_TICK_INSET = 10;
export const MC_TICK_OUTSET = 18;
export const MC_TICK_LABEL_R = MC_R + 28;

export function mcPoint(cx, cy, r, theta) {
  return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
}

function mcArcPathD(cx, cy, r, theta0, theta1) {
  const p0 = mcPoint(cx, cy, r, theta0);
  const p1 = mcPoint(cx, cy, r, theta1);
  const delta = theta1 - theta0;
  const large = Math.abs(delta) > Math.PI ? 1 : 0;
  const sweep = delta > 0 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} ${sweep} ${p1.x} ${p1.y}`;
}

export const MC_ARC_PATH_D = mcArcPathD(MC_CX, MC_CY, MC_R, MC_ARC_START, MC_ARC_START + MC_ARC_SWEEP);
/** Longitud del trazo del arco (≈ r·Δθ) para stroke-dasharray / offset. */
export const MC_ARC_GEOM_LEN = MC_R * MC_ARC_SWEEP;

function telemetryFieldKeyForFormula(cfg, defaultKey) {
  const fs = cfg?.data?.formulaSourceKey != null ? String(cfg.data.formulaSourceKey).trim() : '';
  return fs || String(defaultKey ?? '').trim();
}

function formatLastTelemetryUpdateLine(ts) {
  if (ts == null) return '';
  const n = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(n)) return '';
  return `Última actualización: ${new Date(n).toLocaleString()}`;
}

export function buildMetricCircularTicksFromUi(ui) {
  const lo = ui.scaleLo;
  const hi = ui.scaleHi;
  const span = hi - lo;
  const d = ui.tickDec;
  return [0, 1 / 3, 2 / 3, 1].map((f) => {
    const val = lo + f * span;
    return {
      f,
      val,
      label: val.toFixed(d),
      theta: MC_ARC_START + f * MC_ARC_SWEEP,
    };
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} cfg
 * @param {Record<string, unknown> | null | undefined} telemetryLiveProps
 */
export function computeMetricCircularUi(cfg, telemetryLiveProps, liveDeviceModel, telemetryHintMap) {
  const fkRaw = cfg?.data?.fieldKey;
  const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
  const readFk = telemetryFieldKeyForFormula(cfg, fkStr);
  const rawLiveScalar =
    telemetryLiveProps && typeof telemetryLiveProps === 'object' && !Array.isArray(telemetryLiveProps)
      ? resolveTextWidgetRawScalar(telemetryLiveProps, readFk, cfg)
      : undefined;
  const useLive =
    Boolean(readFk) &&
    !readFk.startsWith('__bsd_') &&
    telemetryLiveProps &&
    typeof telemetryLiveProps === 'object' &&
    rawLiveScalar !== undefined;
  const nParsed = useLive ? parseTelemetryScalar(rawLiveScalar) : null;
  const n = transformWidgetNumeric(cfg, nParsed);
  const formulaActive =
    Boolean(cfg?.data?.formulaEnabled) && String(cfg?.data?.formulaExpression ?? '').trim() !== '';

  const decRaw = cfg?.data?.decimals;
  const dec =
    decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
      ? Math.min(20, Math.max(0, Number(decRaw)))
      : 1;
  const unit = cfg?.data?.unit != null ? String(cfg.data.unit) : '';
  const min = Number(cfg?.gauge?.scaleMin);
  const max = Number(cfg?.gauge?.scaleMax);
  const lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) && max > lo ? max : lo + 60;
  const ranges = Array.isArray(cfg?.gauge?.ranges) ? cfg.gauge.ranges : [];
  const rangeMax = ranges.length
    ? Math.max(...ranges.map((r) => Number(r.value)).filter((x) => Number.isFinite(x)))
    : -Infinity;
  const unitLc = unit.toLowerCase();
  const fieldLc = fkStr.toLowerCase();
  const preferHundredScale =
    unitLc.includes('%') ||
    /\bpercent|por\s*ciento/.test(unitLc) ||
    fieldLc.includes('battery') ||
    fieldLc.includes('bater') ||
    fieldLc.includes('humidity') ||
    fieldLc.includes('humedad');
  if (Number.isFinite(rangeMax) && rangeMax > hi) hi = rangeMax;
  if (preferHundredScale) hi = Math.max(hi, 100);
  const gradMode = cfg?.data?.metricGradient === 'thermal' ? 'thermal' : 'traffic';
  const userSub = cfg?.data?.metricSubtitle != null ? String(cfg.data.metricSubtitle).trim() : '';
  const tickDec = hi - lo >= 20 ? 1 : 2;
  const lastAtLine = formatLastTelemetryUpdateLine(telemetryLiveProps?.lastUpdateTime);

  const inverseFill = Boolean(cfg?.gauge?.inverseFill);

  if (n !== null && Number.isFinite(n)) {
    const t = Math.min(1, Math.max(0, gaugeFillProgressT(n, lo, hi, inverseFill)));
    const rawLive = useLive ? rawLiveScalar : undefined;
    const friendly =
      !formulaActive && useLive && rawLive !== undefined
        ? tryTelemetryDisplayLabel(liveDeviceModel, fkStr, rawLive, telemetryHintMap)
        : null;
    const centerMain = friendly || `${n.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim();
    const svgSubtitleLine = userSub;
    return {
      hasValue: true,
      rawValue: n,
      centerMain,
      svgSubtitleLine,
      lastAtLine,
      needleT: t,
      scaleLo: lo,
      scaleHi: hi,
      gradientMode: gradMode,
      tickDec,
      unitDisplay: unit,
      ranges,
    };
  }

  const centerMain = '—';
  let svgSubtitleLine = userSub;
  if (!svgSubtitleLine) {
    if (!fkStr || fkStr.startsWith('__bsd_')) svgSubtitleLine = 'Configura el campo en edición';
    else svgSubtitleLine = 'Sin lectura en vivo';
  }
  return {
    hasValue: false,
    rawValue: null,
    centerMain,
    svgSubtitleLine,
    lastAtLine,
    needleT: null,
    scaleLo: lo,
    scaleHi: hi,
    gradientMode: gradMode,
    tickDec,
    unitDisplay: unit,
    ranges,
  };
}

export function computeMetricCircularUiForSlot(
  dk,
  widgetConfigs,
  slotWid,
  telemetryLiveProps,
  liveDeviceModel,
  telemetryHintMap
) {
  const key = dk(slotWid);
  const cfg = widgetConfigs[key];
  return computeMetricCircularUi(cfg, telemetryLiveProps, liveDeviceModel, telemetryHintMap);
}

/** Widget «Circular» (anillo de porcentaje): misma lógica de valores que el tablero. */
export function computeSatisfactionRingUi(cfg, telemetryLiveProps, liveDeviceModel, telemetryHintMap) {
  const min = Number(cfg?.gauge?.scaleMin);
  const max = Number(cfg?.gauge?.scaleMax);
  const scaleLo = Number.isFinite(min) ? min : 0;
  const scaleHi = Number.isFinite(max) && max > scaleLo ? max : scaleLo + 100;
  const gaugeRanges = Array.isArray(cfg?.gauge?.ranges) ? cfg.gauge.ranges : [];
  const inverseFill = Boolean(cfg?.gauge?.inverseFill);

  const fkRaw = cfg?.data?.fieldKey;
  const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
  const readFk = telemetryFieldKeyForFormula(cfg, fkStr);
  const rawScalar =
    telemetryLiveProps && typeof telemetryLiveProps === 'object' && !Array.isArray(telemetryLiveProps)
      ? resolveTextWidgetRawScalar(telemetryLiveProps, readFk, cfg)
      : undefined;
  const useLive = Boolean(readFk) && !readFk.startsWith('__bsd_') && rawScalar !== undefined;
  const nParsed = useLive ? parseTelemetryScalar(rawScalar) : null;
  const n = transformWidgetNumeric(cfg, nParsed);
  const formulaActive =
    Boolean(cfg?.data?.formulaEnabled) && String(cfg?.data?.formulaExpression ?? '').trim() !== '';
  const lastAtLine = formatLastTelemetryUpdateLine(telemetryLiveProps?.lastUpdateTime);

  if (n !== null && Number.isFinite(n)) {
    const decRaw = cfg?.data?.decimals;
    const dec =
      decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
        ? Math.min(20, Math.max(0, Number(decRaw)))
        : 2;
    const unit = cfg?.data?.unit != null ? String(cfg.data.unit) : '';
    const t = Math.min(1, Math.max(0, gaugeFillProgressT(n, scaleLo, scaleHi, inverseFill)));
    const pct = Math.round(t * 100);
    const rawLive = useLive ? rawScalar : undefined;
    const friendly =
      !formulaActive && useLive && rawLive !== undefined
        ? tryTelemetryDisplayLabel(liveDeviceModel, fkStr, rawLive, telemetryHintMap)
        : null;
    const label = friendly || `${n.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim();
    return {
      ringPct: pct,
      centerLabel: label,
      rawValue: n,
      scaleMin: scaleLo,
      scaleMax: scaleHi,
      ranges: gaugeRanges,
      lastAtLine,
    };
  }

  const span = scaleHi - scaleLo;
  const mid = scaleLo + span * 0.5;
  const t0 = Math.min(1, Math.max(0, gaugeFillProgressT(mid, scaleLo, scaleHi, inverseFill)));
  const fallbackPct = Math.round(t0 * 100);
  return {
    ringPct: fallbackPct,
    centerLabel: `${fallbackPct}%`,
    rawValue: null,
    scaleMin: scaleLo,
    scaleMax: scaleHi,
    ranges: gaugeRanges,
    lastAtLine,
  };
}

/** Widget «Contenedor»: como Circular + opción de invertir solo el valor mostrado en la escala. */
export function computeContainerTankUi(cfg, telemetryLiveProps, liveDeviceModel, telemetryHintMap) {
  const ui = computeSatisfactionRingUi(cfg, telemetryLiveProps, liveDeviceModel, telemetryHintMap);
  if (!Boolean(cfg?.gauge?.invertDisplayedValue) || ui.rawValue == null || !Number.isFinite(ui.rawValue)) {
    return ui;
  }
  const inv = invertDisplayedValueOnScale(ui.rawValue, ui.scaleMin, ui.scaleMax);
  const decRaw = cfg?.data?.decimals;
  const dec =
    decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
      ? Math.min(20, Math.max(0, Number(decRaw)))
      : 2;
  const unit = cfg?.data?.unit != null ? String(cfg.data.unit) : '';
  const label = `${inv.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim();
  return { ...ui, centerLabel: label };
}

/** Widget «Nivel Batería»: misma escala / telemetría / fórmula que el anillo Circular. */
export const computeBatteryLevelUi = computeSatisfactionRingUi;
