/**
 * Resuelve el valor de telemetría para condiciones de automatización usando la misma lógica
 * que el widget BSD (fórmula, invertir valor mostrado, etc.).
 */
import { parseTelemetryScalar } from './gatewayPayload';
import { transformWidgetNumeric } from './widgetFormula';
import { tryTelemetryDisplayLabel } from './telemetryDisplayFormat';
import {
  resolveTelemetryDisplaySource,
  invertDisplayedValueOnScale,
} from '../components/dashboard/widgetConfigUtils';

function fieldKeyMatchesWidget(cfg, propKey) {
  const pk = String(propKey || '').trim();
  if (!pk) return false;
  const fk = String(cfg?.data?.fieldKey ?? '').trim();
  const fsk = String(cfg?.data?.formulaSourceKey ?? '').trim();
  return fk === pk || fsk === pk;
}

/**
 * Busca la configuración del widget que muestra `propKey` para el dispositivo dado.
 * @param {Record<string, unknown>} allConfigs mapa `loadAllWidgetConfigs()` o `valueWidgets` del servidor
 * @param {string} deviceId
 * @param {string} propKey
 * @returns {Record<string, unknown> | null}
 */
export function findWidgetConfigForDeviceField(allConfigs, deviceId, propKey) {
  if (!allConfigs || typeof allConfigs !== 'object') return null;
  const did = String(deviceId || '').trim();
  const pk = String(propKey || '').trim();
  if (!did || !pk) return null;

  const devicePrefix = `device|${did}|`;
  const directKey = `${devicePrefix}${pk}`;
  if (allConfigs[directKey] && typeof allConfigs[directKey] === 'object') {
    return allConfigs[directKey];
  }

  for (const [key, cfg] of Object.entries(allConfigs)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (String(key).startsWith(devicePrefix) && fieldKeyMatchesWidget(cfg, pk)) {
      return cfg;
    }
  }

  for (const [key, cfg] of Object.entries(allConfigs)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (!String(key).startsWith('panel|')) continue;
    if (!fieldKeyMatchesWidget(cfg, pk)) continue;
    const bound = cfg?.data?.panelBoundDeviceId;
    if (bound != null && String(bound).trim() === did) return cfg;
  }

  return null;
}

function telemetryFieldKeyForWidget(cfg, propKey) {
  const fsk = cfg?.data?.formulaSourceKey != null ? String(cfg.data.formulaSourceKey).trim() : '';
  if (fsk) return fsk;
  const fk = cfg?.data?.fieldKey != null ? String(cfg.data.fieldKey).trim() : '';
  if (fk && !fk.startsWith('__bsd_')) return fk;
  return String(propKey || '').trim();
}

/**
 * Aplica fórmula / invertir valor mostrado sobre la lectura cruda.
 * @param {Record<string, unknown>} props telemetría expandida del dispositivo
 * @param {string} propKey clave elegida en la condición
 * @param {Record<string, unknown>} cfg configuración del widget
 * @param {unknown} rawValue valor crudo ya resuelto (p. ej. pulsador normalizado)
 * @param {{ deviceModel?: string, telemetryHints?: object }} [opts]
 */
export function applyWidgetTransformsToConditionValue(props, propKey, cfg, rawValue, opts = {}) {
  const readFk = telemetryFieldKeyForWidget(cfg, propKey);
  const rawScalar =
    props && typeof props === 'object' && readFk
      ? resolveTelemetryDisplaySource(props, readFk)
      : rawValue;

  const nParsed = parseTelemetryScalar(rawScalar ?? rawValue);
  const formulaActive =
    Boolean(cfg?.data?.formulaEnabled) && String(cfg?.data?.formulaExpression ?? '').trim() !== '';

  if (nParsed != null && Number.isFinite(nParsed)) {
    let n = transformWidgetNumeric(cfg, nParsed);
    if (n == null || !Number.isFinite(n)) n = nParsed;
    if (Boolean(cfg?.gauge?.invertDisplayedValue)) {
      const lo = Number(cfg?.gauge?.scaleMin);
      const hi = Number(cfg?.gauge?.scaleMax);
      const scaleLo = Number.isFinite(lo) ? lo : 0;
      const scaleHi = Number.isFinite(hi) && hi > scaleLo ? hi : scaleLo + 100;
      n = invertDisplayedValueOnScale(n, scaleLo, scaleHi);
    }
    return n;
  }

  if (!formulaActive && props && readFk && rawScalar !== undefined) {
    const friendly = tryTelemetryDisplayLabel(
      opts.deviceModel,
      readFk,
      rawScalar,
      opts.telemetryHints
    );
    if (friendly != null && String(friendly).trim() !== '') return String(friendly).trim();
  }

  if (rawValue !== undefined && rawValue !== null) return rawValue;
  return rawScalar;
}

/**
 * @param {unknown} rawValue
 * @param {Record<string, unknown>} cond
 * @param {Record<string, unknown>} props
 * @param {Record<string, unknown>} allWidgetConfigs
 * @param {{ deviceModel?: string, telemetryHints?: object }} [opts]
 */
export function resolveAutomationConditionCompareValue(
  rawValue,
  cond,
  props,
  allWidgetConfigs,
  opts = {}
) {
  if (!cond?.useWidgetValue) return rawValue;
  const did = cond.deviceId != null ? String(cond.deviceId).trim() : '';
  const pk = cond.propKey != null ? String(cond.propKey).trim() : '';
  const cfg = findWidgetConfigForDeviceField(allWidgetConfigs, did, pk);
  if (!cfg) return rawValue;
  return applyWidgetTransformsToConditionValue(props, pk, cfg, rawValue, opts);
}
