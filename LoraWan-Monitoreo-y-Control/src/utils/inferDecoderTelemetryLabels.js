/**
 * A partir del texto del decoder, detecta claves típicas (p. ej. gpio_input_1) y genera
 * textos legibles en inglés para la UI: "Input 1 On" / "Input 1 Off", etc.
 * Se invoca al pulsar «Ajustar» en Plantillas tras `adaptDecoderScriptForSyscom` (mismo criterio de VM/bytes/throws).
 */

/**
 * @param {string} script
 * @returns {{ labelsByField: Record<string, { trueText: string, falseText: string }>, messages: string[] }}
 */
export function inferTelemetryLabelsFromDecoderScript(script) {
  const messages = [];
  const s = String(script || '');
  const labelsByField = {};

  const inputNums = new Set();
  for (const m of s.matchAll(/\bgpio_input_(\d+)\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) inputNums.add(n);
  }
  const outputNums = new Set();
  for (const m of s.matchAll(/\bgpio_output_(\d+)\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) outputNums.add(n);
  }

  const digitalInNums = new Set();
  for (const m of s.matchAll(/\bdigital_input_(\d+)\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) digitalInNums.add(n);
  }
  const digitalOutNums = new Set();
  for (const m of s.matchAll(/\bdigital_output_(\d+)\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) digitalOutNums.add(n);
  }

  for (const n of [...inputNums].sort((a, b) => a - b)) {
    const key = `gpio_input_${n}`;
    labelsByField[key] = {
      trueText: `Input ${n} On`,
      falseText: `Input ${n} Off`,
    };
  }
  for (const n of [...outputNums].sort((a, b) => a - b)) {
    const key = `gpio_output_${n}`;
    labelsByField[key] = {
      trueText: `Output ${n} On`,
      falseText: `Output ${n} Off`,
    };
  }
  for (const n of [...digitalInNums].sort((a, b) => a - b)) {
    const key = `digital_input_${n}`;
    labelsByField[key] = {
      trueText: `Input ${n} On`,
      falseText: `Input ${n} Off`,
    };
  }
  for (const n of [...digitalOutNums].sort((a, b) => a - b)) {
    const key = `digital_output_${n}`;
    labelsByField[key] = {
      trueText: `Output ${n} On`,
      falseText: `Output ${n} Off`,
    };
  }

  if (
    /\bpress\b/i.test(s) ||
    /\bbutton_event\b/i.test(s) ||
    /\bbutton_event_status\b/i.test(s)
  ) {
    messages.push(
      'Pulsador / evento: la app ya traduce `press` y `button_event_status` a Short, Long y Double cuando el valor es compatible (sin filas extra en la plantilla).'
    );
  }

  const keys = Object.keys(labelsByField);
  if (keys.length) {
    messages.push(
      `Se generaron etiquetas de visualización para ${keys.length} canal(es): ${keys.join(', ')}. Se guardarán al pulsar «Guardar plantilla».`
    );
  } else {
    messages.push(
      'No se encontraron referencias a gpio_input_*, gpio_output_*, digital_input_* ni digital_output_* en el script; no se añadieron etiquetas On/Off automáticas.'
    );
  }

  return { labelsByField, messages };
}
