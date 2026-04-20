/**
 * Plantilla UC300 (Milesight): post-proceso para que GPIO/contadores en `channel_history`
 * queden también en el objeto raíz del `data` (TSL / historial coherentes).
 * Pegar encima el decode TLV oficial si hace falta; este script solo aplica la promoción.
 */
export const UC300_DECODER_SCRIPT = `
function promoteGpioFromChannelHistory(data) {
  if (!data || typeof data !== 'object') return data;
  var ch = data.channel_history;
  if (!Array.isArray(ch) || ch.length === 0) return data;
  var last = ch[ch.length - 1];
  if (!last || typeof last !== 'object') return data;
  var re = /^gpio_(input|output)_\\d+$|^gpio_counter_\\d+$/;
  for (var k in last) {
    if (!Object.prototype.hasOwnProperty.call(last, k)) continue;
    if (!re.test(k)) continue;
    if (data[k] == null || data[k] === '') data[k] = last[k];
  }
  return data;
}

/** Pegar decode TLV Milesight aquí (objeto data); si queda vacío, el servidor aún promueve channel_history tras ingesta. */
function decodeUplink(input) {
  var data = {};
  promoteGpioFromChannelHistory(data);
  return { data: data };
}
`.trim();
