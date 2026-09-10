/** Número de medidor TimeWave: 12 hex (6 BCD). El DevEUI (16 hex) no vale. */
export function normalizeTimewaveMeterNo12(raw) {
  const h = String(raw || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return h.length === 12 ? h : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} deviceRow
 * @returns {string | null}
 */
export function pickTimewaveMeterNoFromDevice(deviceRow) {
  if (!deviceRow || typeof deviceRow !== 'object') return null;
  return (
    normalizeTimewaveMeterNo12(deviceRow.timewave_meterNo) ||
    normalizeTimewaveMeterNo12(deviceRow.meterNumber) ||
    normalizeTimewaveMeterNo12(deviceRow.meterNo) ||
    normalizeTimewaveMeterNo12(deviceRow.deviceSerialHex) ||
    normalizeTimewaveMeterNo12(deviceRow.serialHex)
  );
}

function hexToBytes(hex) {
  const h = String(hex || '');
  const n = h.length / 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function checksumFrom68(bytes, endExclusive) {
  let s = 0;
  for (let i = 4; i < endExclusive; i += 1) s = (s + bytes[i]) & 0xff;
  return s;
}

/**
 * Reescribe trama TimeWave: nº de medidor y acción AAAA/BBBB → DDDD/EEEE.
 * @param {string} hex
 * @param {string | null | undefined} meterNoHex12
 * @returns {string | null}
 */
export function rewriteTimewaveDownlinkHex(hex, meterNoHex12) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h || h.length % 2 !== 0 || !/^[0-9a-f]+$/.test(h) || h.length < 40) return null;
  if (!h.startsWith('fefefefe')) return null;
  const buf = hexToBytes(h);
  if (buf[4] !== 0x68 || buf[11] !== 0x68) return null;
  const dataLen = buf[13];
  const endIdx = 14 + dataLen;
  if (buf.length < endIdx + 2 || buf[endIdx + 1] !== 0x16) return null;
  const meter = normalizeTimewaveMeterNo12(meterNoHex12);
  if (meter) {
    for (let i = 0; i < 6; i += 1) {
      buf[5 + i] = parseInt(meter.slice((5 - i) * 2, (5 - i) * 2 + 2), 16);
    }
  }
  if (buf[12] === 0x14 && dataLen >= 14) {
    const a0 = buf[26];
    const a1 = buf[27];
    const di0 = buf[14];
    const di1 = buf[15];
    const di2 = buf[16];
    const di3 = buf[17];
    const isValveDi = di0 === 0x35 && di1 === 0xdd && di2 === 0x93 && di3 === 0x37;
    if (isValveDi && a0 === 0xaa && a1 === 0xaa) {
      buf[26] = 0xdd;
      buf[27] = 0xdd;
    } else if (isValveDi && a0 === 0xbb && a1 === 0xbb) {
      buf[26] = 0xee;
      buf[27] = 0xee;
    }
  }
  buf[endIdx] = checksumFrom68(buf, endIdx);
  return bytesToHex(buf);
}
