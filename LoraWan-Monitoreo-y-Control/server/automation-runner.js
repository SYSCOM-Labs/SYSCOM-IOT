/**
 * Automatizaciones al recibir telemetría (servidor).
 * Evita depender del navegador (SSE, mapa en vivo, rol en React) para encolar downlinks.
 */
'use strict';

const { resolveAutomationDownlinkHex } = require('./automation-downlink-resolve');
const { resolveAutomationConditionCompareValue } = require('./automation-widget-value.cjs');
const {
  effectiveAutomationConditions,
  resolveAutomationRuleMode,
} = require('./lib/automation-rule-mode.cjs');
const {
  resolveAppTimezone,
  getScheduleClockParts,
} = require('./lib/app-timezone.cjs');

/** @type {null | { store: object, tryLnsAppDownlinkEnqueue: Function, appendDownlinkLog: Function, insertUiEventWithStream: Function, buildLnsDownlinkApiSuccessBody: Function, canRunAutomationsForUser: Function }} */
let _ctx = null;

/** @type {Record<string, number>} */
const cooldownStorage = {};

/** `userId::ruleId` → estuvo dentro de la ventana en el tick anterior (reglas solo-horario en ticker). */
const scheduleEdgeState = {};

/** `userId::ruleId` → firma del último uplink que disparó la regla (one-shot por evento, p. ej. botón). */
const oneShotEventStorage = {};

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

/**
 * Identifica un uplink concreto (msgid, last_update, fcnt) para disparar cada pulsación
 * aunque `press` siga en "short" en el mapa de última telemetría.
 */
function buildRuleConditionEventSignature(deviceProperties, effectiveConditions) {
  const parts = [];
  for (const cond of effectiveConditions) {
    const did = cond.deviceId != null ? String(cond.deviceId) : '';
    if (!did) return null;
    const props = deviceProperties[did];
    if (!props) return null;
    const val = getConditionDeviceValue(props, cond.propKey);
    if (val === undefined) return null;
    const be = props.button_event;
    const msgid =
      be && typeof be === 'object' && !Array.isArray(be) && be.msgid != null ? String(be.msgid) : '';
    const eventTick =
      props.last_update != null
        ? String(props.last_update)
        : props.ts != null
          ? String(props.ts)
          : props.receivedAt != null
            ? String(props.receivedAt)
            : '';
    const fcnt =
      props.fcnt_up != null
        ? String(props.fcnt_up)
        : props.fcnt != null
          ? String(props.fcnt)
          : '';
    parts.push(`${did}\x1f${cond.propKey}\x1f${val}\x1f${msgid}\x1f${eventTick}\x1f${fcnt}`);
  }
  return parts.length ? parts.join('\x1e') : null;
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

/** @param {{ allowFull?: boolean, allowEmail?: boolean }} [perm] */
function runAutomationAction(userId, action, rule, perm) {
  try {
    const { automationPerm } = _ctx;
    if (automationPerm && !automationPerm.isAutomationActionPermitted(action, perm)) return;
    if (action.type === 'downlink') {
      executeDownlinkAction(userId, action, rule);
    } else if (action.type === 'email') {
      executeEmailAction(userId, action, rule);
    }
  } catch (e) {
    console.warn('[automation] action:', e && e.message);
  }
}

/** @param {{ allowFull?: boolean, allowEmail?: boolean }} [perm] */
function enqueueAutomationAction(userId, action, rule, perm) {
  const { automationPerm } = _ctx;
  if (automationPerm && !automationPerm.isAutomationActionPermitted(action, perm)) return;
  const delaySeconds = Math.max(0, parseInt(String(action.delay || 0), 10));
  const fire = () => runAutomationAction(userId, action, rule, perm);
  if (delaySeconds > 0) setTimeout(fire, delaySeconds * 1000);
  else fire();
}

function executeEmailAction(userId, action, rule) {
  const { store, smtpMail } = _ctx;
  if (!smtpMail || !store) return;
  const to = String(action.target || '').trim();
  if (!to) {
    console.warn('[automation] Email: falta destinatario en la acción.');
    return;
  }
  const ruleObj =
    rule && typeof rule === 'object'
      ? rule
      : { name: 'Automatización', conditions: [], id: null };
  const { subject, text } = smtpMail.buildAutomationEmailBody(ruleObj, action);
  void smtpMail
    .sendNotificationEmail(store, {
      to,
      subject,
      text,
      meta: { userId, ruleId: ruleObj.id, source: 'automation' },
    })
    .then((r) => {
      if (r && r.queued) {
        console.info('[automation] Email encolado (%s) para %s', r.reason || 'retry', to);
      }
    })
    .catch((e) => {
      console.warn('[automation] Email:', e && e.message);
    });
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

function executeDownlinkAction(userId, action, rule) {
  const { store, tryLnsAppDownlinkEnqueue, appendDownlinkLog, insertUiEventWithStream, buildLnsDownlinkApiSuccessBody } =
    _ctx;
  const targetId = action.targetDeviceId != null ? String(action.targetDeviceId) : '';
  const rawKey = (action.commandKey || '').toString().trim();
  if (!targetId || !rawKey) return;

  const ruleId = rule && rule.id != null ? String(rule.id) : '';
  const ruleName =
    rule && rule.name != null && String(rule.name).trim() ? String(rule.name).trim() : ruleId || 'Regla';

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
      ruleId: ruleId || null,
      ruleName,
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
        ruleId: ruleId || null,
        ruleName,
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
    ruleId: ruleId || null,
    ruleName,
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
      ruleId: ruleId || null,
      ruleName,
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
  const { store, automationPerm } = _ctx;
  const user = store.getUserById(userId);
  if (!user || !automationPerm) return;
  const perm = automationPerm.automationPermitsForUser(user);
  if (!perm.allowFull && !perm.allowEmail) return;

  let rules;
  try {
    rules = store.listAutomationRules(userId);
  } catch {
    return;
  }
  if (!Array.isArray(rules) || rules.length === 0) return;

  const activeRules = rules.filter((r) => r.active !== false);
  const now = new Date();
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

    const effectiveConditions = effectiveAutomationConditions(rule.conditions);
    const ruleMode = resolveAutomationRuleMode(rule);
    const scheduleOnly = ruleMode === 'schedule';

    if (scheduleTickOnly) {
      if (!scheduleOnly) continue;
      const tz = resolveAppTimezone(store, rule);
      const { currentDay, currentTimeStr } = getScheduleClockParts(now, tz);
      const inside =
        dayMatchesRule(rule, currentDay) && isTimeInRange(currentTimeStr, schedStart, schedEnd);
      const rid = rule.id != null ? String(rule.id) : `r${ridx}`;
      const edgeKey = `${userId}::${rid}`;
      const hadPrior = Object.prototype.hasOwnProperty.call(scheduleEdgeState, edgeKey);
      const prev = scheduleEdgeState[edgeKey] === true;
      scheduleEdgeState[edgeKey] = inside;
      if (!hadPrior) {
        continue;
      }
      const entering = inside && !prev;
      const leaving = !inside && prev;
      if (entering || leaving) {
        console.info(
          `[automation] Horario ${entering ? 'INICIO' : 'FIN'} regla="${rule.name || rid}" usuario=${userId} tz=${tz} reloj=${currentTimeStr}`
        );
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
          enqueueAutomationAction(userId, action, rule, perm);
        }
      }
      continue;
    }

    // Telemetría: reglas solo-horario se evalúan en el tick de agenda (sin filtro día/hora aquí).
    if (scheduleOnly) continue;
    if (effectiveConditions.length === 0) continue;

    let allConditionsMet = true;
    for (const cond of effectiveConditions) {
      const did = cond.deviceId != null ? String(cond.deviceId) : '';
      const props = did ? deviceProperties[did] : null;
      const rawDeviceValue = getConditionDeviceValue(props, cond.propKey);
      if (rawDeviceValue === undefined) {
        allConditionsMet = false;
        break;
      }
      const deviceValue = resolveAutomationConditionCompareValue(
        rawDeviceValue,
        cond,
        props,
        store,
        userId
      );
      if (!evaluateCondition(deviceValue, cond.operator, cond.value)) {
        allConditionsMet = false;
        break;
      }
    }

    const rid = rule.id != null ? String(rule.id) : `r${ridx}`;
    const ruleSigKey = `${userId}::${rid}`;
    const eventSig = buildRuleConditionEventSignature(deviceProperties, effectiveConditions);

    if (!allConditionsMet) {
      if (!rule.allowReactivation) {
        delete oneShotEventStorage[ruleSigKey];
        for (let i = 0; i < (rule.actions || []).length; i++) {
          cooldownStorage[cooldownKey(userId, rule.id, i)] = 0;
        }
      }
      continue;
    }

    if (!rule.allowReactivation && eventSig && oneShotEventStorage[ruleSigKey] === eventSig) {
      continue;
    }

    let fired = false;
    for (let i = 0; i < (rule.actions || []).length; i++) {
      const action = rule.actions[i];
      const ck = cooldownKey(userId, rule.id, i);
      const lastExec = cooldownStorage[ck] || 0;

      if (rule.allowReactivation) {
        const reactivationLimit = Math.max(60, parseInt(String(rule.reactivation || 60), 10) || 60) * 1000;
        if (Date.now() - lastExec < reactivationLimit) continue;
      }

      enqueueAutomationAction(userId, action, rule, perm);
      cooldownStorage[ck] = Date.now();
      fired = true;
    }

    if (fired && !rule.allowReactivation && eventSig) {
      oneShotEventStorage[ruleSigKey] = eventSig;
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
    const { store, automationPerm } = _ctx;
    let users;
    try {
      users = store.allUsersSanitized();
    } catch (e) {
      console.warn('[automation] schedule tick users:', e && e.message);
      return;
    }
    for (const u of users) {
      if (!u || !automationPerm) continue;
      const perm = automationPerm.automationPermitsForUser(u);
      if (!perm.allowFull && !perm.allowEmail) continue;
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
  __test: {
    clockToMinutes,
    isTimeInRange,
    getConditionDeviceValue,
    expandNestedGatewayTelemetry,
    buildRuleConditionEventSignature,
    evaluateCondition,
  },
};
