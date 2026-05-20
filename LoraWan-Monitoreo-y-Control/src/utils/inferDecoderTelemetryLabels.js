/**
 * Infiere `telemetryLabels` para plantillas desde el texto del payload decoder (botón «Ajustar»).
 * Detecta: GPIO, pulsador WS101, mapas Milesight (`status_map`, `alarm_map`) y asignaciones `decoded.campo = readX()`.
 */

/** @typedef {{ trueText?: string, falseText?: string, valueLabels?: Record<string, string> }} TelemetryLabelHint */

/**
 * @param {string} raw
 * @returns {string}
 */
function formatEnumDisplayLabel(raw) {
  const t = String(raw ?? '')
    .trim()
    .replace(/_/g, ' ');
  if (!t) return '';
  const low = t.toLowerCase();
  if (low === 'short press' || low === 'short') return 'Short';
  if (low === 'long press' || low === 'long') return 'Long';
  if (low === 'double press' || low === 'double') return 'Double';
  if (low === 'disable') return 'Disable';
  if (low === 'enable') return 'Enable';
  if (low === 'yes') return 'Yes';
  if (low === 'no') return 'No';
  if (low === 'alarm triggered' || low === 'alarm_triggered') return 'Alarm triggered';
  if (low === 'alarm released' || low === 'alarm_released') return 'Alarm released';
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {string} mapBody contenido entre `{` y `}`
 * @returns {Record<string, string>}
 */
function parseMapLiteralToValueLabels(mapBody) {
  const valueLabels = {};
  if (!mapBody) return valueLabels;
  const re = /([0-9]+)\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(mapBody)) !== null) {
    const num = m[1];
    const raw = m[2].trim();
    const display = formatEnumDisplayLabel(raw);
    if (!display) continue;
    valueLabels[num] = display;
    valueLabels[String(parseInt(num, 10))] = display;
    const low = raw.toLowerCase();
    valueLabels[low] = display;
    if (low.includes(' ')) {
      valueLabels[low.replace(/\s+/g, '_')] = display;
    }
  }
  return valueLabels;
}

/**
 * @param {string} script
 * @returns {Map<string, Record<string, string>>}
 */
/**
 * @param {string} s
 * @param {number} openBraceIdx index of `{`
 * @returns {string}
 */
function sliceBalancedBraces(s, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(openBraceIdx + 1, i);
    }
  }
  return '';
}

function extractReaderValueLabelMaps(script) {
  const s = String(script || '');
  const readerMaps = new Map();

  const funcHeadRe = /function\s+(read[A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g;
  let fm;
  while ((fm = funcHeadRe.exec(s)) !== null) {
    const readerName = fm[1];
    const body = sliceBalancedBraces(s, fm.index + fm[0].length - 1);
    const mapVarRe = /(?:var|let|const)\s+(\w+)\s*=\s*(\{[^;\n]+\})/gi;
    let mm;
    while ((mm = mapVarRe.exec(body)) !== null) {
      const mapVar = mm[1];
      const mapBody = mm[2];
      if (!body.includes(mapVar)) continue;
      const labels = parseMapLiteralToValueLabels(mapBody.slice(1, -1));
      if (Object.keys(labels).length) {
        readerMaps.set(readerName, { ...(readerMaps.get(readerName) || {}), ...labels });
      }
    }
    const inlineReturn = /return\s+(\w+_map|\w+Map)\[/.exec(body);
    if (inlineReturn) {
      const localMapRe = new RegExp(
        `(?:var|let|const)\\s+${inlineReturn[1]}\\s*=\\s*(\\{[^;\\n]+\\})`,
        'i'
      );
      const lm = localMapRe.exec(body);
      if (lm) {
        const labels = parseMapLiteralToValueLabels(lm[1].slice(1, -1));
        if (Object.keys(labels).length) {
          readerMaps.set(readerName, { ...(readerMaps.get(readerName) || {}), ...labels });
        }
      }
    }
  }

  return readerMaps;
}

/**
 * @param {string} script
 * @returns {Array<{ field: string, reader: string }>}
 */
function extractDecodedFieldReaders(script) {
  const s = String(script || '');
  const out = [];
  const re = /decoded\.([\w.]+)\s*=\s*read([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const field = m[1];
    const reader = `read${m[2]}`;
    out.push({ field, reader });
  }
  return out;
}

/**
 * @param {Record<string, TelemetryLabelHint>} labelsByField
 * @param {string} field
 * @param {Record<string, string>} valueLabels
 */
function fieldKeyVariants(field) {
  const base = String(field || '').trim().toLowerCase();
  if (!base) return [];
  const set = new Set([base, base.replace(/\./g, '_'), base.replace(/_/g, '.')]);
  return [...set];
}

function mergeFieldValueLabels(labelsByField, field, valueLabels) {
  if (!valueLabels || !Object.keys(valueLabels).length) return;
  for (const fk of fieldKeyVariants(field)) {
    const prev = labelsByField[fk] || {};
    labelsByField[fk] = {
      ...prev,
      valueLabels: { ...(prev.valueLabels || {}), ...valueLabels },
    };
  }
}

/**
 * @param {string} script
 * @param {Record<string, TelemetryLabelHint>} labelsByField
 */
function inferFromReaderMaps(script, labelsByField) {
  const readerMaps = extractReaderValueLabelMaps(script);
  const assignments = extractDecodedFieldReaders(script);

  for (const { field, reader } of assignments) {
    const map = readerMaps.get(reader);
    if (map) mergeFieldValueLabels(labelsByField, field, map);
  }

  const enableLabels = readerMaps.get('readEnableStatus');
  if (enableLabels) {
    for (const m of String(script).matchAll(/decoded\.([\w.]+)\s*=\s*readEnableStatus\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, m[1].replace(/\./g, '_'), enableLabels);
    }
    for (const fk of Object.keys(labelsByField)) {
      if (/_enable$/i.test(fk) && !labelsByField[fk]?.valueLabels) {
        mergeFieldValueLabels(labelsByField, fk, enableLabels);
      }
    }
  }

  const yesNoLabels = readerMaps.get('readYesNoStatus');
  if (yesNoLabels) {
    for (const m of String(script).matchAll(/decoded\.([\w.]+)\s*=\s*readYesNoStatus\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, m[1].replace(/\./g, '_'), yesNoLabels);
    }
  }

  const alarmLabels = readerMaps.get('readAlarmType');
  if (alarmLabels) {
    const scr = String(script);
    for (const m of scr.matchAll(/decoded\.([\w.]+)\s*=\s*readAlarmType\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, m[1], alarmLabels);
    }
    for (const m of scr.matchAll(/\+\s*["']([^"']*_alarm)["']\s*\]\s*=\s*readAlarmType\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, `master${m[1]}`, alarmLabels);
      mergeFieldValueLabels(labelsByField, m[1], alarmLabels);
    }
    for (const m of scr.matchAll(/["']([a-z0-9_]+_alarm)["']/gi)) {
      mergeFieldValueLabels(labelsByField, m[1], alarmLabels);
    }
    for (const fk of Object.keys(labelsByField)) {
      if (/_alarm$/i.test(fk) && !labelsByField[fk]?.valueLabels) {
        mergeFieldValueLabels(labelsByField, fk, alarmLabels);
      }
    }
  }

  const logLabels = readerMaps.get('readLogLevel');
  if (logLabels) {
    for (const m of String(script).matchAll(/decoded\.([\w.]+)\s*=\s*readLogLevel\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, m[1].replace(/\./g, '_'), logLabels);
    }
  }

  const classLabels = readerMaps.get('readLoRaWANClass');
  if (classLabels) {
    mergeFieldValueLabels(labelsByField, 'lorawan_class', classLabels);
  }

  const deviceStatusLabels = readerMaps.get('readDeviceStatus');
  if (deviceStatusLabels) {
    mergeFieldValueLabels(labelsByField, 'device_status', deviceStatusLabels);
  }

  const switchLabels = readerMaps.get('readSwitchStatus');
  if (switchLabels) {
    for (const m of String(script).matchAll(/decoded\.([\w.]+)\s*=\s*readSwitchStatus\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, m[1].replace(/\./g, '_'), switchLabels);
    }
  }

  const onOffLabels = readerMaps.get('readOnOffStatus') || { on: 'On', off: 'Off', 1: 'On', 0: 'Off' };
  if (/readOnOffStatus\s*\(/.test(script)) {
    for (const m of String(script).matchAll(/decoded\.([\w.]+)\s*=\s*readOnOffStatus\s*\(/g)) {
      const field = m[1].replace(/\./g, '_');
      mergeFieldValueLabels(labelsByField, field, onOffLabels);
      if (!labelsByField[field]?.trueText) {
        labelsByField[field] = {
          ...(labelsByField[field] || {}),
          trueText: 'On',
          falseText: 'Off',
        };
      }
    }
  }

  const resetLabels = readerMaps.get('readResetEvent');
  if (resetLabels) {
    mergeFieldValueLabels(labelsByField, 'reset_event', resetLabels);
  }

  const resultLabels = readerMaps.get('readResultStatus');
  if (resultLabels) {
    for (const m of String(script).matchAll(/decoded\.([\w.]+)\s*=\s*readResultStatus\s*\(/g)) {
      mergeFieldValueLabels(labelsByField, m[1].replace(/\./g, '_'), resultLabels);
    }
    mergeFieldValueLabels(labelsByField, 'device_response_result.result', resultLabels);
  }
}

/**
 * @param {Record<string, TelemetryLabelHint>} labelsByField
 */
function inferGpioLabels(script, labelsByField) {
  const s = String(script || '');
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
}

/**
 * @param {Record<string, TelemetryLabelHint>} labelsByField
 */
function inferButtonLabels(script, labelsByField) {
  if (
    !/\bpress\b/i.test(script) &&
    !/\bbutton_event\b/i.test(script) &&
    !/\breadButtonEvent\b/i.test(script)
  ) {
    return;
  }
  const buttonValueLabels = {
    1: 'Short',
    2: 'Long',
    3: 'Double',
    short: 'Short',
    long: 'Long',
    double: 'Double',
    'short press': 'Short press',
    'long press': 'Long press',
    'double press': 'Double press',
  };
  for (const key of ['press', 'button_event_status', 'button_event.status', 'button_event', 'press_raw']) {
    mergeFieldValueLabels(labelsByField, key, buttonValueLabels);
  }
}

/**
 * @param {string} script
 * @returns {{ labelsByField: Record<string, TelemetryLabelHint>, messages: string[] }}
 */
export function inferTelemetryLabelsFromDecoderScript(script) {
  const messages = [];
  /** @type {Record<string, TelemetryLabelHint>} */
  const labelsByField = {};

  inferGpioLabels(script, labelsByField);
  inferButtonLabels(script, labelsByField);
  inferFromReaderMaps(script, labelsByField);

  const keys = Object.keys(labelsByField);
  const withEnum = keys.filter((k) => labelsByField[k]?.valueLabels);
  const withBool = keys.filter((k) => labelsByField[k]?.trueText || labelsByField[k]?.falseText);

  if (withEnum.length) {
    messages.push(
      `Etiquetas enum (${withEnum.length} campo(s)): ${withEnum.slice(0, 12).join(', ')}${
        withEnum.length > 12 ? '…' : ''
      } (mapas status_map / alarm_map / read* del decoder).`
    );
  }
  if (withBool.length) {
    messages.push(
      `GPIO / digital (${withBool.length}): ${withBool.slice(0, 8).join(', ')}${withBool.length > 8 ? '…' : ''}.`
    );
  }
  if (!keys.length) {
    messages.push(
      'No se detectaron GPIO, pulsador, mapas status_map ni asignaciones decoded.*=read*(); puede añadir valueLabels manualmente en la plantilla.'
    );
  } else {
    messages.push(
      `Total: ${keys.length} campo(s) con etiquetas de visualización. Se guardan al pulsar «Guardar plantilla».`
    );
  }

  return { labelsByField, messages };
}
