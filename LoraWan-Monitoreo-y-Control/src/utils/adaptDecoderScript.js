/**
 * Heurísticas para adaptar codecs pegados (Milesight / ChirpStack / TTN / otros) al contrato
 * que ejecuta el servidor: ver `server/payload-decoder.js` (decodeUplink, Decode, Decoder).
 *
 * Criterio «decoder optimizado» (Syscom VM + widgets):
 * - Sin polyfill Object.assign problemático.
 * - Sin throws que tumbe uplinks raros (downlink desconocido, opcode Milesight desconocido, extractBits).
 * - Bytes de uplink como Array<number> (__syscomNormalizePayloadBytes), alineado con Array.from(Buffer).
 * - readBytes Milesight típico: no avanzar el cursor más allá del buffer.
 * - readUnknownDataType / readOnlyCommand: alineación con patrones Milesight.
 */

function stripBom(s) {
  return String(s || '').replace(/^\uFEFF/, '');
}

/** Elimina el polyfill habitual de Object.assign al inicio de codecs viejos. */
function stripObjectAssignPolyfill(source) {
  // No coincidir con "//if (!Object.assign)" (Milesight comenta el if y deja el defineProperty).
  const re = /(?<!\/)if\s*\(\s*!\s*Object\.assign\s*\)/;
  const m = re.exec(source);
  if (!m) return source;
  const start = m.index;
  let i = start + m[0].length;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== '{') return source;
  let depth = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        let j = i + 1;
        while (j < source.length && /\s/.test(source[j])) j += 1;
        if (source[j] === ';') j += 1;
        return source.slice(0, start) + source.slice(j);
      }
    }
  }
  return source;
}

/** Polyfill Milesight mal comentado: `//if (!Object.assign) {` + `Object.defineProperty(Object, "assign", …)`. */
function stripOrphanObjectAssignPolyfill(source) {
  const needle = /Object\.defineProperty\s*\(\s*Object\s*,\s*["']assign["']\s*,/;
  const m = needle.exec(source);
  if (!m) return source;
  const start = m.index;
  let i = m.index + m[0].length;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== '{') return source;
  let depth = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        let j = i + 1;
        while (j < source.length && /\s/.test(source[j])) j += 1;
        if (source[j] === ')') {
          j += 1;
          while (j < source.length && /\s/.test(source[j])) j += 1;
          if (source[j] === ';') j += 1;
        }
        const head = source.slice(0, start);
        const commentedIf = head.lastIndexOf('//if (!Object.assign)');
        if (commentedIf >= 0) {
          const lineStart = head.lastIndexOf('\n', commentedIf) + 1;
          return source.slice(0, lineStart) + source.slice(j);
        }
        return source.slice(0, start) + source.slice(j);
      }
    }
  }
  return source;
}

function hasDecodeUplinkDefinition(s) {
  return (
    /\bfunction\s+decodeUplink\b/.test(s) ||
    /\bdecodeUplink\s*=\s*function\b/.test(s) ||
    /\b(?:const|let|var)\s+decodeUplink\s*=\s*(?:async\s*)?\(/.test(s) ||
    /\b(?:const|let|var)\s+decodeUplink\s*=\s*(?:async\s*)?function\b/.test(s)
  );
}

function findMainDecodeFunctionName(s) {
  const patterns = [
    /\bfunction\s+(milesightDeviceDecode)\s*\(/,
    /\bfunction\s+(milesightDecoder)\s*\(/,
    /\bfunction\s+(Decoder)\s*\(\s*bytes/i,
    /\bfunction\s+(Decode)\s*\(\s*fPort/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  return null;
}

/** Sustituye lecturas erróneas típicas del byte de reset en codecs copiados. */
function fixResetEventLiteral(s) {
  return s.replace(/\breadResetEvent\s*\(\s*1\s*\)/g, 'readResetEvent(bytes[i++])');
}

/** En default de switch TLV, evitar throw que rompe la VM en uplinks raros. */
function softenUnknownDownlinkThrow(s) {
  return s
    .replace(/throw\s+new\s+Error\s*\(\s*['"]Unknown downlink data['"]\s*\)\s*;/gi, 'break;')
    .replace(/throw\s+new\s+Error\s*\(\s*["']unknown downlink response["']\s*\)\s*;/gi, 'return null;');
}

function fixMilesightResetAndDeviceStatusBlocks(s) {
  return s
    .replace(
      /decoded\.reset_event\s*=\s*readResetEvent\s*\(\s*1\s*\)\s*;\s*\n\s*i\s*\+=\s*1\s*;/g,
      'decoded.reset_event = readResetEvent(bytes[i++]);'
    )
    .replace(
      /decoded\.device_status\s*=\s*readDeviceStatus\s*\(\s*1\s*\)\s*;\s*\n\s*i\s*\+=\s*1\s*;/g,
      'decoded.device_status = readDeviceStatus(bytes[i++]);'
    )
    .replace(
      /decoded\.function_key_event\s*=\s*readYesNoStatus\s*\(\s*1\s*\)\s*;\s*\n\s*i\s*\+=\s*1\s*;/g,
      'decoded.function_key_event = readYesNoStatus(bytes[i++]);'
    );
}

/** Sustituye merge Milesight `decoded = Object.assign(decoded, x.data)` (no hace falta tocar Object.assign global). */
function replaceDecodedObjectAssignMerge(s) {
  return s.replace(
    /decoded\s*=\s*Object\.assign\s*\(\s*decoded\s*,\s*([a-zA-Z_$][\w$]*)\.data\s*\)\s*;/g,
    'var __src = $1.data;\n      var __k;\n      for (__k in __src) {\n        if (Object.prototype.hasOwnProperty.call(__src, __k)) decoded[__k] = __src[__k];\n      }'
  );
}

/** readYesNoStatus(1) en ACK de downlink (byte en offset). */
function fixDownlinkReadYesNoLiteral(s) {
  return s.replace(
    /readYesNoStatus\s*\(\s*1\s*\)\s*;\s*\n\s*offset\s*\+=\s*1\s*;/g,
    'readYesNoStatus(bytes[offset]);\n      offset += 1;'
  );
}

function stripTrailingOrphanMilesightComments(s) {
  let t = s.replace(/\r\n/g, '\n');
  while (/\n\/\/\s*\}\s*$/.test(t)) t = t.replace(/\n\/\/\s*\}\s*$/g, '\n');
  while (/\n\/\/\s*$/.test(t)) t = t.replace(/\n\/\/\s*$/g, '\n');
  return t.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Milesight GS601 y similares: `unknown_command` + throw corta la ingesta. */
function softenMilesightUnknownCommandThrow(source) {
  let s = source;
  s = s.replace(/if\s*\(\s*unknown_command\s*\)\s*\{[\s\S]*?throw\s+new\s+Error\s*\([^)]*\)[\s\S]*?\}\s*/g, '');
  s = s.replace(/\bunknown_command\s*=\s*1\s*;/g, '');
  s = s.replace(/\bvar\s+unknown_command\s*=\s*0\s*;/g, '');
  s = s.replace(/\blet\s+unknown_command\s*=\s*0\s*;/g, '');
  return s;
}

/** Milesight extractBits: errores → 0 (misma idea que decoder GS601 Syscom). */
function softenExtractBitsThrows(source) {
  let s = source;
  s = s.replace(
    /if\s*\(\s*byte\s*<\s*0\s*\|\|\s*byte\s*>\s*0xffff\s*\)\s*\{[\s\S]*?throw\s+new\s+Error[\s\S]*?\}/g,
    'if (byte == null || typeof byte !== "number" || byte < 0 || byte > 0xffff) {\n\t\treturn 0;\n\t}'
  );
  s = s.replace(
    /if\s*\(\s*startBit\s*>=\s*endBit\s*\)\s*\{[\s\S]*?throw\s+new\s+Error[\s\S]*?\}/g,
    'if (startBit >= endBit) {\n\t\treturn 0;\n\t}'
  );
  return s;
}

/** readUnknownDataType Milesight: no lanzar en VM de ingesta. */
function softenReadUnknownDataTypeThrow(source) {
  const re =
    /function\s+readUnknownDataType\s*\(\s*allBytes\s*,\s*counterObj\s*,\s*end\s*\)\s*\{\s*throw\s+new\s+Error[^}]+\}/;
  if (!re.test(source)) return source;
  return source.replace(
    re,
    'function readUnknownDataType(allBytes, counterObj, end) {\n\tvar n = typeof end === "number" && end > 0 ? end : 0;\n\tif (n > 0 && allBytes && counterObj && typeof counterObj.i === "number") {\n\t\tvar max = allBytes.length - counterObj.i;\n\t\tif (max > 0) {\n\t\t\tcounterObj.i += n > max ? max : n;\n\t\t} else {\n\t\t\tcounterObj.i = allBytes.length;\n\t\t}\n\t}\n\treturn null;\n}'
  );
}

/**
 * Patrón Milesight muy repetido: slice + i+=end sin comprobar longitud.
 * Solo se aplica si el cuerpo coincide exactamente con el patrón original.
 */
function hardenMilesightReadBytes(source) {
  const fn = 'function readBytes(allBytes, counterObj, end)';
  const idx = source.indexOf(fn);
  if (idx === -1) return source;
  const sliceNeedle = 'var bytes = allBytes.slice(counterObj.i, counterObj.i + end);';
  const pos = source.indexOf(sliceNeedle, idx);
  if (pos === -1) return source;
  const afterSlice = pos + sliceNeedle.length;
  const m = source.slice(afterSlice).match(/^\s*counterObj\.i\s*\+=\s*end\s*;/);
  if (!m) return source;
  if (source.includes('var start = counterObj.i', idx) && source.indexOf('var start = counterObj.i', idx) < pos + 400) {
    return source;
  }
  const replacementBody = `var start = counterObj.i;
	if (!allBytes || typeof allBytes.length !== "number" || start >= allBytes.length || end <= 0) {
		return [];
	}
	var remain = allBytes.length - start;
	var n = end < remain ? end : remain;
	var bytes = allBytes.slice(start, start + n);
	counterObj.i += n;`;
  return source.slice(0, pos) + replacementBody + source.slice(afterSlice + m[0].length);
}

/** Firma readOnlyCommand(bytes) cuando todas las llamadas pasan 3 argumentos (Milesight). */
function fixReadOnlyCommandSignature(source) {
  if (!/\breadOnlyCommand\s*\(\s*bytes\s*,\s*counterObj/.test(source)) return source;
  return source.replace(/\bfunction\s+readOnlyCommand\s*\(\s*bytes\s*\)/, 'function readOnlyCommand(allBytes, counterObj, end)');
}

const SYSCOM_NORMALIZE_FN = `function __syscomNormalizePayloadBytes(input) {
  var b = (input && input.bytes != null) ? input.bytes : [];
  if (b && !Array.isArray(b) && typeof b.length === "number" && typeof b.slice === "function") {
    b = Array.prototype.slice.call(b);
  }
  return b;
}`;

function hasSyscomNormalizeDefinition(s) {
  return /\bfunction\s+__syscomNormalizePayloadBytes\b/.test(s);
}

/**
 * Sustituye usos de input.bytes en llamadas típicas y declara el helper al final si hace falta.
 */
function applyPayloadBytesNormalization(source, messages) {
  let s = source;
  if (hasSyscomNormalizeDefinition(s)) return s;

  const usesHelper =
    /\bmilesightDeviceDecode\s*\(\s*input\.bytes\s*\)/.test(s) ||
    /\bmilesightDecoder\s*\(\s*input\.bytes\s*\)/.test(s) ||
    /\bDecoder\s*\(\s*input\.bytes\s*,/.test(s) ||
    /\bDecode\s*\(\s*[^,]+,\s*input\.bytes\s*\)/.test(s) ||
    /\b(?:var|let)\s+bytes\s*=\s*input\.bytes\s*;/.test(s);

  if (!usesHelper) return s;

  const before = s;
  s = s.replace(/\bmilesightDeviceDecode\s*\(\s*input\.bytes\s*\)/g, 'milesightDeviceDecode(__syscomNormalizePayloadBytes(input))');
  s = s.replace(/\bmilesightDecoder\s*\(\s*input\.bytes\s*\)/g, 'milesightDecoder(__syscomNormalizePayloadBytes(input))');
  s = s.replace(/\bDecoder\s*\(\s*input\.bytes\s*,/g, 'Decoder(__syscomNormalizePayloadBytes(input),');
  s = s.replace(/\bDecode\s*\(\s*([^,]+?)\s*,\s*input\.bytes\s*\)/g, 'Decode($1, __syscomNormalizePayloadBytes(input))');
  s = s.replace(/\bvar\s+bytes\s*=\s*input\.bytes\s*;/g, 'var bytes = __syscomNormalizePayloadBytes(input);');
  s = s.replace(/\blet\s+bytes\s*=\s*input\.bytes\s*;/g, 'let bytes = __syscomNormalizePayloadBytes(input);');

  if (s !== before) {
    messages.push(
      'Se añadió __syscomNormalizePayloadBytes (Uint8Array/Buffer-like → Array) para igualar el contrato del servidor y no omitir bytes.'
    );
  }
  return s;
}

function appendSyscomNormalizeIfNeeded(source) {
  let s = source.trimEnd();
  if (!s.includes('__syscomNormalizePayloadBytes')) return s;
  if (hasSyscomNormalizeDefinition(s)) return s;
  return `${s}\n\n// --- Syscom IoT («Ajustar»): normalización de bytes de uplink ---\n${SYSCOM_NORMALIZE_FN}\n`;
}

/**
 * @param {string} raw
 * @returns {{ script: string, messages: string[] }}
 */
export function adaptDecoderScriptForSyscom(raw) {
  const messages = [];
  let s = stripBom(raw).replace(/\r\n/g, '\n').trim();

  if (!s) {
    return { script: '', messages: ['El script está vacío.'] };
  }

  const beforePoly = s;
  s = stripObjectAssignPolyfill(s);
  if (s !== beforePoly) messages.push('Se eliminó el polyfill de Object.assign (no hace falta en Node).');

  const beforeOrphan = s;
  s = stripOrphanObjectAssignPolyfill(s);
  if (s !== beforeOrphan) messages.push('Se eliminó Object.defineProperty(Object.assign) residual (codec Milesight).');

  const beforeReset = s;
  s = fixResetEventLiteral(s);
  s = fixMilesightResetAndDeviceStatusBlocks(s);
  if (s !== beforeReset) {
    messages.push('Se corrigieron readResetEvent / readDeviceStatus / readYesNoStatus en uplink (byte real del payload).');
  }

  const beforeThrow = s;
  s = softenUnknownDownlinkThrow(s);
  if (s !== beforeThrow) {
    messages.push('Se neutralizó throw en respuesta de downlink desconocida (compat. servidor).');
  }

  const beforeAssignMerge = s;
  s = replaceDecodedObjectAssignMerge(s);
  if (s !== beforeAssignMerge) {
    messages.push('Se reemplazó Object.assign en fusión decoded/result por bucle (sin depender del polyfill).');
  }

  const beforeYesNoDl = s;
  s = fixDownlinkReadYesNoLiteral(s);
  if (s !== beforeYesNoDl) {
    messages.push('Se corrigió readYesNoStatus(1) en respuestas downlink (byte real).');
  }

  const beforeUnkCmd = s;
  s = softenMilesightUnknownCommandThrow(s);
  if (s !== beforeUnkCmd) messages.push('Se eliminó throw por opcode Milesight desconocido (unknown_command).');

  const beforeExtract = s;
  s = softenExtractBitsThrows(s);
  if (s !== beforeExtract) messages.push('Se suavizó extractBits (errores → 0) para no tumbar uplinks anómalos.');

  const beforeRUDT = s;
  s = softenReadUnknownDataTypeThrow(s);
  if (s !== beforeRUDT) messages.push('Se reemplazó readUnknownDataType que lanzaba por versión tolerante a VM.');

  const beforeRB = s;
  s = hardenMilesightReadBytes(s);
  if (s !== beforeRB) messages.push('Se endureció readBytes (no avanza más allá del buffer; evita NaN/telemetría basura).');

  const beforeROC = s;
  s = fixReadOnlyCommandSignature(s);
  if (s !== beforeROC) messages.push('Se alineó firma readOnlyCommand con llamadas (allBytes, counterObj, end).');

  if (!hasDecodeUplinkDefinition(s)) {
    const inner = findMainDecodeFunctionName(s);
    if (inner === 'milesightDeviceDecode' || inner === 'milesightDecoder') {
      const fn = inner;
      const header =
        '// Ajustado para Syscom IoT: entrada { bytes, fPort } → { data }\n' +
        'function decodeUplink(input) {\n' +
        '  var bytes = __syscomNormalizePayloadBytes(input);\n' +
        `  return { data: ${fn}(bytes) };\n` +
        '}\n\n';
      s = header + s;
      messages.push(`Se añadió decodeUplink que delega en ${fn}(bytes) con bytes normalizados.`);
    } else if (inner === 'Decoder') {
      const header =
        '// Ajustado para Syscom IoT\n' +
        'function decodeUplink(input) {\n' +
        '  var bytes = __syscomNormalizePayloadBytes(input);\n' +
        '  var port = input.fPort != null ? input.fPort : 1;\n' +
        '  var r = Decoder(bytes, port);\n' +
        '  if (r != null && typeof r === "object" && !Array.isArray(r) && r.data !== undefined) {\n' +
        '    return { data: r.data };\n' +
        '  }\n' +
        '  return { data: r && typeof r === "object" && !Array.isArray(r) ? r : {} };\n' +
        '}\n\n';
      s = header + s;
      messages.push('Se añadió decodeUplink que invoca Decoder(bytes, fPort) con bytes normalizados.');
    } else if (inner === 'Decode') {
      const header =
        '// Ajustado para Syscom IoT\n' +
        'function decodeUplink(input) {\n' +
        '  var bytes = __syscomNormalizePayloadBytes(input);\n' +
        '  var port = input.fPort != null ? input.fPort : 1;\n' +
        '  var r = Decode(port, bytes);\n' +
        '  return { data: r && typeof r === "object" && !Array.isArray(r) ? r : {} };\n' +
        '}\n\n';
      s = header + s;
      messages.push('Se añadió decodeUplink que invoca Decode(fPort, bytes) con bytes normalizados.');
    } else {
      messages.push(
        'No se detectó milesightDeviceDecode / Decoder / Decode. Pegue un codec que defina una de esas funciones o añada decodeUplink manualmente.'
      );
    }
  } else {
    messages.push('Ya existe decodeUplink: se aplicaron limpiezas y endurecimiento Syscom adicionales.');
  }

  s = applyPayloadBytesNormalization(s, messages);
  s = appendSyscomNormalizeIfNeeded(s);

  s = stripTrailingOrphanMilesightComments(s);

  return { script: s.trimEnd(), messages };
}
