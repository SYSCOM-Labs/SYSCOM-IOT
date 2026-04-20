'use strict';

/**
 * El campo `channel` en `device_decode_config` es **metadato de plantilla/aplicación**:
 * el **FPort LoRaWAN de aplicación** (1–223), no MHz ni el “canal” RF del plan regional.
 * Puede ser número en string o texto con un número (p. ej. "FPort 85").
 * Ver docs/LORAWAN-CHANNELS-VS-APP.md.
 */

function parseFPortFromDecodeChannel(channel) {
  const s = String(channel == null ? '' : channel).trim();
  if (!s) return null;
  const direct = parseInt(s, 10);
  if (Number.isInteger(direct) && direct >= 1 && direct <= 223) return direct;
  const m = s.match(/\b(\d{1,3})\b/);
  if (m) {
    const v = parseInt(m[1], 10);
    if (Number.isInteger(v) && v >= 1 && v <= 223) return v;
  }
  return null;
}

/**
 * Resuelve FPort para downlink de aplicación (LNS).
 * Orden: cuerpo explícito → `channel` en decode-config del dispositivo → SYSCOM_LNS_DEFAULT_FPORT.
 * @param {{ getDeviceDecodeConfig: (id: string) => { channel?: string } }} store
 * @param {string} deviceId
 * @param {Record<string, unknown>} [body]
 * @returns {{ ok: true, fPort: number } | { ok: false, error: string, code?: string }}
 */
function resolveAppFPortForDownlink(store, deviceId, body) {
  const b = body && typeof body === 'object' ? body : {};
  const explicit = b.fPort ?? b.fport;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const n = Number(explicit);
    if (Number.isInteger(n) && n >= 1 && n <= 223) return { ok: true, fPort: n };
    return { ok: false, error: 'fPort explícito inválido (use entero 1–223).', code: 'FPORT_INVALID' };
  }

  const did = String(deviceId || '').trim();
  const cfg = did && typeof store.getDeviceDecodeConfig === 'function' ? store.getDeviceDecodeConfig(did) : null;
  const fromChannel = cfg ? parseFPortFromDecodeChannel(cfg.channel) : null;
  if (fromChannel != null) return { ok: true, fPort: fromChannel };

  const envRaw = process.env.SYSCOM_LNS_DEFAULT_FPORT;
  if (envRaw != null && String(envRaw).trim() !== '') {
    const n = parseInt(String(envRaw).trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= 223) return { ok: true, fPort: n };
  }

  return {
    ok: false,
    error:
      'No hay FPort de aplicación: envíe fPort en el cuerpo del downlink o defina el campo «Canal plantilla (FPort)» en la configuración del decoder del dispositivo (no es frecuencia MHz). Reaplique la plantilla o use el engranaje de decoder en Dispositivos. Opcional en servidor: SYSCOM_LNS_DEFAULT_FPORT.',
    code: 'FPORT_REQUIRED',
  };
}

/**
 * FPort para ejecutar el decoder en ingesta cuando el uplink no trae fPort.
 * @param {Record<string, unknown>} properties
 * @param {{ channel?: string }} [decodeCfg]
 */
function resolveFPortForDecoder(properties, decodeCfg) {
  const fp = properties?.fPort ?? properties?.fport;
  if (fp !== undefined && fp !== null && String(fp).trim() !== '') {
    const n = Number(fp);
    if (Number.isInteger(n) && n >= 1 && n <= 223) return n;
  }
  const fromCh = decodeCfg ? parseFPortFromDecodeChannel(decodeCfg.channel) : null;
  if (fromCh != null) return fromCh;

  const envRaw = process.env.SYSCOM_LNS_DEFAULT_FPORT;
  if (envRaw != null && String(envRaw).trim() !== '') {
    const n = parseInt(String(envRaw).trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= 223) return n;
  }
  return null;
}

module.exports = {
  parseFPortFromDecodeChannel,
  resolveAppFPortForDownlink,
  resolveFPortForDecoder,
};
