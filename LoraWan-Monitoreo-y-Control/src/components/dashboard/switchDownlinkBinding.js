import { normalizeDownlinkHex } from './widgetConfigUtils';

/**
 * Par ON/OFF del widget Switch (misma lógica que el clic manual).
 * @param {Record<string, unknown> | null | undefined} switchData `widget.data`
 * @param {{ hex?: string }[]} downlinkList
 * @returns {{ onHex: string | null, offHex: string | null }}
 */
export function resolveSwitchDownlinkHexPair(switchData, downlinkList) {
  const dls = Array.isArray(downlinkList) ? downlinkList : [];
  const pickHex = (stored) => {
    const n = normalizeDownlinkHex(stored);
    if (!n) return null;
    const hit = dls.find((d) => normalizeDownlinkHex(d.hex) === n);
    return hit ? normalizeDownlinkHex(hit.hex) : n;
  };
  const onHex = pickHex(switchData?.switchHexOn);
  const offHex = pickHex(switchData?.switchHexOff);
  if (onHex && offHex) return { onHex, offHex };
  if (dls.length >= 2) {
    return {
      onHex: normalizeDownlinkHex(dls[0].hex),
      offHex: normalizeDownlinkHex(dls[1].hex),
    };
  }
  if (dls.length === 1) {
    const h = normalizeDownlinkHex(dls[0].hex);
    return { onHex: h, offHex: h };
  }
  return { onHex: onHex || null, offHex: offHex || null };
}

/**
 * @param {boolean} switchOn estado actual del interruptor
 * @param {Record<string, unknown> | null | undefined} switchData
 * @param {{ hex?: string }[]} downlinkList
 * @returns {string | null} hex a enviar para invertir el estado
 */
export function pickSwitchDownlinkHexForToggle(switchOn, switchData, downlinkList) {
  const dls = Array.isArray(downlinkList) ? downlinkList : [];
  const { onHex, offHex } = resolveSwitchDownlinkHexPair(switchData, downlinkList);
  const targetOn = !switchOn;
  if (onHex && offHex) return targetOn ? onHex : offHex;
  if (dls.length >= 2) {
    const h = targetOn ? dls[0].hex : dls[1].hex;
    return normalizeDownlinkHex(h) || null;
  }
  if (dls[0]) return normalizeDownlinkHex(dls[0].hex) || null;
  return null;
}

/**
 * @param {unknown} hex payload enviado
 * @ {{ onHex: string | null, offHex: string | null }} pair
 * @returns {boolean | null} true=ON, false=OFF, null=no coincide
 */
export function inferSwitchStateFromDownlinkHex(hex, pair) {
  const n = normalizeDownlinkHex(hex);
  if (!n || !pair) return null;
  if (pair.onHex && n === pair.onHex) return true;
  if (pair.offHex && n === pair.offHex) return false;
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} detail evento SSE LNS
 * @returns {{ deviceId: string, payloadHex: string } | null}
 */
export function parseAutomationDownlinkLnsEvent(detail) {
  const t = detail?.eventType || detail?.type || '';
  if (t !== 'downlink_sent' && t !== 'downlink_deferred') return null;
  const meta = detail?.meta && typeof detail.meta === 'object' ? detail.meta : {};
  if (String(meta.source || '').toLowerCase() !== 'automation') return null;
  const deviceId = meta.deviceId != null ? String(meta.deviceId).trim() : '';
  const payloadHex = meta.payloadHex != null ? String(meta.payloadHex) : meta.payload != null ? String(meta.payload) : '';
  if (!deviceId || !payloadHex.trim()) return null;
  return { deviceId, payloadHex };
}
