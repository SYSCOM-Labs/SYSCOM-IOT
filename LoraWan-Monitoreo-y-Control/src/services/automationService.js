import axios from 'axios';
import { sendDownlink, fetchAutomationRules } from './api.js';
import { getApiBase } from '../config/apiBase.js';
import { getLatestDeviceData } from './localAuth.js';
import { expandNestedGatewayTelemetry } from '../utils/gatewayPayload.js';
import { SYSCOM_AUTOMATION_TOAST } from '../constants/automationEvents.js';
import { tryShowAutomationBrowserNotification } from '../utils/browserNotifications.js';
import { playAutomationToastBell } from '../utils/automationToastSound.js';
import { loadAllWidgetConfigs } from '../components/dashboard/widgetConfigUtils.js';
import { resolveAutomationConditionCompareValue } from '../utils/automationWidgetValue.js';
import {
  effectiveAutomationConditions,
  resolveAutomationRuleMode,
} from '../utils/automationRuleMode.js';

/**
 * Automation Engine
 */

const TOAST_VARIANTS = new Set(['slate', 'emerald', 'indigo', 'amber', 'rose']);

/** Dispara el toast en la app y, si la pestaña está en segundo plano y hay permiso, la notificación del sistema. */
export function showAutomationToast(detail) {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  const d = detail && typeof detail === 'object' ? detail : {};
  window.dispatchEvent(new CustomEvent(SYSCOM_AUTOMATION_TOAST, { detail: d }));
  void playAutomationToastBell();
  void tryShowAutomationBrowserNotification({
    title: d.title,
    body: d.subtitle,
    tag: d.notificationTag || `syscom-iot-${Date.now()}`,
  });
}

// Memory cache for last execution times to prevent spam (Debouncing)
// Key: ruleId-actionIndex
const cooldownStorage = {};

let rulesCache = null;
let rulesCacheAt = 0;
/** Alineado con refresco de widgets (~5s) para reglas más reactivas. */
const RULES_CACHE_MS = 5000;

export function invalidateAutomationRulesCache() {
  rulesCache = null;
  rulesCacheAt = 0;
}

/**
 * @param {{ bypassCache?: boolean }} [opts] Si `bypassCache`, siempre pide al servidor (evita email con asunto/cuerpo
 * antiguos tras guardar la regla; el cliente ejecuta email/webhook/toast con `skipDownlink` y omite solo downlinks).
 */
async function loadRulesFromServer(opts = {}) {
  const bypass = Boolean(opts.bypassCache);
  if (!bypass && rulesCache != null && Date.now() - rulesCacheAt < RULES_CACHE_MS) {
    return rulesCache;
  }
  try {
    const fresh = await fetchAutomationRules();
    rulesCache = fresh;
    rulesCacheAt = Date.now();
    return fresh;
  } catch {
    if (rulesCache != null) return rulesCache;
    const legacy = localStorage.getItem('iot_automations');
    return legacy ? JSON.parse(legacy) : [];
  }
}

/**
 * @param {{ skipDownlink?: boolean }} [runOpts] Si `skipDownlink`, no se envían downlinks (el servidor ya los encoló).
 */
export const runAutomations = async (devices, deviceProperties, credentials, token, auth, runOpts = {}) => {
  const rules = await loadRulesFromServer({ bypassCache: Boolean(runOpts.skipDownlink) });
  if (!rules || !rules.length) return;

  const activeRules = rules.filter((r) => r.active !== false);
  const now = new Date();
  const currentDay = now.getDay(); // 0-6 (Sun-Sat)
  const currentTimeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const widgetConfigsForRules = loadAllWidgetConfigs();

  for (const rule of activeRules) {
    const ruleMode = resolveAutomationRuleMode(rule);
    const effectiveConditions = effectiveAutomationConditions(rule.conditions);

    // Reglas solo por horario: el servidor las evalúa en el tick de agenda.
    if (ruleMode === 'schedule') continue;

    // Modo condiciones: sin ventana horaria (evita conflicto horario + IF).

    // Check Conditions (All must be true - AND logic)
    let allConditionsMet = true;
    for (const cond of effectiveConditions) {
      const did = cond.deviceId != null ? String(cond.deviceId) : '';
      const props = did ? deviceProperties[did] : null;
      const pk = cond.propKey != null && cond.propKey !== '' ? String(cond.propKey) : '';
      const rawDeviceValue =
        props && pk
          ? deviceValueForAutomationCondition(props, pk)
          : undefined;
      if (rawDeviceValue === undefined) {
        allConditionsMet = false;
        break;
      }

      const deviceValue = resolveAutomationConditionCompareValue(
        rawDeviceValue,
        cond,
        props,
        widgetConfigsForRules
      );

      if (!evaluateCondition(deviceValue, cond.operator, cond.value)) {
        allConditionsMet = false;
        break;
      }
    }

    if (!allConditionsMet) {
      // One-shot rules must be re-armable once conditions are no longer true.
      if (!rule.allowReactivation) {
        for (let i = 0; i < (rule.actions || []).length; i++) {
          const cooldownKey = `${rule.id}-${i}`;
          cooldownStorage[cooldownKey] = 0;
        }
      }
      continue;
    }

    // 3. Execute Actions
    for (let i = 0; i < (rule.actions || []).length; i++) {
        const action = rule.actions[i];
        const cooldownKey = `${rule.id}-${i}`;
        const lastExec = cooldownStorage[cooldownKey] || 0;

        if (rule.allowReactivation) {
          const reactivationLimit = Math.max(60, parseInt(String(rule.reactivation || 60), 10) || 60) * 1000;
          if (Date.now() - lastExec < reactivationLimit) continue;
        } else if (lastExec > 0) {
          continue;
        }

        // Apply delay if any
        if (runOpts.skipDownlink && action.type === 'downlink') {
          continue;
        }

        const delaySeconds = Math.max(0, parseInt(action.delay || 0));
        if (delaySeconds > 0) {
          setTimeout(
            () =>
              executeAction(action, rule, devices, credentials, token, auth, runOpts).catch((e) => {
                console.warn(`[Automation] acción retrasada (${action.type}):`, e?.message || e);
              }),
            delaySeconds * 1000
          );
        } else {
          await executeAction(action, rule, devices, credentials, token, auth, runOpts);
        }

        // Update cooldown
        cooldownStorage[cooldownKey] = Date.now();
    }
  }
};

/** @deprecated EmailJS sustituido por SMTP en servidor. */
export function readEmailJsConfigFromStorage() {
  return null;
}

/**
 * POST interno siempre bajo `/api/...`. Si `VITE_API_BASE` es `http://host:3001` sin `/api`, lo añadimos
 * (evita 404 al llamar `http://host:3001/automation/webhook-relay`).
 */
function resolveApiWebhookRelayUrl() {
  const raw = String(getApiBase() ?? '/api').trim();
  if (!raw) return '/api/automation/webhook-relay';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      let p = u.pathname || '';
      if (p.endsWith('/')) p = p.slice(0, -1);
      if (p === '' || p === '/') {
        u.pathname = '/api/automation/webhook-relay';
      } else if (p.endsWith('/api')) {
        u.pathname = `${p}/automation/webhook-relay`;
      } else {
        u.pathname = `${p}/api/automation/webhook-relay`;
      }
      return u.toString();
    } catch {
      return '/api/automation/webhook-relay';
    }
  }
  let rel = raw.startsWith('/') ? raw : `/${raw}`;
  if (rel.endsWith('/')) rel = rel.slice(0, -1) || '/';
  if (rel !== '/api' && !rel.endsWith('/api')) {
    rel = rel === '/' ? '/api' : `${rel}/api`;
  }
  return `${rel}/automation/webhook-relay`;
}

/** Misma lógica que el relay: URL de PushMore con /webhook/ (el cliente fuerza texto plano por si el host varía). */
function isPushMoreWebhookTargetUrl(u) {
  return /https?:\/\/(?:www\.)?pushmore\.io\/webhook\//i.test(String(u || '').trim());
}

const sendWebhookAction = async (action, rule, token) => {
  let url = String(action.target || '').trim();
  if (!url) {
    console.warn('[Automation] Webhook: falta la URL (p. ej. https://pushmore.io/webhook/…).');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url.replace(/^\/+/, '')}`;
  }
  const pushMorePlain = isPushMoreWebhookTargetUrl(url);
  if (!token) {
    console.warn('[Automation] Webhook: no hay token de sesión; inicie sesión de nuevo.');
    return;
  }
  const rawCustom = String(action.webhookBody ?? action.webhook_message ?? '').trim();
  const conds = rule.conditions || [];
  const triggeredBy = conds.map((c) => c.propName || c.propKey || '—').join(', ');
  const base = {
    ruleName: rule.name,
    timestamp: new Date().toISOString(),
    triggeredBy,
    conditions: conds.map((c) => ({
      propName: c.propName,
      propKey: c.propKey,
      operator: c.operator,
      value: c.value,
    })),
  };

  let payload = base;
  if (rawCustom) {
    if (rawCustom.startsWith('{') && rawCustom.endsWith('}')) {
      try {
        const parsed = JSON.parse(rawCustom);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = { ...base, ...parsed };
        } else {
          payload = { ...base, message: rawCustom, text: rawCustom };
        }
      } catch {
        payload = { ...base, message: rawCustom, text: rawCustom };
      }
    } else {
      payload = { ...base, message: rawCustom, text: rawCustom };
    }
  }

  const relayUrl = resolveApiWebhookRelayUrl();
  try {
    await axios.post(
      relayUrl,
      { url, payload, ...(pushMorePlain ? { pushMorePlain: true } : {}) },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    const st = err?.response?.status;
    if (st === 404) {
      console.warn(
        `[Automation] Webhook relay 404 en ${relayUrl}. Use VITE_API_BASE con sufijo /api (p. ej. http://localhost:3001/api), reinicie Vite y el backend tras actualizar.`
      );
    } else {
      logWebhookRelayAxiosError(err);
    }
    throw err;
  }
};

function logWebhookRelayAxiosError(err) {
  const st = err?.response?.status;
  const data = err?.response?.data;
  const msg =
    data && typeof data === 'object'
      ? data.error || data.message || JSON.stringify(data)
      : err?.message || String(err);
  console.warn('[Automation] Webhook relay falló.', st || '', msg);
  if (data?.upstreamBodyPreview) {
    console.warn('[Automation] Vista previa cuerpo upstream:', data.upstreamBodyPreview);
  }
}

const executeAction = async (action, rule, devices, credentials, token, auth, runOpts = {}) => {
    console.log(`[Automation] Triggered: ${rule.name} -> ${action.type}`);
    
    try {
        switch (action.type) {
            case 'email':
                /* Los emails los envía el servidor (automation-runner + SMTP). */
                break;
            case 'webhook':
                await sendWebhookAction(action, rule, token);
                break;
            case 'downlink':
                if (runOpts.skipDownlink) break;
                if (action.targetDeviceId && action.commandKey) {
                    await sendDownlink(String(action.targetDeviceId), action.commandKey, credentials, token);
                }
                break;
            case 'toast': {
                const rawV = String(action.toastVariant ?? action.toast_variant ?? 'indigo').toLowerCase();
                const variant = TOAST_VARIANTS.has(rawV) ? rawV : 'indigo';
                const title =
                    String(action.toastTitle ?? action.toast_title ?? '').trim() || `Alerta: ${rule.name}`;
                const subtitle = String(action.toastMessage ?? action.toast_message ?? '').trim();
                showAutomationToast({
                    appLabel: 'SYSCOM IoT',
                    title,
                    subtitle,
                    variant,
                    notificationTag: `rule-${rule.id != null ? String(rule.id) : 'na'}-${Date.now()}`,
                });
                break;
            }
            default:
                console.warn('Unknown action type:', action.type);
        }
    } catch (err) {
        console.error(`Action execution failed (${action.type}):`, err);
    }
};

function rawButtonEventStatusFromProps(props) {
  if (!props) return undefined;
  if (props.button_event_status != null) return props.button_event_status;
  const be = props.button_event;
  if (be && typeof be === 'object' && !Array.isArray(be) && be.status != null) return be.status;
  return undefined;
}

function tokenFromButtonStatusRaw(raw) {
  if (raw == null) return undefined;
  const s = String(raw)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (s.includes('short')) return 'short';
  if (s.includes('long')) return 'long';
  if (s.includes('double')) return 'double';
  return String(raw).trim();
}

/**
 * Valor usado en condiciones para pulsador Milesight / WS101.
 * Normaliza "long press" → "long" para que coincida con el valor de la regla.
 */
function deviceValueForAutomationCondition(props, propKey) {
  if (!props || propKey == null || propKey === '') return undefined;
  const pk = String(propKey);
  const rawSt = rawButtonEventStatusFromProps(props);

  if (pk === 'press') {
    if (rawSt != null) return tokenFromButtonStatusRaw(rawSt);
    if (Object.prototype.hasOwnProperty.call(props, 'press') && props.press !== undefined) {
      return props.press;
    }
    return undefined;
  }
  if (pk === 'button_event_status') {
    if (rawSt != null) return tokenFromButtonStatusRaw(rawSt);
    return undefined;
  }
  if (pk === 'button_event') {
    if (rawSt != null) return tokenFromButtonStatusRaw(rawSt);
    return props.button_event;
  }
  if (Object.prototype.hasOwnProperty.call(props, pk)) {
    return props[pk];
  }
  return undefined;
}

/** "HH:mm" o "HH:mm:ss" → minutos desde medianoche (con fracción por segundos). */
function clockToMinutes(clock) {
  const parts = String(clock || '')
    .trim()
    .split(':');
  const h = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
  const m = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
  const sec = parts.length > 2 ? Math.min(59, Math.max(0, parseInt(parts[2], 10) || 0)) : 0;
  return h * 60 + m + sec / 60;
}

const isTimeInRange = (current, start, end) => {
  const cur = clockToMinutes(current);
  const st = clockToMinutes(start || '00:00');
  const en = clockToMinutes(end || '23:59');
  if (st <= en) return cur >= st && cur <= en;
  return cur >= st || cur <= en;
};

const evaluateCondition = (actual, operator, target) => {
  const a = parseFloat(actual);
  const t = parseFloat(target);
  
  if (isNaN(a) || isNaN(t)) {
      // String comparison
      const left = String(actual).trim();
      const right = String(target).trim();
      switch (operator) {
        case '==': return left.toLowerCase() === right.toLowerCase();
        case '!=': return left.toLowerCase() !== right.toLowerCase();
        default: return false;
      }
  }

  switch (operator) {
    case '==': return a === t;
    case '!=': return a !== t;
    case '>': return a > t;
    case '<': return a < t;
    case '>=': return a >= t;
    case '<=': return a <= t;
    default: return false;
  }
};

/**
 * Mapa `deviceId` (string) → propiedades ya expandidas (p. ej. `press` / `button_event_status` en gateways).
 */
export function buildDevicePropertiesMapFromLatestRows(rows) {
  const map = {};
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    const did = row?.deviceId != null ? String(row.deviceId) : '';
    if (!did) continue;
    const raw = row.properties && typeof row.properties === 'object' ? row.properties : {};
    map[did] = expandNestedGatewayTelemetry({ ...raw });
  }
  return map;
}

/**
 * Mezcla el payload del SSE de telemetría sobre el mapa de /devices/latest (mismo criterio que el servidor).
 * Así las condiciones siguen cumpliéndose aunque el último GET ya no traiga `press` efímero.
 */
export function mergeSseTelemetryDetailIntoDeviceMap(deviceProperties, detail) {
  if (!deviceProperties || !detail || detail.deviceId == null) return;
  const did = String(detail.deviceId);
  if (!did || !detail.properties || typeof detail.properties !== 'object') return;
  const cur = deviceProperties[did] || {};
  deviceProperties[did] = expandNestedGatewayTelemetry({ ...cur, ...detail.properties });
}

/** Tras ráfaga de SSE, un solo disparo con el último payload (ms). */
const CLIENT_AUTOMATION_DEBOUNCE_MS = 450;
/** Evita procesar dos veces el mismo evento `deviceId`+`timestamp` (p. ej. doble entrega SSE). */
const CLIENT_AUTOMATION_TELEMETRY_DEDUPE_MS = 8000;

let _lastSseTelemetryDedupe = { key: '', at: 0 };
/** Cola: no solapar `getLatest` + reglas entre dos llamadas (evita carrera short/long). */
let _runAutomationsFromLatestChain = Promise.resolve();

/**
 * Evalúa reglas contra el último estado del servidor (GET /api/devices/latest).
 * @param {object | null} [telemetryDetail] Evento SSE `detail` con `deviceId` + `properties` del uplink que disparó la regla.
 */
export async function runAutomationsFromLatest(credentials, token, auth, runOpts = {}, telemetryDetail = null) {
  _runAutomationsFromLatestChain = _runAutomationsFromLatestChain
    .catch(() => {})
    .then(() => runAutomationsFromLatestBody(credentials, token, auth, runOpts, telemetryDetail));
  return _runAutomationsFromLatestChain;
}

async function runAutomationsFromLatestBody(credentials, token, auth, runOpts = {}, telemetryDetail = null) {
  if (
    telemetryDetail != null &&
    telemetryDetail.deviceId != null &&
    telemetryDetail.timestamp != null
  ) {
    const key = `${String(telemetryDetail.deviceId)}:${Number(telemetryDetail.timestamp)}`;
    const now = Date.now();
    if (_lastSseTelemetryDedupe.key === key && now - _lastSseTelemetryDedupe.at < CLIENT_AUTOMATION_TELEMETRY_DEDUPE_MS) {
      return;
    }
    _lastSseTelemetryDedupe = { key, at: now };
  }

  let latest;
  try {
    latest = await getLatestDeviceData();
  } catch {
    return;
  }
  const list = Array.isArray(latest) ? latest : [];
  const deviceProperties = buildDevicePropertiesMapFromLatestRows(list);
  mergeSseTelemetryDetailIntoDeviceMap(deviceProperties, telemetryDetail);
  await runAutomations([], deviceProperties, credentials, token, auth, runOpts);
}

let _clientAuxAutomationsTimer = null;
/** @type {object | null} */
let _pendingTelemetryDetail = null;

/**
 * Tras telemetría (SSE): ejecutar solo acciones webhook/toast en el navegador.
 * Email y downlinks los procesa el servidor (`automation-runner.js`).
 * @param {object | null} telemetryDetail Mismo objeto que el SSE (incl. `properties`); necesario para condiciones efímeras (p. ej. pulsador).
 */
export function scheduleClientEmailWebhookAutomations(ctx, telemetryDetail) {
  if (!ctx?.token || !ctx.isStaff) return;
  if (telemetryDetail && telemetryDetail.deviceId != null) {
    _pendingTelemetryDetail = telemetryDetail;
  }
  if (_clientAuxAutomationsTimer != null) clearTimeout(_clientAuxAutomationsTimer);
  _clientAuxAutomationsTimer = setTimeout(() => {
    _clientAuxAutomationsTimer = null;
    const tel = _pendingTelemetryDetail;
    _pendingTelemetryDetail = null;
    const { credentials, token, auth } = ctx;
    runAutomationsFromLatest(credentials, token, auth, { skipDownlink: true }, tel).catch((e) => {
      console.warn('[Automation] webhook/toast:', e?.message || e);
    });
  }, CLIENT_AUTOMATION_DEBOUNCE_MS);
}
