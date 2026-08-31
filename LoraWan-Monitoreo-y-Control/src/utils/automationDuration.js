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
