/**
 * Normaliza y evalúa expresiones aritméticas sencillas para widgets.
 * Placeholder: `Valor` o `(Valor)` (insensible a mayúsculas) → valor de telemetría.
 * También admite fórmulas solo con constantes, p. ej. `(127*10*5)/1000`.
 * Acepta `×` / `÷` y un `=` final opcional.
 */

function normalizeExpression(expression) {
  if (expression == null || typeof expression !== 'string') return '';
  let expr = expression.trim();
  expr = expr.replace(/\s*=\s*$/g, '');
  expr = expr.replace(/\u00d7/g, '*').replace(/×/g, '*').replace(/\u00f7/g, '/').replace(/÷/g, '/');
  expr = expr.replace(/\u2212/g, '-');
  return expr.trim();
}

function substituteValor(expr, rawValue) {
  const literal = String(Number(rawValue));
  let out = expr.replace(/\(\s*[Vv]alor\s*\)/g, literal);
  out = out.replace(/\b[Vv]alor\b/g, literal);
  return out;
}

function hasValorPlaceholder(expr) {
  return /\b[Vv]alor\b|\(\s*[Vv]alor\s*\)/.test(expr);
}

/** Si la expresión no menciona Valor pero empieza como «/10» o «*2», se asume el operando izquierdo es la telemetría. */
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

function isSafeNumericExpression(expr) {
  const compact = expr.replace(/\s/g, '');
  return /^[0-9+\-*/.eE()]+$/.test(compact);
}

/**
 * @param {number | null | undefined} rawValue Valor de entrada cuando la fórmula usa `Valor`; puede ser null si la expresión es solo constantes.
 * @param {string} expression
 * @returns {number | null}
 */
export function applyWidgetFormula(rawValue, expression) {
  let expr0 = normalizeExpression(expression);
  if (!expr0) return null;
  if (!hasValorPlaceholder(expr0)) {
    expr0 = injectImplicitValor(expr0);
  }
  const needsValor = hasValorPlaceholder(expr0);
  if (needsValor) {
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return null;
  }
  const expr = needsValor ? substituteValor(expr0, rawValue) : expr0;
  const spaced = expr.replace(/\s+/g, ' ').trim();
  if (!spaced) return null;
  if (!isSafeNumericExpression(spaced)) return null;
  try {
    const fn = new Function(`"use strict"; return (${spaced});`);
    const out = fn();
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Aplica la fórmula del widget si está activa; si falla o no hay expresión, devuelve `rawNumber`.
 * @param {Record<string, unknown> | null | undefined} cfg
 * @param {number | null | undefined} rawNumber
 * @returns {number | null | undefined}
 */
export function transformWidgetNumeric(cfg, rawNumber) {
  const ex = String(cfg?.data?.formulaExpression ?? '').trim();
  if (!cfg?.data?.formulaEnabled || !ex) return rawNumber;
  const out = applyWidgetFormula(rawNumber, ex);
  if (out != null && Number.isFinite(out)) return out;
  return rawNumber;
}
