/**
 * Duración en condiciones de automatización.
 * Valor de usuario: `60s`, `5m`, `0.30` (0 min 30 s) o un número en segundos.
 */

export const TIME_OPERATOR_GT = 'time_gt';
export const TIME_OPERATOR_LT = 'time_lt';

export function isTimeOperator(operator) {
  const s = String(operator || '').trim();
  return s === TIME_OPERATOR_GT || s === TIME_OPERATOR_LT;
}

export function automationOperatorLabel(operator) {
  const s = String(operator || '').trim();
  const map = {
    '<': 'menor a',
    '<=': 'menor o igual a',
    '==': 'igual a',
    '!=': 'distinto a',
    '>=': 'mayor o igual a',
    '>': 'mayor a',
    [TIME_OPERATOR_GT]: 'tiempo mayor a',
    [TIME_OPERATOR_LT]: 'tiempo menor a',
  };
  return map[s] || s;
}

/**
 * @param {unknown} raw
 * @param {{ userInput?: boolean }} [opts] `userInput`: interpreta `0.30` como 30 segundos (minutos.segundos).
 * @returns {number | null} milisegundos
 */
export function parseDurationToMs(raw, opts = {}) {
  const userInput = opts.userInput === true;
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(',', '.');
  if (!s) return null;

  let m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seg|segs|segundo|segundos)$/);
  if (m) {
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
  }

  m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minuto|minutos)$/);
  if (m) {
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n >= 0 ? n * 60000 : null;
  }

  m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) {
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) return null;
    return (minutes * 60 + seconds) * 1000;
  }

  if (userInput) {
    m = s.match(/^(\d+)\.(\d{1,2})$/);
    if (m) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      if (Number.isFinite(minutes) && Number.isFinite(seconds) && seconds <= 59) {
        return (minutes * 60 + seconds) * 1000;
      }
    }
  }

  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1000;
}

/** Lectura del dispositivo: número = segundos; epoch ms = antigüedad de la marca. */
export function actualValueToDurationMs(actual, nowMs = Date.now()) {
  if (actual == null || actual === '') return null;
  if (typeof actual === 'number' && Number.isFinite(actual)) {
    if (actual > 1e11) {
      const elapsed = Number(nowMs) - actual;
      return elapsed >= 0 ? elapsed : 0;
    }
    if (actual > 0 && actual < 1e11 && actual > 1e9) {
      const elapsed = Number(nowMs) - actual * 1000;
      return elapsed >= 0 ? elapsed : 0;
    }
    return actual * 1000;
  }
  const s = String(actual).trim();
  if (/[a-z]/i.test(s) || /:\d/.test(s)) {
    return parseDurationToMs(s, { userInput: false });
  }
  const n = parseFloat(s.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1e11) {
    const elapsed = Number(nowMs) - n;
    return elapsed >= 0 ? elapsed : 0;
  }
  return n * 1000;
}

export function evaluateTimeCondition(actual, operator, target, nowMs = Date.now()) {
  const tMs = parseDurationToMs(target, { userInput: true });
  const aMs = actualValueToDurationMs(actual, nowMs);
  if (tMs == null || aMs == null) return false;
  const op = String(operator || '').trim();
  if (op === TIME_OPERATOR_GT) return aMs > tMs;
  if (op === TIME_OPERATOR_LT) return aMs < tMs;
  return false;
}

export const HOLD_OP_GT = 'gt';
export const HOLD_OP_LT = 'lt';

export function normalizeHoldOp(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'lt' || s === TIME_OPERATOR_LT || s === 'time_lt') return HOLD_OP_LT;
  if (s === 'gt' || s === TIME_OPERATOR_GT || s === 'time_gt') return HOLD_OP_GT;
  return '';
}

export function holdOpLabel(holdOp) {
  const op = normalizeHoldOp(holdOp);
  if (op === HOLD_OP_LT) return 'tiempo menor a';
  if (op === HOLD_OP_GT) return 'tiempo mayor a';
  return '';
}

/** Vacío = sin espera. `60`, `60s`, `5m`, `10m`, `0.30`. */
export function parseHoldDurationMs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const ms = parseDurationToMs(s, { userInput: true });
  return ms != null && ms > 0 ? ms : 0;
}

export function conditionHoldMs(cond) {
  if (!cond || typeof cond !== 'object') return 0;
  return parseHoldDurationMs(cond.holdTime ?? cond.time);
}

export function conditionHoldOp(cond) {
  if (!cond || typeof cond !== 'object') return '';
  const ms = conditionHoldMs(cond);
  const op = normalizeHoldOp(cond.holdOp ?? cond.holdOperator);
  if (op) return ms > 0 ? op : '';
  return ms > 0 ? HOLD_OP_GT : '';
}

export function formatHoldConditionLabel(cond) {
  const op = conditionHoldOp(cond);
  const raw = String(cond?.holdTime ?? cond?.time ?? '').trim();
  if (!op || !raw) return '';
  return `${holdOpLabel(op)} ${raw}`;
}

function readHoldState(store, key) {
  const v = store[key];
  if (v && typeof v === 'object' && v.since != null) return v;
  if (typeof v === 'number') return { since: v, expired: false };
  return null;
}

/**
 * Permanencia sobre la comparación (p. ej. PIR ocupado).
 * - gt: debe seguir verdadera más de `holdMs` y entonces se cumple.
 * - lt: se cumple al dejar de ser verdadera si duró menos de `holdMs`.
 * @param {Record<string, object | number>} store
 * @returns {{ met: boolean, remainingMs: number, waiting: boolean }}
 */
export function applyConditionHold(store, key, comparisonTrue, holdMs, nowMs = Date.now(), holdOp = HOLD_OP_GT) {
  const wait = Number(holdMs) > 0 ? Number(holdMs) : 0;
  const op = normalizeHoldOp(holdOp) || (wait ? HOLD_OP_GT : '');
  if (!store || typeof store !== 'object') {
    return { met: Boolean(comparisonTrue) && !wait, remainingMs: 0, waiting: false };
  }
  if (!wait || !op) {
    delete store[key];
    return { met: Boolean(comparisonTrue), remainingMs: 0, waiting: false };
  }

  if (op === HOLD_OP_GT) {
    if (!comparisonTrue) {
      delete store[key];
      return { met: false, remainingMs: 0, waiting: false };
    }
    let st = readHoldState(store, key);
    if (!st) {
      st = { since: nowMs, expired: false };
      store[key] = st;
    }
    const remaining = wait - (nowMs - st.since);
    if (remaining <= 0) return { met: true, remainingMs: 0, waiting: false };
    return { met: false, remainingMs: remaining, waiting: true };
  }

  let st = readHoldState(store, key);
  if (comparisonTrue) {
    if (!st) {
      st = { since: nowMs, expired: false };
      store[key] = st;
    }
    if (nowMs - st.since >= wait) st.expired = true;
    const remaining = st.expired ? 0 : Math.max(0, wait - (nowMs - st.since));
    return { met: false, remainingMs: remaining, waiting: true };
  }
  if (st && !st.expired && st.since != null && nowMs - st.since < wait) {
    delete store[key];
    return { met: true, remainingMs: 0, waiting: false };
  }
  delete store[key];
  return { met: false, remainingMs: 0, waiting: false };
}
