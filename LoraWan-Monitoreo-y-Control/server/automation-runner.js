/**
 * Automatizaciones al recibir telemetría (servidor).
 * Evita depender del navegador (SSE, mapa en vivo, rol en React) para encolar downlinks.
 */
'use strict';

const { resolveAutomationDownlinkHex } = require('./automation-downlink-resolve');

/** @type {null | { store: object, tryLnsAppDownlinkEnqueue: Function, appendDownlinkLog: Function, insertUiEventWithStream: Function, buildLnsDownlinkApiSuccessBody: Function, isStaffRole: Function }} */
let _ctx = null;

/** @type {Record<string, number>} */
const cooldownStorage = {};

/** `userId::ruleId` → estuvo dentro de la ventana en el tick anterior (reglas solo-horario en ticker). */
const scheduleEdgeState = {};

/** @type {ReturnType<typeof setTimeout> | null} */
let _scheduleFirstTimeout = null;
/** @type {ReturnType<typeof setInterval> | null} */
let _scheduleInterval = null;

function configure(ctx) {
  _ctx = ctx;
}

/**
 * Misma idea que `src/utils/gatewayPayload.js` (sin importar ESM desde aquí).
 */
function expandNestedGatewayTelemetry(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src;
  const out = { ...src };
  const be = out.button_event;
  if (be && typeof be === 'object' && !Array.isArray(be) && be.status != null) {
    out.button_event_status = be.status;
  } else if (out.press != null && out.button_event_status == null) {
    const p = String(out.press).toLowerCase();
    const m = { short: 'short press', long: 'long press', double: 'double press' };
    out.button_event_status = m[p] || String(out.press);
  }
  if (out.button_event_status != null) {
    const s = String(out.button_event_status).toLowerCase().replace(/\s+/g, ' ').trim();
    if (s.includes('short')) out.press = 'short';
    else if (s.includes('long')) out.press = 'long';
    else if (s.includes('double')) out.press = 'double';
  }
  return out;
}

/** Convierte "HH:mm" o "HH:mm:ss" a minutos desde medianoche (fracción por segundos). */
function clockToMinutes(clock) {
  const parts = String(clock || '')
    .trim()
    .split(':');
  const h = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
  const m = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
  const sec = parts.length > 2 ? Math.min(59, Math.max(0, parseInt(parts[2], 10) || 0)) : 0;
  return h * 60 + m + sec / 60;
}

function isTimeInRange(current, start, end) {
  const cur = clockToMinutes(current);
  const st = clockToMinutes(start || '00:00');
  const en = clockToMinutes(end || '23:59');
  if (st <= en) return cur >= st && cur <= en;
  return cur >= st || cur <= en;
}

function evaluateCondition(actual, operator, target) {
  const a = parseFloat(actual);
  const t = parseFloat(target);
  if (Number.isNaN(a) || Number.isNaN(t)) {
    const left = String(actual).trim();
    const right = String(target).trim();
    switch (operator) {
      case '==':
        return left.toLowerCase() === right.toLowerCase();
      case '!=':
        return left.toLowerCase() !== right.toLowerCase();
      default:
        return false;
    }
  }
  switch (operator) {
    case '==':
      return a === t;
    case '!=':
      return a !== t;
    case '>':
      return a > t;
    case '<':
      return a < t;
    case '>=':
      return a >= t;
    case '<=':
      return a <= t;
    default:
      return false;
  }
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

function rawButtonEventStatusFromProps(props) {
  if (!props) return undefined;
  if (props.button_event_status != null) return props.button_event_status;
  const be = props.button_event;
  if (be && typeof be === 'object' && !Array.isArray(be) && be.status != null) return be.status;
  return undefined;
}

/**
 * Valor para condición: `press`, `button_event_status` y `button_event` se normalizan a short|long|double
 * para que coincida con lo que el usuario escribe en la regla (p. ej. "long" frente a "long press").
 */
function getConditionDeviceValue(props, propKey) {
  if (!props || propKey == null || propKey === '') return undefined;
  const k = String(propKey);
  const rawSt = rawButtonEventStatusFromProps(props);

  if (k === 'press') {
    if (rawSt != null) return tokenFromButtonStatusRaw(rawSt);
    if (Object.prototype.hasOwnProperty.call(props, 'press') && props.press !== undefined) {
      return props.press;
    }
    return undefined;
  }
  if (k === 'button_event_status') {
    if (rawSt != null) return tokenFromButtonStatusRaw(rawSt);
    return undefined;
  }
  if (k === 'button_event') {
    if (rawSt != null) return tokenFromButtonStatusRaw(rawSt);
    return props.button_event;
  }
  if (Object.prototype.hasOwnProperty.call(props, k) && props[k] !== undefined) {
    return props[k];
  }
  return undefined;
}

function dayMatchesRule(rule, currentDay) {
  const days = rule.activeDays;
  if (!days || !Array.isArray(days) || days.length === 0) return true;
  return days.some((d) => Number(d) === currentDay);
}

function buildDevicePropertiesMapForUser(store, userId, overlayDeviceId, overlayProps) {
  const latestMap = store.getLatestMap(userId);
  /** @type {Record<string, object>} */
  const deviceProperties = {};
  for (const id of Object.keys(latestMap)) {
    const row = latestMap[id];
    const raw = row && row.properties && typeof row.properties === 'object' ? row.properties : {};
    deviceProperties[String(id)] = expandNestedGatewayTelemetry({ ...raw });
  }
  const did = String(overlayDeviceId || '');
  if (did) {
    const cur = deviceProperties[did] || {};
    const over = overlayProps && typeof overlayProps === 'object' ? overlayProps : {};
    deviceProperties[did] = expandNestedGatewayTelemetry({ ...cur, ...over });
  }
  return deviceProperties;
}

function cooldownKey(userId, ruleId, actionIndex) {
  return `${userId}::${ruleId != null ? String(ruleId) : ''}::${actionIndex}`;
}

/** @param {object} action */
function scheduleRunPhase(action) {
  const v =
    action && action.scheduleRunAt != null ? String(action.scheduleRunAt).trim().toLowerCase() : '';
  if (v === 'end' || v === 'window_end') return 'end';
  return 'start';
}

function runAutomationAction(userId, action) {
  try {
    if (action.type === 'downlink') {
      executeDownlinkAction(userId, action);
    }
  } catch (e) {
    console.warn('[automation] action:', e && e.message);
  }
}

function enqueueAutomationAction(userId, action) {
  const delaySeconds = Math.max(0, parseInt(String(action.delay || 0), 10));
  const fire = () => runAutomationAction(userId, action);
  if (delaySeconds > 0) setTimeout(fire, delaySeconds * 1000);
  else fire();
}

/**
 * Downlinks disparados por reglas: sin esperar GW_TX_ACK (evita ~5 s de bloqueo) y con prioridad alta en la cola PULL_RESP.
 * SYSCOM_LNS_AUTOMATION_SKIP_TX_ACK=0 → mismo criterio que la UI (riesgo de colisión si el GW rechaza el txpk).
 * SYSCOM_LNS_AUTOMATION_DL_PRIORITY=0–255 (defecto 200).
 * SYSCOM_LNS_AUTOMATION_CLASS_C_DELAY_MS: retardo extra (ms) al programar clase C (defecto 200); suma al floor de `not_before`.
 */
function automationLnsEnqueueExtras() {
  const skip =
    String(process.env.SYSCOM_LNS_AUTOMATION_SKIP_TX_ACK || '1').trim() !== '0';
  const raw = process.env.SYSCOM_LNS_AUTOMATION_DL_PRIORITY;
  const pr = raw != null && String(raw).trim() !== '' ? parseInt(String(raw).trim(), 10) : 200;
  const priority = Number.isFinite(pr) ? Math.max(0, Math.min(255, pr)) : 200;
  const rawD = process.env.SYSCOM_LNS_AUTOMATION_CLASS_C_DELAY_MS;
  const delayMs =
    rawD != null && String(rawD).trim() !== ''
      ? Math.max(0, parseInt(String(rawD).trim(), 10) || 0)
      : 200;
  /** Misma política que la UI: encolar tras uplink si la ventana clase A está cerrada (anula SYSCOM_LNS_DEFER_APP_DOWNLINK=0). */
  return { skipTxAckTrack: skip, priority, delayMs, deferUntilUplink: true };
}

function executeDownlinkAction(userId, action) {
  const { store, tryLnsAppDownlinkEnqueue, appendDownlinkLog, insertUiEventWithStream, buildLnsDownlinkApiSuccessBody } =
    _ctx;
  const targetId = action.targetDeviceId != null ? String(action.targetDeviceId) : '';
  const rawKey = (action.commandKey || '').toString().trim();
  if (!targetId || !rawKey) return;

  const cleanHex = resolveAutomationDownlinkHex(action);
  if (!cleanHex) {
    console.warn(
      '[automation] downlink omitido: no es hex ni servicio admitido. commandKey=%s target=%s device=%s',
      rawKey,
      action.target != null ? String(action.target) : '',
      targetId
    );
    return;
  }

  const ud = store.getUserDevice(userId, targetId);
  if (!ud) return;

  const r = tryLnsAppDownlinkEnqueue(
    userId,
    targetId,
    ud,
    { payloadHex: cleanHex, confirmed: false },
    automationLnsEnqueueExtras()
  );
  if (!r.ok) return;

  if (r.deferred) {
    appendDownlinkLog(userId, {
      deviceId: targetId,
      devEUI: r.deui,
      fPort: r.fPort,
      payloadHex: r.hex,
      lns: true,
      source: 'automation',
      deferred: true,
      pendingId: r.pendingId,
      pendingQueueLength: r.pendingQueueLength,
      deferredReason: r.deferredReason,
    });
    insertUiEventWithStream(
      userId,
      r.deui,
      'downlink_deferred',
      JSON.stringify({
        deviceId: targetId,
        devEUI: r.deui,
        fPort: r.fPort,
        payloadHex: r.hex,
        pendingId: r.pendingId,
        pendingQueueLength: r.pendingQueueLength,
        deferredReason: r.deferredReason,
        source: 'automation',
      })
    );
    return;
  }

  appendDownlinkLog(userId, {
    deviceId: targetId,
    devEUI: r.deui,
    fPort: r.fPort,
    payloadHex: r.hex,
    lns: true,
    source: 'automation',
    ...r.out,
  });
  const apiBody = buildLnsDownlinkApiSuccessBody(r.out);
  insertUiEventWithStream(
    userId,
    r.deui,
    'downlink_sent',
    JSON.stringify({
      deviceId: targetId,
      devEUI: r.deui,
      fPort: r.fPort,
      fCnt: r.out.fCnt,
      payloadHex: r.hex,
      confirmed: r.confirmedDl,
      deviceClass: r.out.deviceClass,
      imme: r.out.imme,
      classARxWindow: r.out.classARxWindow,
      gatewayEui: r.out.gatewayEui,
      txAckPending: apiBody.txAckPending,
      txAckMaxWaitMs: apiBody.txAckMaxWaitMs,
      source: 'automation',
    })
  );
}

/**
 * @param {string} userId
 * @param {Record<string, object>} deviceProperties
 * @param {{ scheduleTickOnly?: boolean }} [opts]
 *   Si `scheduleTickOnly`, solo se evalúan reglas sin condiciones IF reales (horario + THEN).
 *   Esas reglas disparan por borde de ventana: acciones con `scheduleRunAt` ausente o `start` al entrar,
 *   y `scheduleRunAt: 'end'` al salir. Evita repetir downlinks cada tick y permite OFF al cerrar horario.
 */
function runRulesForUser(userId, deviceProperties, opts = {}) {
  const scheduleTickOnly = opts.scheduleTickOnly === true;
  const { store, isStaffRole } = _ctx;
  const user = store.getUserById(userId);
  if (!user || !isStaffRole(user.role)) return;

  let rules;
  try {
    rules = store.listAutomationRules(userId);
  } catch {
    return;
  }
  if (!Array.isArray(rules) || rules.length === 0) return;

  const activeRules = rules.filter((r) => r.active !== false);
  const now = new Date();
  const currentDay = now.getDay();
  const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  /** Evita dos reglas solo-horario al mismo dispositivo en el mismo tick (p. ej. ON y OFF a la vez). */
  const scheduleOnlyDownlinkTargets = new Set();

  for (let ridx = 0; ridx < activeRules.length; ridx++) {
    const rule = activeRules[ridx];
    const schedStart =
      rule.scheduleStart != null && String(rule.scheduleStart).trim()
        ? String(rule.scheduleStart).trim()
        : '00:00';
    const schedEnd =
      rule.scheduleEnd != null && String(rule.scheduleEnd).trim() ? String(rule.scheduleEnd).trim() : '23:59';

    const effectiveConditions = (rule.conditions || []).filter(
      (c) =>
        c &&
        c.deviceId != null &&
        String(c.deviceId).trim() &&
        c.propKey != null &&
        String(c.propKey).trim()
    );
    const scheduleOnly = effectiveConditions.length === 0;

    if (scheduleTickOnly) {
      if (!scheduleOnly) continue;
      const inside =
        dayMatchesRule(rule, currentDay) && isTimeInRange(currentTimeStr, schedStart, schedEnd);
      const rid = rule.id != null ? String(rule.id) : `r${ridx}`;
      const edgeKey = `${userId}::${rid}`;
      const prev = scheduleEdgeState[edgeKey] === true;
      scheduleEdgeState[edgeKey] = inside;
      const entering = inside && !prev;
      const leaving = !inside && prev;
      if (entering || leaving) {
        for (let i = 0; i < (rule.actions || []).length; i++) {
          const action = rule.actions[i];
          const phase = scheduleRunPhase(action);
          if (entering && phase !== 'start') continue;
          if (leaving && phase !== 'end') continue;
          if (action.type === 'downlink') {
            const tid = action.targetDeviceId != null ? String(action.targetDeviceId).trim() : '';
            if (tid && scheduleOnlyDownlinkTargets.has(tid)) continue;
            if (tid) scheduleOnlyDownlinkTargets.add(tid);
          }
          enqueueAutomationAction(userId, action);
        }
      }
      continue;
    }

    // Telemetría: no evaluar reglas solo-ventana (solo tick de agenda).
    if (scheduleOnly) continue;

    if (!dayMatchesRule(rule, currentDay)) continue;
    if (!isTimeInRange(currentTimeStr, schedStart, schedEnd)) continue;

    let allConditionsMet = true;
    for (const cond of effectiveConditions) {
      const did = cond.deviceId != null ? String(cond.deviceId) : '';
      const props = did ? deviceProperties[did] : null;
      const deviceValue = getConditionDeviceValue(props, cond.propKey);
      if (deviceValue === undefined) {
        allConditionsMet = false;
        break;
      }
      if (!evaluateCondition(deviceValue, cond.operator, cond.value)) {
        allConditionsMet = false;
        break;
      }
    }

    if (!allConditionsMet) {
      if (!rule.allowReactivation) {
        for (let i = 0; i < (rule.actions || []).length; i++) {
          cooldownStorage[cooldownKey(userId, rule.id, i)] = 0;
        }
      }
      continue;
    }

    for (let i = 0; i < (rule.actions || []).length; i++) {
      const action = rule.actions[i];
      const ck = cooldownKey(userId, rule.id, i);
      const lastExec = cooldownStorage[ck] || 0;

      if (rule.allowReactivation) {
        const reactivationLimit = Math.max(60, parseInt(String(rule.reactivation || 60), 10) || 60) * 1000;
        if (Date.now() - lastExec < reactivationLimit) continue;
      } else if (lastExec > 0) {
        continue;
      }

      enqueueAutomationAction(userId, action);
      cooldownStorage[ck] = Date.now();
    }
  }
}

/**
 * Ticker servidor: enciende/apaga por ventana horaria sin esperar uplink.
 * `SYSCOM_SERVER_AUTOMATION_SCHEDULE=0` lo desactiva.
 * `SYSCOM_SERVER_AUTOMATION_SCHEDULE_TICK_MS` intervalo en ms (mín. 5000, defecto 30000).
 * `SYSCOM_SERVER_AUTOMATION_SCHEDULE_ALIGN_MINUTE=1` alinea el primer tick al siguiente minuto entero (útil con intervalo 60000).
 */
function startAutomationScheduleTicker() {
  if (String(process.env.SYSCOM_SERVER_AUTOMATION_SCHEDULE || '1').trim() === '0') return;
  if (_scheduleFirstTimeout || _scheduleInterval) return;

  const rawMs = process.env.SYSCOM_SERVER_AUTOMATION_SCHEDULE_TICK_MS;
  const tickMs = Math.max(
    5000,
    parseInt(String(rawMs != null && String(rawMs).trim() !== '' ? rawMs : '30000').trim(), 10) || 30000
  );
  const align =
    String(process.env.SYSCOM_SERVER_AUTOMATION_SCHEDULE_ALIGN_MINUTE || '').trim() === '1' &&
    tickMs === 60000;

  const tick = () => {
    if (String(process.env.SYSCOM_SERVER_AUTOMATIONS || '1').trim() === '0') return;
    if (!_ctx) return;
    const { store, isStaffRole } = _ctx;
    let users;
    try {
      users = store.allUsersSanitized();
    } catch (e) {
      console.warn('[automation] schedule tick users:', e && e.message);
      return;
    }
    for (const u of users) {
      if (!u || !isStaffRole(u.role)) continue;
      const uid = String(u.id);
      try {
        const map = buildDevicePropertiesMapForUser(store, uid, '', {});
        runRulesForUser(uid, map, { scheduleTickOnly: true });
      } catch (e) {
        console.warn('[automation] schedule tick user', uid, e && e.message);
      }
    }
  };

  if (align) {
    const ms = 60000 - (Date.now() % 60000);
    _scheduleFirstTimeout = setTimeout(() => {
      _scheduleFirstTimeout = null;
      tick();
      _scheduleInterval = setInterval(tick, tickMs);
    }, ms);
  } else {
    tick();
    _scheduleInterval = setInterval(tick, tickMs);
  }
}

function onTelemetry(payload) {
  if (String(process.env.SYSCOM_SERVER_AUTOMATIONS || '1').trim() === '0') return;
  if (!_ctx || !payload) return;
  const { userIds, deviceId, properties } = payload;
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  for (const uid of userIds) {
    const userId = String(uid);
    try {
      const map = buildDevicePropertiesMapForUser(_ctx.store, userId, deviceId, properties);
      runRulesForUser(userId, map);
    } catch (e) {
      console.warn('[automation] user', userId, e && e.message);
    }
  }
}

module.exports = {
  configure,
  onTelemetry,
  startAutomationScheduleTicker,
};
