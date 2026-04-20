/**
 * Adapta codecs Milesight / ChirpStack pegados al contrato Syscom (decodeUplink → { data }, VM Node).
 * @param {string} raw
 * @returns {{ script: string, messages: string[] }}
 */
export function adaptDecoderScriptForSyscom(raw) {
  const messages = [];
  const push = (msg) => {
    if (msg && !messages.includes(msg)) messages.push(msg);
  };

  let s =
    raw == null
      ? ''
      : String(raw)
          .replace(/^\uFEFF/, '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();

  // Milesight: //if (!Object.assign) { ... Object.defineProperty... }); //}
  {
    const re =
      /\n\/\/\s*if\s*\(\s*!Object\.assign\)[^\n]*\n[\s\S]*?Object\.defineProperty\s*\(\s*Object\s*,\s*["']assign["']\s*,\s*\{[\s\S]*?\}\s*\)\s*;\s*\n?\s*\/\/\s*\}?\s*/g;
    const n = s.replace(re, '\n');
    if (n !== s) {
      s = n;
      push('Eliminado bloque comentado //if (!Object.assign) + Object.defineProperty(Object,"assign",…).');
    }
  }

  // Orphan Object.defineProperty only (sin //if previo cerca)
  for (let iter = 0; iter < 5; iter++) {
    const idx = s.indexOf('Object.defineProperty(Object,');
    if (idx < 0) break;
    const prev = s.slice(Math.max(0, idx - 200), idx);
    if (/\/\/\s*if\s*\(\s*!Object\.assign/.test(prev)) break;
    let depth = 0;
    let i = s.indexOf('{', idx);
    if (i < 0) break;
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          if (s.slice(i, i + 2) === '});') i += 2;
          else i++;
          break;
        }
      }
    }
    const lineStart = s.lastIndexOf('\n', idx - 1) + 1;
    s = s.slice(0, lineStart) + s.slice(i);
    push('Eliminado Object.defineProperty(Object, "assign", …) residual.');
  }

  if (/\breadResetEvent\s*\(\s*1\s*\)/.test(s)) {
    s = s.replace(/\breadResetEvent\s*\(\s*1\s*\)/g, 'readResetEvent(bytes[i])');
    push('readResetEvent(1) → readResetEvent(bytes[i]).');
  }
  if (/\breadDeviceStatus\s*\(\s*1\s*\)/.test(s)) {
    s = s.replace(/\breadDeviceStatus\s*\(\s*1\s*\)/g, 'readDeviceStatus(bytes[i])');
    push('readDeviceStatus(1) → readDeviceStatus(bytes[i]).');
  }
  if (/function_key_event\s*=\s*readYesNoStatus\s*\(\s*1\s*\)/.test(s)) {
    s = s.replace(/function_key_event\s*=\s*readYesNoStatus\s*\(\s*1\s*\)/g, 'function_key_event = readYesNoStatus(bytes[i])');
    push('function_key_event: readYesNoStatus(1) → readYesNoStatus(bytes[i]).');
  }

  if (/throw\s+new\s+Error\s*\(\s*['"]Unknown downlink data/gi.test(s)) {
    s = s.replace(/throw\s+new\s+Error\s*\(\s*['"]Unknown downlink data[^)]*\)\s*;?/gi, 'return null;');
    push("throw 'Unknown downlink data…' → return null (equivalente seguro a cortar el handler).");
  }
  if (/throw\s+new\s+Error\s*\(\s*["']unknown downlink response["']\s*\)/gi.test(s)) {
    s = s.replace(/throw\s+new\s+Error\s*\(\s*["']unknown downlink response["']\s*\)\s*;?/gi, 'return null;');
    push('throw unknown downlink response → return null.');
  }

  s = s.replace(
    /decoded\s*=\s*Object\.assign\s*\(\s*decoded\s*,\s*([a-zA-Z_$][\w$]*)\.data\s*\)\s*;/g,
    (_, id) => {
      push('Object.assign(decoded, …) → bucle for…in con hasOwnProperty.');
      return `var __src = ${id}.data;\nfor (var __k in __src) {\n  if (Object.prototype.hasOwnProperty.call(__src, __k)) {\n    decoded[__k] = __src[__k];\n  }\n}`;
    }
  );

  s = s.replace(
    /readYesNoStatus\s*\(\s*1\s*\)\s*;\s*\n\s*offset\s*\+=\s*1\s*;/g,
    'readYesNoStatus(bytes[offset]);\n    offset += 1;'
  );
  if (/readYesNoStatus\(bytes\[offset\]\)\s*;\s*\n\s*offset\s*\+=\s*1/.test(s)) {
    push('readYesNoStatus(1) + offset += 1 → readYesNoStatus(bytes[offset]) + offset += 1.');
  }

  if (/handle_downlink_response/.test(s) && /var\s+result\s*=\s*handle_downlink_response/.test(s)) {
    const needGuard = !/\bif\s*\(\s*!\s*result\s*\)/.test(s);
    if (needGuard) {
      s = s.replace(
        /(var\s+result\s*=\s*handle_downlink_response\s*\([^)]+\)\s*;)/g,
        '$1\n    if (!result) { break; }'
      );
      push('Añadido if (!result) { break; } tras handle_downlink_response.');
    }
  }

  if (!/\bfunction\s+decodeUplink\s*\(/.test(s) && !/\bdecodeUplink\s*=\s*function/.test(s)) {
    let inner = '';
    if (/\bfunction\s+milesightDeviceDecode\s*\(/.test(s)) {
      inner = `function decodeUplink(input) {\n  var decoded = milesightDeviceDecode(input.bytes);\n  return { data: decoded || {} };\n}\n\n`;
      push('Añadido wrapper decodeUplink (milesightDeviceDecode).');
    } else if (/\bfunction\s+Decoder\s*\(/.test(s)) {
      inner = `function decodeUplink(input) {\n  return { data: Decoder(input.bytes, input.fPort) || {} };\n}\n\n`;
      push('Añadido wrapper decodeUplink (Decoder).');
    } else if (/\bfunction\s+Decode\s*\(/.test(s)) {
      inner = `function decodeUplink(input) {\n  return { data: Decode(input.fPort, input.bytes) || {} };\n}\n\n`;
      push('Añadido wrapper decodeUplink (Decode).');
    }
    if (inner) s = inner + s;
  }

  s = s.replace(/(\n[\t ]*\/\/\s*\}\s*)+$/g, '\n');
  s = s.replace(/\n{4,}/g, '\n\n\n');
  s = s.trim();

  if (!messages.length) {
    push('Sin transformaciones reconocidas (revisar manualmente si el codec usa otro patrón).');
  }

  return { script: s, messages };
}
