/**
 * Timewave LoRaWAN water meter — trama tipo DLT/645 (Wuhan TimeWave).
 * Codificación: +0x33 con acarreo al ensamblar; decodificación: -0x33 con préstamo y orden de bytes invertido.
 * @see docs/TIMEWAVE-WATER-METER.md
 */
'use strict';

const PREAMBLE = Buffer.from([0xfe, 0xfe, 0xfe, 0xfe]);
const START = 0x68;
const END = 0x16;

/** DI lectura acumulada (éxito 91h) */
const DI_READING = Buffer.from([0x00, 0x00, 0x42, 0x00]);
/** DI corte / reconexión válvula */
const DI_VALVE = Buffer.from([0x04, 0x60, 0xaa, 0x02]);
/** DI cambio intervalo de subida */
const DI_INTERVAL = Buffer.from([0x04, 0x70, 0x01, 0x02]);
/** DI respuesta intervalo OK */
const DI_INTERVAL_ACK = Buffer.from([0x04, 0x50, 0x01, 0x05]);

const PASSWORD_PLAIN = Buffer.from([0x00, 0x00, 0x00, 0x02]);
const OPERATOR_PLAIN = Buffer.from([0x30, 0x30, 0x30, 0x30]);

function dataUnscramble(encoded) {
  const b = Buffer.from(encoded);
  const n = b.length;
  const out = Buffer.alloc(n);
  let borrow = 0;
  for (let i = n - 1; i >= 0; i--) {
    let v = b[i] - 0x33 - borrow;
    if (v < 0) {
      v += 0x100;
      borrow = 1;
    } else {
      borrow = 0;
    }
    out[i] = v & 0xff;
  }
  return Buffer.from(out).reverse();
}

function dataScramble(raw) {
  const b = Buffer.from(raw).reverse();
  const out = Buffer.alloc(b.length);
  let carry = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i] + 0x33 + carry;
    carry = v >> 8;
    out[i] = v & 0xff;
  }
  return out;
}

function checksumFromBody(body) {
  let s = 0;
  for (let i = 0; i < body.length; i++) s = (s + body[i]) & 0xff;
  return s;
}

/** Número de medidor lógico 12 hex (6 B) → bytes en trama (orden inverso). */
function meterNoToFrameBytes(meterNoHex12) {
  const h = String(meterNoHex12 || '').replace(/\s/g, '');
  if (h.length !== 12 || !/^[0-9a-fA-F]{12}$/.test(h)) {
    throw new Error('Timewave: meterNo debe ser 12 caracteres hex (6 bytes), ej. 022025001955');
  }
  return Buffer.from(h, 'hex').reverse();
}

function parseMeterNoFromFrame(sixBytes) {
  return Buffer.from(sixBytes).reverse().toString('hex').toLowerCase();
}

/**
 * BCD en buffer: orden de bytes tal como queda tras dataUnscramble (MSB primero en índice 0).
 */
function bcdToDecimalString(buf, decimals) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const hi = (buf[i] >> 4) & 0x0f;
    const lo = buf[i] & 0x0f;
    s += String(hi) + String(lo);
  }
  if (decimals != null && decimals > 0 && s.length > decimals) {
    const k = s.length - decimals;
    return `${s.slice(0, k)}.${s.slice(k)}`;
  }
  return s;
}

/** Tras dataUnscramble de los 2 bytes de estado del marco. */
function parseStatusWordFromRaw(u16buf) {
  if (!u16buf || u16buf.length < 2) return null;
  const w = (u16buf[0] << 8) | u16buf[1];
  const valveBits = w & 0x03;
  return {
    raw: w,
    valveOpen: valveBits === 0,
    valveClosed: valveBits === 1,
    valveException: valveBits >= 2,
    lowPowerSupply: Boolean(w & 0x04),
    alarm: Boolean(w & 0x08),
    overdraft: Boolean(w & 0x10),
    strongMagnetic: Boolean(w & 0x20),
    forceStatusOn: Boolean(w & 0x40),
  };
}

function parseStatusWord16(statusEncTwoBytes) {
  const u = dataUnscramble(statusEncTwoBytes);
  return parseStatusWordFromRaw(u);
}

function parseErrorByte(b) {
  const err = b & 0xff;
  return {
    raw: err,
    other: Boolean(err & 0x01),
    dataRetrieveFailed: Boolean(err & 0x02),
    badPassword: Boolean(err & 0x04),
    commTimeout: Boolean(err & 0x08),
  };
}

function parseReading91(dataAfterLen) {
  if (!dataAfterLen || dataAfterLen.length < 12) return null;
  const diPlain = dataUnscramble(dataAfterLen.subarray(0, 4));
  if (!diPlain.equals(DI_READING)) return null;
  const readingEnc = dataAfterLen.subarray(4, 8);
  const statusEnc = dataAfterLen.subarray(8, 10);
  const battEnc = dataAfterLen.subarray(10, 11);
  const pctEnc = dataAfterLen.subarray(11, 12);

  const readingRaw = dataUnscramble(readingEnc);
  const cumulativeM3 = bcdToDecimalString(readingRaw, 2);

  const status = parseStatusWord16(statusEnc);

  const b0 = battEnc[0];
  const v = (b0 - 0x33 + 0x100) % 0x100;
  const batteryMv = Math.round(v * 15.37);

  let batteryPercent = null;
  const p0 = pctEnc[0];
  const pu = (p0 - 0x33 + 0x100) % 0x100;
  if (pu !== 0) batteryPercent = pu;

  return {
    timewave_protocol: true,
    timewave_meterNo: null,
    water_cumulative_m3: parseFloat(cumulativeM3) || cumulativeM3,
    water_cumulative_m3_raw: cumulativeM3,
    timewave_status: status,
    battery_voltage_mv: batteryMv,
    battery_percent: batteryPercent,
    timewave_control: 0x91,
    timewave_frame: 'reading',
  };
}

function parseAck94(dataAfterLen) {
  if (!dataAfterLen || dataAfterLen.length < 4) return null;
  const diPlain = dataUnscramble(dataAfterLen.subarray(0, 4));
  if (diPlain.equals(DI_INTERVAL_ACK)) {
    return {
      timewave_protocol: true,
      timewave_frame: 'interval_ack',
      timewave_control: 0x94,
      timewave_di: di.toString('hex'),
    };
  }
  if (dataAfterLen.length >= 12 && diPlain.equals(DI_VALVE)) {
    const readingEnc = dataAfterLen.subarray(4, 8);
    const statusEnc = dataAfterLen.subarray(8, 10);
    const readingRaw = dataUnscramble(readingEnc);
    const cumulativeM3 = bcdToDecimalString(readingRaw, 2);
    const status = parseStatusWord16(statusEnc);
    return {
      timewave_protocol: true,
      timewave_frame: 'valve_ack',
      timewave_control: 0x94,
      water_cumulative_m3: parseFloat(cumulativeM3) || cumulativeM3,
      timewave_status: status,
    };
  }
  return {
    timewave_protocol: true,
    timewave_frame: 'ack_unknown',
    timewave_control: 0x94,
    timewave_di: diPlain.toString('hex'),
  };
}

function parseFailD4(dataAfterLen) {
  if (!dataAfterLen || dataAfterLen.length < 5) return null;
  const diPlain = dataUnscramble(dataAfterLen.subarray(0, 4));
  const errByte = dataAfterLen[4];
  const err = parseErrorByte(errByte);
  const out = {
    timewave_protocol: true,
    timewave_frame: 'command_fail',
    timewave_control: 0xd4,
    timewave_error: err,
    timewave_di: diPlain.toString('hex'),
  };
  if (dataAfterLen.length >= 13 && diPlain.equals(DI_VALVE)) {
    const readingEnc = dataAfterLen.subarray(5, 9);
    const statusEnc = dataAfterLen.subarray(9, 11);
    const readingRaw = dataUnscramble(readingEnc);
    out.water_cumulative_m3 = parseFloat(bcdToDecimalString(readingRaw, 2)) || bcdToDecimalString(readingRaw, 2);
    out.timewave_status = parseStatusWord16(statusEnc);
  }
  return out;
}

/**
 * Decodifica buffer de aplicación LoRaWAN (trama completa incl. preámbulo).
 * @param {Buffer|number[]} input
 * @returns {Record<string, unknown>|null}
 */
function decodeFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 20) return null;
  if (!buf.subarray(0, 4).equals(PREAMBLE)) return null;
  if (buf[4] !== START) return null;
  const meter = buf.subarray(5, 11);
  if (buf[11] !== START) return null;
  const control = buf[12];
  const dataLen = buf[13];
  const endIdx = 14 + dataLen;
  if (buf.length < endIdx + 2 || buf[endIdx + 1] !== END) return null;
  const dataSection = buf.subarray(14, endIdx);
  const cs = buf[endIdx];
  const body = buf.subarray(4, endIdx);
  const csCalc = checksumFromBody(body);
  const checksumOk = csCalc === cs;
  const meterId = parseMeterNoFromFrame(meter);

  let parsed = null;
  if (control === 0x91) {
    parsed = parseReading91(dataSection);
  } else if (control === 0x94) {
    parsed = parseAck94(dataSection);
  } else if (control === 0xd4) {
    parsed = parseFailD4(dataSection);
  } else {
    parsed = {
      timewave_protocol: true,
      timewave_control: control,
      timewave_data_hex: dataSection.toString('hex'),
    };
  }
  if (parsed && typeof parsed === 'object') {
    parsed.timewave_meterNo = meterId;
    parsed.timewave_checksum_ok = checksumOk;
    if (!checksumOk) {
      parsed.timewave_checksum_expected = csCalc;
      parsed.timewave_checksum_got = cs;
    }
  }
  return parsed;
}

function buildFrame(meterNoHex12, control, dataPlainConcat) {
  const meter = meterNoToFrameBytes(meterNoHex12);
  const dataLen = dataPlainConcat.length;
  const parts = [Buffer.from([START]), meter, Buffer.from([START, control, dataLen]), dataPlainConcat];
  const bodyWoPreamble = Buffer.concat(parts);
  const cs = checksumFromBody(bodyWoPreamble);
  return Buffer.concat([PREAMBLE, bodyWoPreamble, Buffer.from([cs, END])]);
}

/** Válvula: on = AAAA, off = BBBB (protocolo). */
function buildValveCommand(meterNoHex12, openValve) {
  const di = dataScramble(DI_VALVE);
  const pwd = dataScramble(PASSWORD_PLAIN);
  const op = dataScramble(OPERATOR_PLAIN);
  const action = openValve ? Buffer.from([0xaa, 0xaa]) : Buffer.from([0xbb, 0xbb]);
  const dataPlain = Buffer.concat([di, pwd, op, action]);
  return buildFrame(meterNoHex12, 0x14, dataPlain);
}

/**
 * Intervalo de subida en minutos 0–9999 (BCD); 0 = no subir; por defecto fabricante 1440.
 */
function buildIntervalCommand(meterNoHex12, minutes) {
  const m = Math.max(0, Math.min(9999, Math.floor(Number(minutes) || 0)));
  const bcdHi = Math.floor(m / 100);
  const bcdLo = m % 100;
  const bcdBuf = Buffer.from([
    ((Math.floor(bcdHi / 10) & 0x0f) << 4) | (bcdHi % 10),
    ((Math.floor(bcdLo / 10) & 0x0f) << 4) | (bcdLo % 10),
  ]);
  const di = dataScramble(DI_INTERVAL);
  const pwd = dataScramble(PASSWORD_PLAIN);
  const op = dataScramble(OPERATOR_PLAIN);
  const minsEnc = dataScramble(bcdBuf);
  const dataPlain = Buffer.concat([di, pwd, op, minsEnc]);
  return buildFrame(meterNoHex12, 0x14, dataPlain);
}

module.exports = {
  decodeFrame,
  buildValveCommand,
  buildIntervalCommand,
  meterNoToFrameBytes,
  parseMeterNoFromFrame,
  dataUnscramble,
  dataScramble,
  DI_READING,
  DI_VALVE,
  DI_INTERVAL,
};
