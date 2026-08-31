'use strict';

const TIME_OPERATOR_GT = 'time_gt';
const TIME_OPERATOR_LT = 'time_lt';

function isTimeOperator(operator) {
  const s = String(operator || '').trim();
  return s === TIME_OPERATOR_GT || s === TIME_OPERATOR_LT;
}

function automationOperatorLabel(operator) {
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

function parseDurationToMs(raw, opts = {}) {
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

function actualValueToDurationMs(actual, nowMs = Date.now()) {
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

function evaluateTimeCondition(actual, operator, target, nowMs = Date.now()) {
  const tMs = parseDurationToMs(target, { userInput: true });
  const aMs = actualValueToDurationMs(actual, nowMs);
  if (tMs == null || aMs == null) return false;
  const op = String(operator || '').trim();
  if (op === TIME_OPERATOR_GT) return aMs > tMs;
  if (op === TIME_OPERATOR_LT) return aMs < tMs;
  return false;
}

function parseHoldDurationMs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const ms = parseDurationToMs(s, { userInput: true });
  return ms != null && ms > 0 ? ms : 0;
}

function conditionHoldMs(cond) {
  if (!cond || typeof cond !== 'object') return 0;
  return parseHoldDurationMs(cond.holdTime ?? cond.time);
}

function applyConditionHold(store, key, comparisonTrue, holdMs, nowMs = Date.now()) {
  if (!store || typeof store !== 'object') {
    return { met: Boolean(comparisonTrue) && !(Number(holdMs) > 0), remainingMs: 0 };
  }
  if (!comparisonTrue) {
    delete store[key];
    return { met: false, remainingMs: 0 };
  }
  const wait = Number(holdMs) > 0 ? Number(holdMs) : 0;
  if (!wait) {
    delete store[key];
    return { met: true, remainingMs: 0 };
  }
  if (store[key] == null) store[key] = nowMs;
  const remaining = wait - (nowMs - store[key]);
  if (remaining <= 0) return { met: true, remainingMs: 0 };
  return { met: false, remainingMs: remaining };
}

module.exports = {
  TIME_OPERATOR_GT,
  TIME_OPERATOR_LT,
  isTimeOperator,
  automationOperatorLabel,
  parseDurationToMs,
  actualValueToDurationMs,
  evaluateTimeCondition,
  parseHoldDurationMs,
  conditionHoldMs,
  applyConditionHold,
};
