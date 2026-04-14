import {
  PROPERTY_INFER_IGNORE_SET,
  telemetryKeyPriorityBonus,
  expandNestedGatewayTelemetry,
} from './gatewayPayload';

/** Claves de metadatos / cuenta / decoder — no son telemetría escalar útil */
const IGNORE_KEYS = PROPERTY_INFER_IGNORE_SET;

/** Preferir no usar como métrica principal del widget */
const LOW_PRIORITY_KEYS = new Set([
  'assignments',
  'description',
  'registered',
  'superadminGlobalView',
  'email',
  'password',
  'role',
  'created_at',
  'createdAt',
  'ingestToken',
  'ingest_token',
]);

function humanizeKey(key) {
  return String(key).charAt(0).toUpperCase() + String(key).slice(1).replace(/_/g, ' ');
}

/**
 * Construye lista tipo TSL desde propiedades en vivo (mismo criterio que Dashboard).
 */
export function inferTslPropsFromLive(combinedLive) {
  if (!combinedLive || typeof combinedLive !== 'object') return [];
  const live = expandNestedGatewayTelemetry(combinedLive);
  return Object.keys(live)
    .filter(
      (key) =>
        !IGNORE_KEYS.has(key) &&
        !String(key).endsWith('_alarm') &&
        live[key] !== null &&
        typeof live[key] !== 'object' &&
        !Array.isArray(live[key])
    )
    .map((key) => ({
      id: key,
      propertyKey: key,
      name: humanizeKey(key),
      unit: '',
    }));
}

function scoreForTelemetry(key, rawVal) {
  if (IGNORE_KEYS.has(key)) return -1000;
  let base = telemetryKeyPriorityBonus(key);
  if (LOW_PRIORITY_KEYS.has(key)) base -= 200;

  if (typeof rawVal === 'number' && Number.isFinite(rawVal)) return 500 + base;
  if (typeof rawVal === 'boolean') return 50 + base;
  if (rawVal == null) return 5 + base;
  if (typeof rawVal === 'object') return -500;

  if (typeof rawVal === 'string') {
    const t = rawVal.trim();
    if (t.length > 120) return -100 + base;
    const n = parseFloat(t);
    if (Number.isFinite(n) && t.length < 24) return 400 + base;
    return 80 + base;
  }
  return 20 + base;
}

/**
 * Elige la mejor propiedad para un widget de sensor (evita assignments/description, prioriza números).
 * @param {Array<{ id?: string, propertyKey: string, name?: string, unit?: string }>} tslList
 * @param {Record<string, unknown>} liveProps
 * @returns {{ id: string, propertyKey: string, name: string, unit: string }}
 */
export function pickDefaultTelemetryProperty(tslList, liveProps) {
  const live = liveProps && typeof liveProps === 'object' ? liveProps : {};
  const liveExpanded = expandNestedGatewayTelemetry(live);
  let list = Array.isArray(tslList) ? [...tslList] : [];

  if (list.length === 0) {
    list = inferTslPropsFromLive(live);
  }

  if (list.length === 0) {
    return {
      id: 'value',
      propertyKey: 'value',
      name: 'Valor',
      unit: '',
    };
  }

  const scored = list
    .map((p) => {
      const key = p.propertyKey || p.id;
      const val = liveExpanded[key];
      return { p: { ...p, propertyKey: key, id: p.id || key, name: p.name || humanizeKey(key), unit: p.unit || '' }, score: scoreForTelemetry(key, val) };
    })
    .filter((x) => x.score > -100)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const first = list[0];
    const k = first.propertyKey || first.id;
    return { ...first, propertyKey: k, id: first.id || k, name: first.name || humanizeKey(k), unit: first.unit || '' };
  }

  const best = scored[0].p;
  return {
    id: best.id || best.propertyKey,
    propertyKey: best.propertyKey,
    name: best.name || humanizeKey(best.propertyKey),
    unit: best.unit || '',
  };
}
