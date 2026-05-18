'use strict';

/**
 * Misma lógica que `src/utils/automationWidgetValue.js` para el motor de automatización en servidor.
 */

function normalizeExpression(expression) {
  if (expression == null || typeof expression !== 'string') return '';
  let expr = expression.trim();
  expr = expr.replace(/\s*=\s*$/g, '');
  expr = expr.replace(/\u00d7/g, '*').replace(/×/g, '*').replace(/\u00f7/g, '/').replace(/÷/g, '/');
  expr = expr.replace(/\u2212/g, '-');
  return expr.trim();
}

function hasValorPlaceholder(expr) {
  return /\b[Vv]alor\b|\(\s*[Vv]alor\s*\)/.test(expr);
}

function injectImplicitValor(expr0) {
  const e = expr0.trim();
  if (!e) return e;
  if (hasValorPlaceholder(e)) return e;
  if (/^[*/+]/.test(e)) return `(Valor)${e}`;
  if (/^-/.test(e)) {
    const rest = e.slice(1).trimStart();
    if (rest && /^[\d.(]/.test(rest)) return e;
    return `(Valor)${e}`;
  }
  return e;
}

function applyWidgetFormula(rawValue, expression) {
  let expr0 = normalizeExpression(expression);
  if (!expr0) return null;
  if (!hasValorPlaceholder(expr0)) expr0 = injectImplicitValor(expr0);
  const needsValor = hasValorPlaceholder(expr0);
  if (needsValor) {
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return null;
  }
  let expr = expr0;
  if (needsValor) {
    const literal = String(Number(rawValue));
    expr = expr.replace(/\(\s*[Vv]alor\s*\)/g, literal).replace(/\b[Vv]alor\b/g, literal);
  }
  const spaced = expr.replace(/\s+/g, ' ').trim();
  if (!spaced || !/^[0-9+\-*/.eE()]+$/.test(spaced.replace(/\s/g, ''))) return null;
  try {
    const fn = new Function(`"use strict"; return (${spaced});`);
    const out = fn();
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

function transformWidgetNumeric(cfg, rawNumber) {
  const ex = String(cfg?.data?.formulaExpression ?? '').trim();
  if (!cfg?.data?.formulaEnabled || !ex) return rawNumber;
  const out = applyWidgetFormula(rawNumber, ex);
  if (out != null && Number.isFinite(out)) return out;
  return rawNumber;
}

function invertDisplayedValueOnScale(n, scaleLo, scaleHi) {
  if (!Number.isFinite(n)) return n;
  const lo = Number.isFinite(scaleLo) ? scaleLo : 0;
  const hi = Number.isFinite(scaleHi) && scaleHi > lo ? scaleHi : lo + 100;
  return lo + hi - n;
}

function parseTelemetryScalar(val) {
  if (val == null) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  const s = String(val).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return null;
}

function fieldKeyMatchesWidget(cfg, propKey) {
  const pk = String(propKey || '').trim();
  if (!pk) return false;
  const fk = String(cfg?.data?.fieldKey ?? '').trim();
  const fsk = String(cfg?.data?.formulaSourceKey ?? '').trim();
  return fk === pk || fsk === pk;
}

function findWidgetConfigForDeviceField(allConfigs, deviceId, propKey) {
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

function resolveTelemetryDisplaySource(props, fkStr) {
  if (!props || typeof props !== 'object' || !fkStr) return undefined;
  const k = String(fkStr).trim();
  if (!k) return undefined;
  if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
  return undefined;
}

function applyWidgetTransformsToConditionValue(props, propKey, cfg, rawValue) {
  const readFk = telemetryFieldKeyForWidget(cfg, propKey);
  const rawScalar =
    props && typeof props === 'object' && readFk
      ? resolveTelemetryDisplaySource(props, readFk)
      : rawValue;

  const nParsed = parseTelemetryScalar(rawScalar ?? rawValue);
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

  if (rawValue !== undefined && rawValue !== null) return rawValue;
  return rawScalar;
}

/**
 * @param {object} store
 * @param {string} userId
 * @param {string} deviceId
 */
function getMergedValueWidgetsForAutomation(store, userId, deviceId) {
  const map = {};
  const { prefs } = store.getDeviceBsdPreferencesWithPeerFallback(userId, deviceId);
  const vw = prefs?.valueWidgets;
  if (vw && typeof vw === 'object') Object.assign(map, vw);
  try {
    const rows = store.db
      .prepare('SELECT prefs_json FROM user_panel_bsd_preferences WHERE user_id = ?')
      .all(String(userId));
    for (const row of rows || []) {
      let p = {};
      try {
        p = JSON.parse(row.prefs_json || '{}');
      } catch {
        p = {};
      }
      const pw = p?.valueWidgets;
      if (pw && typeof pw === 'object') Object.assign(map, pw);
    }
  } catch {
    /* ignore */
  }
  return map;
}

/**
 * @param {unknown} rawValue
 * @param {object} cond
 * @param {object} props
 * @param {object} store
 * @param {string} userId
 */
function resolveAutomationConditionCompareValue(rawValue, cond, props, store, userId) {
  if (!cond?.useWidgetValue) return rawValue;
  const did = cond.deviceId != null ? String(cond.deviceId).trim() : '';
  const pk = cond.propKey != null ? String(cond.propKey).trim() : '';
  const allConfigs = getMergedValueWidgetsForAutomation(store, userId, did);
  const cfg = findWidgetConfigForDeviceField(allConfigs, did, pk);
  if (!cfg) return rawValue;
  return applyWidgetTransformsToConditionValue(props, pk, cfg, rawValue);
}

module.exports = {
  resolveAutomationConditionCompareValue,
  getMergedValueWidgetsForAutomation,
};
