'use strict';

/**
 * Prepara codecs Milesight / ChirpStack pegados para la VM del servidor (payload-decoder.js).
 * Duplica lo esencial de src/utils/adaptDecoderScript.js en CJS para el proceso API.
 */

const SYSCOM_NORMALIZE_FN = `function __syscomNormalizePayloadBytes(input) {
  var b = (input && input.bytes != null) ? input.bytes : [];
  if (b && !Array.isArray(b) && typeof b.length === "number" && typeof b.slice === "function") {
    b = Array.prototype.slice.call(b);
  }
  return b;
}`;

function hasDecodeUplinkDefinition(s) {
  return (
    /\bfunction\s+decodeUplink\b/.test(s) ||
    /\bdecodeUplink\s*=\s*function\b/.test(s) ||
    /\b(?:const|let|var)\s+decodeUplink\s*=\s*(?:async\s*)?\(/.test(s)
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

function stripObjectAssignPolyfill(source) {
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

function softenUnknownDownlinkThrow(s) {
  return s
    .replace(/throw\s+new\s+Error\s*\(\s*['"]Unknown downlink data['"]\s*\)\s*;/gi, 'break;')
    .replace(/throw\s+new\s+Error\s*\(\s*["']unknown downlink response["']\s*\)\s*;/gi, 'return null;');
}

function replaceDecodedObjectAssignMerge(s) {
  return s.replace(/decoded\s*=\s*Object\.assign\s*\(\s*decoded\s*,\s*([^)]+)\s*\)\s*;/g, (_, src) => {
    return `var __src = ${src};
      var __k;
      for (__k in __src) {
        if (Object.prototype.hasOwnProperty.call(__src, __k)) decoded[__k] = __src[__k];
      }`;
  });
}

/**
 * @param {string} raw
 * @returns {string}
 */
function prepareDecoderScriptForRuntime(raw) {
  let s = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!s) return '';

  s = stripObjectAssignPolyfill(s);
  s = softenUnknownDownlinkThrow(s);
  s = replaceDecodedObjectAssignMerge(s);

  if (!hasDecodeUplinkDefinition(s)) {
    const inner = findMainDecodeFunctionName(s);
    if (inner === 'milesightDeviceDecode' || inner === 'milesightDecoder') {
      const fn = inner;
      s =
        '// Syscom IoT: entrada { bytes, fPort } → { data }\n' +
        'function decodeUplink(input) {\n' +
        '  var bytes = __syscomNormalizePayloadBytes(input);\n' +
        `  return { data: ${fn}(bytes) };\n` +
        '}\n\n' +
        s;
    }
  } else {
    s = s.replace(
      /\bmilesightDeviceDecode\s*\(\s*input\.bytes\s*\)/g,
      'milesightDeviceDecode(__syscomNormalizePayloadBytes(input))'
    );
  }

  if (!/\bfunction\s+__syscomNormalizePayloadBytes\b/.test(s)) {
    s = `${s}\n\n// --- Syscom IoT runtime ---\n${SYSCOM_NORMALIZE_FN}\n`;
  }

  return s;
}

module.exports = { prepareDecoderScriptForRuntime, SYSCOM_NORMALIZE_FN };
