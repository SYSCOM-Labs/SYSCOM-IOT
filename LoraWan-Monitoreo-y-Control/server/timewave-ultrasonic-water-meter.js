/**
 * Timewave LoRaWAN ultrasonic water meter — CJ/T 188-2004 (Wuhan TimeWave V1.0.2).
 * Meter type T = 11H. No second 0x68, data field is NOT +0x33 (unlike mechanical DLT/645).
 * @see docs/TIMEWAVE-WATER-METER.md
 */
'use strict';

const START = 0x68;
const END = 0x16;
const METER_TYPE_ULTRASONIC = 0x11;
const METER_TYPE_COLD = 0x10;

/** DI as transmitted (document order, not swapped). */
const DI_CUMULATIVE = Buffer.from([0x90, 0x97]);
const DI_VALVE = Buffer.from([0xa0, 0x17]);
const DI_UPLOAD_PARAMS = Buffer.from([0xa1, 0x19]);
const DI_READ_ADDRESS = Buffer.from([0x8a, 0x01]);
const DI_WRITE_ADDRESS = Buffer.from([0xa0, 0x18]);
const DI_WRITE_BASE = Buffer.from([0xa0, 0x19]);
const DI_PASSTHROUGH = Buffer.from([0x83, 0x02]);

const VALVE_OPEN = 0x55;
const VALVE_CLOSE = 0x99;
const VALVE_CANCEL_CONTROL = 0x77;
const VALVE_ENABLE_CONTROL = 0x88;
const VALVE_ALARM_CLOSE = 0x33;

const VOLUME_UNIT_TO_M3 = {
  0x29: 0.00001,
  0x2a: 0.0001,
  0x2b: 0.001,
  0x2c: 0.01,
  0x2d: 0.1,
  0x2e: 1,
};

const FLOW_UNIT_TO_M3H = {
  0x32: 1e-7,
  0x33: 1e-6,
  0x34: 1e-5,
  0x35: 1e-4,
  0x36: 1e-3,
  0x37: 1e-2,
  0x38: 1e-1,
  0x39: 1,
};

/** Medidor de ejemplo de la ficha V1.0.2. */
const TIMEWAVE_ULTRASONIC_EXAMPLE_METER_NO = '00022026004140';

function checksumFromStart(buf, endExclusive) {
  let s = 0;
  for (let i = 0; i < endExclusive; i += 1) s = (s + buf[i]) & 0xff;
  return s;
}

function normalizeMeterNo14(raw) {
  const h = String(raw || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return h.length === 14 ? h : null;
}

function meterNoToAddressBytes(meterNoHex14) {
  const h = normalizeMeterNo14(meterNoHex14);
  if (!h) {
    throw new Error('Timewave ultrasónico: meterNo debe ser 14 hex (7 B), ej. 00022026004140');
  }
  return Buffer.from(h, 'hex').reverse();
}

function parseMeterNoFromAddress(sevenBytes) {
  return Buffer.from(sevenBytes).reverse().toString('hex').toLowerCase();
}

function looksLikeUltrasonicFrame(buf) {
  if (!buf || buf.length < 13) return false;
  if (buf[0] !== START) return false;
  if (buf[1] !== METER_TYPE_ULTRASONIC && buf[1] !== METER_TYPE_COLD) return false;
  const dataLen = buf[10];
  if (!Number.isFinite(dataLen) || dataLen < 0 || dataLen > 200) return false;
  const csIdx = 11 + dataLen;
  if (buf.length < csIdx + 2) return false;
  if (buf[csIdx + 1] !== END) return false;
  return true;
}

function looksLikeUltrasonicHex(hex) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '');
  if (!h || h.length % 2 !== 0 || h.length < 26 || !/^[0-9a-fA-F]+$/.test(h)) return false;
  try {
    return looksLikeUltrasonicFrame(Buffer.from(h, 'hex'));
  } catch {
    return false;
  }
}

function parseStatusCjt188(twoBytes) {
  if (!twoBytes || twoBytes.length < 2) return null;
  const b1 = twoBytes[0];
  const b2 = twoBytes[1];
  const valveBits = b1 & 0x03;
  return {
    raw: (b1 << 8) | b2,
    byte1: b1,
    byte2: b2,
    valveOpen: valveBits === 0,
    valveClosed: valveBits === 1,
    valveException: valveBits === 3 || valveBits === 2,
    lowPowerSupply: Boolean(b1 & 0x04),
    batteryLevelAlarm: Boolean(b2 & 0x01),
    emptyPipe: Boolean(b2 & 0x02),
    reverseFlow: Boolean(b2 & 0x04),
    overRange: Boolean(b2 & 0x08),
    waterTemperatureAlarm: Boolean(b2 & 0x10),
    eeAlarm: Boolean(b2 & 0x20),
  };
}

function volumeToM3(rawU32, unit) {
  const factor = VOLUME_UNIT_TO_M3[unit];
  if (factor == null) return rawU32;
  return rawU32 * factor;
}

function parseLeU16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

function parseLeU32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function parseCumulative9097(data) {
  if (!data || data.length < 31) return null;
  if (!data.subarray(0, 2).equals(DI_CUMULATIVE)) return null;
  const seq = data[2];
  const volUnit = data[3];
  const currentRaw = parseLeU32(data, 4);
  const zeroFrozenRaw = parseLeU32(data, 8);
  const settlementRaw = parseLeU32(data, 12);
  const reverseRaw = parseLeU32(data, 16);
  const flowUnit = data[20];
  const flowRaw = parseLeU16(data, 21);
  const reverseDir = Boolean(flowRaw & 0x8000);
  const flowMag = flowRaw & 0x7fff;
  const flowFactor = FLOW_UNIT_TO_M3H[flowUnit];
  const tempRaw = parseLeU16(data, 23);
  const pressureRaw = parseLeU16(data, 25);
  const usSignal = parseLeU16(data, 27);
  const status = parseStatusCjt188(data.subarray(29, 31));
  return {
    timewave_protocol: true,
    timewave_family: 'ultrasonic_cjt188',
    timewave_meter_type: METER_TYPE_ULTRASONIC,
    timewave_frame: 'reading',
    timewave_control: 0x81,
    timewave_di: '9097',
    timewave_seq: seq,
    volume_unit: volUnit,
    water_cumulative_m3: volumeToM3(currentRaw, volUnit),
    water_cumulative_raw: currentRaw,
    water_zero_frozen_m3: volumeToM3(zeroFrozenRaw, volUnit),
    water_settlement_m3: volumeToM3(settlementRaw, volUnit),
    water_reverse_cumulative_m3: volumeToM3(reverseRaw, volUnit),
    flow_unit: flowUnit,
    water_flow_m3h: flowFactor != null ? flowMag * flowFactor : flowMag,
    water_flow_reverse: reverseDir,
    temperature_c: tempRaw / 100,
    pressure_mpa: pressureRaw / 1000,
    ultrasonic_signal: usSignal,
    timewave_status: status,
  };
}

function parseValveAck(data, control) {
  if (!data || data.length < 4) return null;
  if (!data.subarray(0, 2).equals(DI_VALVE)) return null;
  const statusByte = data.length >= 4 ? data[3] : 0;
  const status = parseStatusCjt188(Buffer.from([statusByte, 0]));
  return {
    timewave_protocol: true,
    timewave_family: 'ultrasonic_cjt188',
    timewave_frame: control === 0xc4 ? 'valve_nack' : 'valve_ack',
    timewave_control: control,
    timewave_di: 'a017',
    timewave_seq: data[2],
    timewave_status: status,
  };
}

function parseUploadParams(data, control) {
  if (!data || data.length < 3) return null;
  if (!data.subarray(0, 2).equals(DI_UPLOAD_PARAMS)) return null;
  const out = {
    timewave_protocol: true,
    timewave_family: 'ultrasonic_cjt188',
    timewave_frame: control === 0xc2 ? 'upload_params_nack' : 'upload_params',
    timewave_control: control,
    timewave_di: 'a119',
    timewave_seq: data[2],
  };
  if (data.length >= 12) {
    out.report_interval_h = data[5];
    out.report_switch = data[6] === 0x01;
    out.increment_freeze_min = data[9];
    out.increment_report_interval_h = data[10];
    out.increment_report_switch = data[11] === 0x01;
  }
  return out;
}

function decodeFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!looksLikeUltrasonicFrame(buf)) return null;
  const meterType = buf[1];
  const addr = buf.subarray(2, 9);
  const control = buf[9];
  const dataLen = buf[10];
  const data = buf.subarray(11, 11 + dataLen);
  const csIdx = 11 + dataLen;
  const cs = buf[csIdx];
  const csCalc = checksumFromStart(buf, csIdx);
  const checksumOk = cs === csCalc;
  const meterId = parseMeterNoFromAddress(addr);

  let parsed = null;
  if (control === 0x81 && data.subarray(0, 2).equals(DI_CUMULATIVE)) {
    parsed = parseCumulative9097(data);
  } else if (control === 0xc1 && data.subarray(0, 2).equals(DI_CUMULATIVE)) {
    parsed = {
      timewave_protocol: true,
      timewave_family: 'ultrasonic_cjt188',
      timewave_frame: 'reading_nack',
      timewave_control: control,
      timewave_di: '9097',
      timewave_seq: data[2],
    };
  } else if ((control === 0x84 || control === 0xc4) && data.subarray(0, 2).equals(DI_VALVE)) {
    parsed = parseValveAck(data, control);
  } else if (
    (control === 0x82 || control === 0xc2 || control === 0x81) &&
    data.subarray(0, 2).equals(DI_UPLOAD_PARAMS)
  ) {
    parsed = parseUploadParams(data, control);
  } else {
    parsed = {
      timewave_protocol: true,
      timewave_family: 'ultrasonic_cjt188',
      timewave_control: control,
      timewave_data_hex: data.toString('hex'),
    };
    if (data.length >= 2) parsed.timewave_di = data.subarray(0, 2).toString('hex');
    if (data.length >= 3) parsed.timewave_seq = data[2];
  }

  if (parsed && typeof parsed === 'object') {
    parsed.timewave_meterNo = meterId;
    parsed.timewave_meter_type = meterType;
    parsed.timewave_checksum_ok = checksumOk;
    if (!checksumOk) {
      parsed.timewave_checksum_expected = csCalc;
      parsed.timewave_checksum_got = cs;
    }
  }
  return parsed;
}

function buildFrame(meterNoHex14, meterType, control, dataField) {
  const addr = meterNoToAddressBytes(meterNoHex14);
  const data = Buffer.isBuffer(dataField) ? dataField : Buffer.from(dataField);
  const head = Buffer.concat([
    Buffer.from([START, meterType]),
    addr,
    Buffer.from([control, data.length]),
    data,
  ]);
  const cs = checksumFromStart(head, head.length);
  return Buffer.concat([head, Buffer.from([cs, END])]);
}

function buildValveCommand(meterNoHex14, actionByte, seq) {
  const s = seq == null ? 0 : Math.max(0, Math.min(255, Math.floor(Number(seq))));
  const data = Buffer.concat([DI_VALVE, Buffer.from([s, actionByte & 0xff])]);
  return buildFrame(meterNoHex14, METER_TYPE_ULTRASONIC, 0x04, data);
}

function buildOpenValveCommand(meterNoHex14, seq) {
  return buildValveCommand(meterNoHex14, VALVE_OPEN, seq);
}

function buildCloseValveCommand(meterNoHex14, seq) {
  return buildValveCommand(meterNoHex14, VALVE_CLOSE, seq);
}

/**
 * A119: intervalo de reporte acumulado en horas (default 24) y freeze de incremento en minutos.
 */
function buildUploadParamsCommand(meterNoHex14, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const seq = o.seq == null ? 0 : Math.max(0, Math.min(255, Math.floor(Number(o.seq))));
  const reportH = o.reportIntervalHours == null ? 24 : Math.max(0, Math.min(255, Math.floor(Number(o.reportIntervalHours))));
  const reportOn = o.reportSwitch === false ? 0x00 : 0x01;
  const freezeMin =
    o.incrementFreezeMinutes == null ? 0x3c : Math.max(0, Math.min(255, Math.floor(Number(o.incrementFreezeMinutes))));
  const incReportH =
    o.incrementReportIntervalHours == null
      ? 8
      : Math.max(0, Math.min(255, Math.floor(Number(o.incrementReportIntervalHours))));
  const incOn = o.incrementReportSwitch ? 0x01 : 0x00;
  const data = Buffer.concat([
    DI_UPLOAD_PARAMS,
    Buffer.from([seq]),
    DI_CUMULATIVE,
    Buffer.from([reportH, reportOn]),
    Buffer.from([0x90, 0x98]),
    Buffer.from([freezeMin, incReportH, incOn]),
  ]);
  return buildFrame(meterNoHex14, METER_TYPE_ULTRASONIC, 0x02, data);
}

function rewriteDownlinkHex(hex, meterNoHex14) {
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h || h.length % 2 !== 0 || !/^[0-9a-f]+$/.test(h)) return null;
  let buf;
  try {
    buf = Buffer.from(h, 'hex');
  } catch {
    return null;
  }
  if (!looksLikeUltrasonicFrame(buf)) return null;
  const dataLen = buf[10];
  const csIdx = 11 + dataLen;
  const out = Buffer.from(buf);
  const meter = normalizeMeterNo14(meterNoHex14);
  if (meter) {
    meterNoToAddressBytes(meter).copy(out, 2);
  }
  out[csIdx] = checksumFromStart(out, csIdx);
  return out.toString('hex');
}

module.exports = {
  decodeFrame,
  buildFrame,
  buildValveCommand,
  buildOpenValveCommand,
  buildCloseValveCommand,
  buildUploadParamsCommand,
  rewriteDownlinkHex,
  looksLikeUltrasonicFrame,
  looksLikeUltrasonicHex,
  normalizeMeterNo14,
  parseMeterNoFromAddress,
  meterNoToAddressBytes,
  TIMEWAVE_ULTRASONIC_EXAMPLE_METER_NO,
  METER_TYPE_ULTRASONIC,
  METER_TYPE_COLD,
  VALVE_OPEN,
  VALVE_CLOSE,
  VALVE_CANCEL_CONTROL,
  VALVE_ENABLE_CONTROL,
  VALVE_ALARM_CLOSE,
  DI_CUMULATIVE,
  DI_VALVE,
  DI_UPLOAD_PARAMS,
};
