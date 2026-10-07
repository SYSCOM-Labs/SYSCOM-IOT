/** Marca TimeWave en plantilla, modelo o productModel (`Timewave · Water-Meter-LoRa`). */
export function isTimewaveBrandLabel(...parts) {
  return parts.some((p) => /timewave/i.test(String(p || '')));
}

export function isTimewaveWaterMeterLoraLabel(...parts) {
  return parts.some((p) => {
    const s = String(p || '')
      .trim()
      .toLowerCase();
    if (!s || s.includes('ultrasonic')) return false;
    return s === 'water-meter-lora' || /(^|[·\s])water-meter-lora$/.test(s);
  });
}

export function isTimewaveUltrasonicLabel(...parts) {
  return parts.some((p) => /ultrasonic-water-meter/i.test(String(p || '')));
}

/** Número de medidor TimeWave mecánico: 12 hex (6 BCD). El DevEUI (16 hex) no vale. */
export function normalizeTimewaveMeterNo12(raw) {
  const h = String(raw || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return h.length === 12 ? h : null;
}

/** Número de medidor TimeWave ultrasónico: 14 hex (7 B). */
export function normalizeTimewaveMeterNo14(raw) {
  const h = String(raw || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return h.length === 14 ? h : null;
}

function firstNormalizedMeterNo12(values) {
  for (const v of values) {
    const n = normalizeTimewaveMeterNo12(v);
    if (n) return n;
  }
  return null;
}

function firstNormalizedMeterNo14(values) {
  for (const v of values) {
    const n = normalizeTimewaveMeterNo14(v);
    if (n) return n;
  }
  return null;
}

/** Extrae el n.º de medidor (bytes 5–10 invertidos) de una trama DLT/645 Timewave. */
export function meterNoFromTimewavePayloadHex(hex) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h || h.length < 40 || !/^[0-9a-f]+$/.test(h)) return null;
  if (!h.startsWith('fefefefe') || h.slice(8, 10) !== '68' || h.slice(22, 24) !== '68') return null;
  const raw = h.slice(10, 22);
  let out = '';
  for (let i = 5; i >= 0; i -= 1) out += raw.slice(i * 2, i * 2 + 2);
  return normalizeTimewaveMeterNo12(out);
}

/** Extrae el n.º 14 hex (address 7 B LE) de una trama CJ/T 188 ultrasónica. */
export function meterNoFromTimewaveUltrasonicPayloadHex(hex) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h || h.length < 26 || !/^[0-9a-f]+$/.test(h)) return null;
  if (!h.startsWith('68')) return null;
  const t = parseInt(h.slice(2, 4), 16);
  if (t !== 0x10 && t !== 0x11) return null;
  if (h.slice(-2) !== '16') return null;
  const raw = h.slice(4, 18);
  let out = '';
  for (let i = 6; i >= 0; i -= 1) out += raw.slice(i * 2, i * 2 + 2);
  return normalizeTimewaveMeterNo14(out);
}

/**
 * @param {Record<string, unknown> | null | undefined} deviceRow
 * @returns {string | null}
 */
export function pickTimewaveMeterNoFromDevice(deviceRow) {
  if (!deviceRow || typeof deviceRow !== 'object') return null;
  const p =
    deviceRow.properties && typeof deviceRow.properties === 'object' ? deviceRow.properties : {};
  const fieldVals = [
    deviceRow.timewaveMeterNo,
    deviceRow.timewave_meterNo,
    p.timewaveMeterNo,
    p.timewave_meterNo,
    deviceRow.meterNumber,
    p.meterNumber,
    deviceRow.meterNo,
    p.meterNo,
  ];
  const fromFields12 = firstNormalizedMeterNo12(fieldVals);
  if (fromFields12) return fromFields12;
  const fromFields14 = firstNormalizedMeterNo14(fieldVals);
  if (fromFields14) return fromFields14;
  const fromPayload =
    meterNoFromTimewavePayloadHex(deviceRow.payload_hex) ||
    meterNoFromTimewavePayloadHex(deviceRow.payloadHex) ||
    meterNoFromTimewavePayloadHex(p.payload_hex) ||
    meterNoFromTimewavePayloadHex(p.payloadHex);
  if (fromPayload) return fromPayload;
  const fromUs =
    meterNoFromTimewaveUltrasonicPayloadHex(deviceRow.payload_hex) ||
    meterNoFromTimewaveUltrasonicPayloadHex(deviceRow.payloadHex) ||
    meterNoFromTimewaveUltrasonicPayloadHex(p.payload_hex) ||
    meterNoFromTimewaveUltrasonicPayloadHex(p.payloadHex);
  if (fromUs) return fromUs;
  return (
    firstNormalizedMeterNo12([
      deviceRow.deviceSerialHex,
      p.deviceSerialHex,
      deviceRow.serialHex,
      p.serialHex,
    ]) ||
    firstNormalizedMeterNo14([
      deviceRow.deviceSerialHex,
      p.deviceSerialHex,
      deviceRow.serialHex,
      p.serialHex,
    ])
  );
}

function pickTimewaveDownlinkFPortFromDevice(deviceRow) {
  if (!deviceRow || typeof deviceRow !== 'object') return null;
  const p =
    deviceRow.properties && typeof deviceRow.properties === 'object' ? deviceRow.properties : {};
  const raw = deviceRow.fPort ?? deviceRow.fport ?? p.fPort ?? p.fport;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 223 || n === 85) return null;
  return n;
}

export function looksLikeTimewaveDeviceRow(deviceRow, deviceModel) {
  if (/timewave/i.test(String(deviceModel || ''))) return true;
  if (!deviceRow || typeof deviceRow !== 'object') return false;
  if (pickTimewaveMeterNoFromDevice(deviceRow)) return true;
  const p =
    deviceRow.properties && typeof deviceRow.properties === 'object' ? deviceRow.properties : {};
  const hex = String(deviceRow.payload_hex || deviceRow.payloadHex || p.payload_hex || p.payloadHex || '')
    .replace(/\s/g, '')
    .toLowerCase();
  return hex.startsWith('fefefefe') || /^68(10|11)/.test(hex);
}

export function pickTimewaveDownlinkFPort(deviceRow, deviceModel) {
  if (!looksLikeTimewaveDeviceRow(deviceRow, deviceModel)) return null;
  return pickTimewaveDownlinkFPortFromDevice(deviceRow) || 2;
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

function checksumFromStart(bytes, endExclusive) {
  let s = 0;
  for (let i = 0; i < endExclusive; i += 1) s = (s + bytes[i]) & 0xff;
  return s;
}

function rewriteTimewaveUltrasonicDownlinkHex(hex, meterNoHex14) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h || h.length % 2 !== 0 || !/^[0-9a-f]+$/.test(h) || h.length < 26) return null;
  if (h.startsWith('fefefefe')) return null;
  const buf = hexToBytes(h);
  if (buf[0] !== 0x68) return null;
  if (buf[1] !== 0x10 && buf[1] !== 0x11) return null;
  const dataLen = buf[10];
  const csIdx = 11 + dataLen;
  if (buf.length < csIdx + 2 || buf[csIdx + 1] !== 0x16) return null;
  const meter = normalizeTimewaveMeterNo14(meterNoHex14);
  if (meter) {
    for (let i = 0; i < 7; i += 1) {
      buf[2 + i] = parseInt(meter.slice((6 - i) * 2, (6 - i) * 2 + 2), 16);
    }
  }
  buf[csIdx] = checksumFromStart(buf, csIdx);
  return bytesToHex(buf);
}

/**
 * Reescribe trama TimeWave: nº de medidor y acción AAAA/BBBB → DDDD/EEEE (mecánico),
 * o address 14 hex (ultrasónico CJ/T 188).
 * @param {string} hex
 * @param {string | null | undefined} meterNoHex
 * @returns {string | null}
 */
export function rewriteTimewaveDownlinkHex(hex, meterNoHex) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h || h.length % 2 !== 0 || !/^[0-9a-f]+$/.test(h)) return null;
  if (h.startsWith('fefefefe')) {
    if (h.length < 40) return null;
    const buf = hexToBytes(h);
    if (buf[4] !== 0x68 || buf[11] !== 0x68) return null;
    const dataLen = buf[13];
    const endIdx = 14 + dataLen;
    if (buf.length < endIdx + 2 || buf[endIdx + 1] !== 0x16) return null;
    const meter = normalizeTimewaveMeterNo12(meterNoHex);
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
  return rewriteTimewaveUltrasonicDownlinkHex(h, meterNoHex);
}
