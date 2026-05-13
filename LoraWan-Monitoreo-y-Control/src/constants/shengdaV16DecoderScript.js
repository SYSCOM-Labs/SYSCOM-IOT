/**
 * Decoder Shengda Application Layer Protocol V1.6 (TV/TLV, cabecera uplink 0x24).
 * Implementación nativa en servidor: `server/shengda-app-layer.js` expuesta como `Shengda.decodeFrame` en la VM de ingesta.
 */
export const SHENGDA_V16_DECODER_SCRIPT = `
function decodeUplink(input) {
  var r = Shengda.decodeFrame(input.bytes);
  if (!r || typeof r !== 'object') return { data: {} };
  return { data: r };
}
`.trim();
