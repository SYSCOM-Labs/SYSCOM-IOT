/**
 * Eastron SDM230 (y familia similar) — carga activa LoRaWAN + utilidades Modbus RTU
 * para downlinks (FC 0x03 / 0x04 / 0x10).
 * @see docs/EASTRON-SDM230.md
 */
'use strict';

/** CRC-16 Modbus RTU (poly 0xA001, init 0xFFFF), resultado little-endian al final del frame. */
function crc16Modbus(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

/**
 * Nombres de telemetría por posición en la carga activa (Tabla 1 SDM230-LORAWAN).
 * El orden en el payload es el configurado en el medidor; por defecto se asignan por índice 0..n-1.
 */
const ACTIVE_PARAM_KEYS = [
  'voltage_v',
  'frequency_hz',
  'current_a',
  'power_factor',
  'active_power_w',
  'reactive_power_var',
  'apparent_power_va',
  'phase_angle_deg',
  'max_system_power_demand_w',
  'max_import_power_demand_w',
  'max_export_power_demand_w',
  'max_current_demand_a',
  'import_kwh',
  'export_kwh',
  'total_kwh',
  'import_kvarh',
  'export_kvarh',
  'total_kvarh',
  'resettable_total_active_kwh',
  'resettable_total_reactive_kvarh',
];

/**
 * Decodifica trama de subida activa (serial + N + longitud + floats BE + CRC16 LE).
 * @param {Buffer|number[]} input
 * @returns {Record<string, unknown>|null}
 */
function decodeActiveUpload(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 6 + 2) return null;

  const serial = buf.readUInt32BE(0);
  const paramMeta = buf[4];
  const dataLen = buf[5];
  const dataStart = 6;
  if (dataLen < 0 || dataStart + dataLen + 2 > buf.length) return null;

  const payload = buf.subarray(dataStart, dataStart + dataLen);
  const crcPos = dataStart + dataLen;
  const crcGot = buf.readUInt16LE(crcPos);
  const crcCalc = crc16Modbus(buf.subarray(0, crcPos));
  const crcOk = crcCalc === crcGot;

  const out = {
    eastron_protocol: true,
    eastron_model: 'SDM230-LORA',
    eastron_serial: serial,
    /** Número de parámetros en la configuración de subida (según manual). */
    eastron_upload_param_n: paramMeta,
    eastron_data_bytes: dataLen,
    eastron_crc_ok: crcOk,
  };
  if (!crcOk) {
    out.eastron_crc_expected = crcCalc;
    out.eastron_crc_got = crcGot;
  }

  const numFloats = Math.floor(dataLen / 4);
  for (let i = 0; i < numFloats; i++) {
    const v = payload.readFloatBE(i * 4);
    const key = ACTIVE_PARAM_KEYS[i] || `eastron_float_${i}`;
    out[key] = v;
  }

  return out;
}

/**
 * Dirección PDU Modbus holding (40001 = 0): registro 40013 → 12.
 * @param {number} register40001Style e.g. 40013
 */
function holdingAddressPdu(register40001Style) {
  return Math.max(0, Math.floor(register40001Style) - 40001);
}

function appendCrc(frameWithoutCrc) {
  const c = crc16Modbus(frameWithoutCrc);
  return Buffer.concat([frameWithoutCrc, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
}

/**
 * FC 0x04 Read Input Registers (solo PDU + CRC; incluir dirección de esclavo en slaveId).
 * @param {number} slaveId 1-247
 * @param {number} startAddrPdu dirección inicio (ej. 30001 → 0)
 * @param {number} quantity número de registros de 16 bits
 */
function buildReadInputRegisters(slaveId, startAddrPdu, quantity) {
  const s = Math.max(1, Math.min(247, slaveId | 0));
  const pdu = Buffer.alloc(6);
  pdu[0] = s;
  pdu[1] = 0x04;
  pdu.writeUInt16BE(startAddrPdu & 0xffff, 2);
  pdu.writeUInt16BE(Math.max(1, Math.min(125, quantity | 0)), 4);
  return appendCrc(pdu);
}

/**
 * FC 0x03 Read Holding Registers
 */
function buildReadHoldingRegisters(slaveId, startAddrPdu, quantity) {
  const s = Math.max(1, Math.min(247, slaveId | 0));
  const pdu = Buffer.alloc(6);
  pdu[0] = s;
  pdu[1] = 0x03;
  pdu.writeUInt16BE(startAddrPdu & 0xffff, 2);
  pdu.writeUInt16BE(Math.max(1, Math.min(125, quantity | 0)), 4);
  return appendCrc(pdu);
}

/**
 * FC 0x10 Write Multiple Holding Registers — escribe 2 registros (4 B) como float IEEE754 BE.
 */
function buildWriteFloatHolding(slaveId, register40001Style, floatValue) {
  const addr = holdingAddressPdu(register40001Style);
  const s = Math.max(1, Math.min(247, slaveId | 0));
  const fbuf = Buffer.alloc(4);
  fbuf.writeFloatBE(Number(floatValue), 0);
  const qty = 2;
  const byteCount = 4;
  const pdu = Buffer.alloc(7 + byteCount);
  pdu[0] = s;
  pdu[1] = 0x10;
  pdu.writeUInt16BE(addr & 0xffff, 2);
  pdu.writeUInt16BE(qty, 4);
  pdu[6] = byteCount;
  fbuf.copy(pdu, 7);
  return appendCrc(pdu);
}

/**
 * FC 0x10 escribe un par de registros con 2 bytes de datos (big endian).
 */
function buildWriteU16PairHolding(slaveId, startAddrU16, valueU16) {
  const s = Math.max(1, Math.min(247, slaveId | 0));
  const addr = startAddrU16 & 0xffff;
  const qty = 1;
  const byteCount = 2;
  const pdu = Buffer.alloc(7 + byteCount);
  pdu[0] = s;
  pdu[1] = 0x10;
  pdu.writeUInt16BE(addr, 2);
  pdu.writeUInt16BE(qty, 4);
  pdu[6] = byteCount;
  pdu.writeUInt16BE(valueU16 & 0xffff, 7);
  return appendCrc(pdu);
}

/** Reset demanda máxima (manual: 00 00 en registro especial F0 10). */
function buildResetMaxDemand(slaveId) {
  return buildWriteU16PairHolding(slaveId, 0xf010, 0x0000);
}

/** Reset energía reseteable (manual: 00 03). */
function buildResetResettableEnergy(slaveId) {
  return buildWriteU16PairHolding(slaveId, 0xf010, 0x0003);
}

module.exports = {
  crc16Modbus,
  decodeActiveUpload,
  holdingAddressPdu,
  buildReadInputRegisters,
  buildReadHoldingRegisters,
  buildWriteFloatHolding,
  buildWriteU16PairHolding,
  buildResetMaxDemand,
  buildResetResettableEnergy,
  ACTIVE_PARAM_KEYS,
};
