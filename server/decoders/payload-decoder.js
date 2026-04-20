/**
 * Ejecuta en el servidor el JavaScript de decoder guardado por dispositivo (Plantillas / decode-config).
 * Compatible con plantillas Milesight/ChirpStack: decodeUplink({ bytes, fPort }), Decode(fPort, bytes), Decoder(bytes, port).
 *
 * Corre en vm de Node con timeout; no sustituye un sandbox fuerte — solo código que vos guardéis.
 */
'use strict';

const vm = require('node:vm');
const timewaveWaterMeter = require('./timewave-water-meter');
const eastronSdm230 = require('./eastron-sdm230');
const { milesightWs101Decode } = require('./milesight-ws101');
const { resolveFPortForDecoder } = require('../lib/resolve-app-fport');

const DECODER_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.SYSCOM_DECODER_TIMEOUT_MS || 4000), 200),
  30000
);

const DECODER_DISABLED = String(process.env.SYSCOM_DECODER_DISABLED || '').toLowerCase() === '1';

/** Claves de enlace / radio / payload crudo que no deben perderse al mezclar el resultado del decoder. */
const INGEST_META_KEYS = new Set([
  'deviceId',
  'deviceName',
  'devEUI',
  'devEui',
  'fCnt',
  'fPort',
  'fport',
  'dr',
  'adr',
  'confirmed',
  'payload_b64',
  'payload_hex',
  'gateway_id',
  'gateway_mac',
  'rssi',
  'lora_snr',
  'loraSNR',
  'snr',
  'connectStatus',
  'source',
  'uplink_id',
  'payloadJson',
  'received_at',
  'frequency_hz',
  'data_rate',
  'lorawan_packet_type',
  'devAddr',
  'appEUI',
  'mic',
  'class_type',
  'rxpk_count',
  'freq_mhz',
  'datr',
  'codr',
  'tmst',
]);

function snapshotMeta(properties) {
  const out = {};
  if (!properties || typeof properties !== 'object') return out;
  for (const k of INGEST_META_KEYS) {
    if (properties[k] !== undefined) out[k] = properties[k];
  }
  return out;
}

function reapplyMeta(properties, meta) {
  if (!meta || typeof meta !== 'object') return;
  for (const k of Object.keys(meta)) {
    properties[k] = meta[k];
  }
}

/**
 * @param {Record<string, unknown>} properties
 * @returns {Buffer|null}
 */
function extractPayloadBytes(properties) {
  if (!properties || typeof properties !== 'object') return null;
  const b64 = properties.payload_b64;
  if (b64 != null && String(b64).length > 0) {
    try {
      const buf = Buffer.from(String(b64).replace(/\s/g, ''), 'base64');
      if (buf.length > 0) return buf;
    } catch (_) {}
  }
  const hex = properties.payload_hex;
  if (hex != null && String(hex).length > 0) {
    const h = String(hex).replace(/\s/g, '');
    if (/^[0-9a-fA-F]+$/.test(h) && h.length % 2 === 0) {
      try {
        const buf = Buffer.from(h, 'hex');
        if (buf.length > 0) return buf;
      } catch (_) {}
    }
  }
  return null;
}

/**
 * @param {string} script
 * @param {number} fPortNum
 * @param {Buffer} byteBuffer
 * @returns {Record<string, unknown>|null}
 */
function runDecoderScript(script, fPortNum, byteBuffer) {
  const bytes = Array.from(byteBuffer);

  const sandbox = {
    /** Timewave / DLT645 medidor de agua LoRaWAN (Wuhan TimeWave). */
    Timewave: {
      decodeFrame(bytes) {
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        return timewaveWaterMeter.decodeFrame(buf);
      },
      dataUnscramble: (arr) => Array.from(timewaveWaterMeter.dataUnscramble(Buffer.from(arr))),
      dataScramble: (arr) => Array.from(timewaveWaterMeter.dataScramble(Buffer.from(arr))),
      buildValveCommandHex(meterNo12, openValve) {
        return timewaveWaterMeter.buildValveCommand(meterNo12, openValve).toString('hex');
      },
      buildIntervalCommandHex(meterNo12, minutes) {
        return timewaveWaterMeter.buildIntervalCommand(meterNo12, minutes).toString('hex');
      },
    },
    /** Milesight WS101 (y familia WS con mismo perfil TLV): evita scripts duplicados en plantilla. */
    MilesightWs101: {
      decode(bytes) {
        return milesightWs101Decode(bytes);
      },
    },
    /** Eastron SDM230-LoraWAN (carga activa + Modbus RTU en downlink). Esclavo por defecto 1. */
    Eastron: {
      decodeActiveUpload(bytes) {
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        return eastronSdm230.decodeActiveUpload(buf);
      },
      crc16Modbus(arr) {
        return eastronSdm230.crc16Modbus(Buffer.from(arr));
      },
      buildReadInputRegistersHex(slaveId, startPdu, qty) {
        return eastronSdm230.buildReadInputRegisters(slaveId, startPdu, qty).toString('hex');
      },
      buildReadHoldingRegistersHex(slaveId, startPdu, qty) {
        return eastronSdm230.buildReadHoldingRegisters(slaveId, startPdu, qty).toString('hex');
      },
      buildWriteFloatHoldingHex(slaveId, reg40001Style, floatVal) {
        return eastronSdm230.buildWriteFloatHolding(slaveId, reg40001Style, floatVal).toString('hex');
      },
      buildResetMaxDemandHex(slaveId) {
        return eastronSdm230.buildResetMaxDemand(slaveId).toString('hex');
      },
      buildResetResettableEnergyHex(slaveId) {
        return eastronSdm230.buildResetResettableEnergy(slaveId).toString('hex');
      },
    },
    console: {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: (...a) => console.warn('[decoder]', ...a),
      error: (...a) => console.error('[decoder]', ...a),
    },
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    Uint8Array,
    Int8Array,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Infinity,
    NaN,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    BigInt,
    Reflect,
  };

  const context = vm.createContext(sandbox);

  vm.runInContext(String(script), context, { timeout: DECODER_TIMEOUT_MS });

  let decoded = null;
  if (typeof context.decodeUplink === 'function') {
    const r = context.decodeUplink({ bytes, fPort: fPortNum });
    if (r != null && typeof r === 'object' && !Array.isArray(r) && 'data' in r) {
      decoded = r.data;
    } else {
      decoded = r;
    }
  } else if (typeof context.Decode === 'function') {
    decoded = context.Decode(fPortNum, bytes);
  } else if (typeof context.Decoder === 'function') {
    decoded = context.Decoder(bytes, fPortNum);
  }

  if (decoded == null) return null;
  if (typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  return { ...decoded };
}

/**
 * UC300 / Milesight: si GPIO o contadores solo vienen en `channel_history` (TLV 0x20/0xdc),
 * promueve al raíz desde el último elemento cuando falten (mejora TSL e historial).
 * @param {Record<string, unknown>} root
 */
function promoteUc300GpioFromChannelHistory(root) {
  if (!root || typeof root !== 'object') return;
  const ch = root.channel_history;
  if (!Array.isArray(ch) || ch.length === 0) return;
  const last = ch[ch.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return;
  const re = /^gpio_(input|output)_\d+$|^gpio_counter_\d+$/;
  for (const k of Object.keys(last)) {
    if (!re.test(k)) continue;
    if (root[k] == null || root[k] === '') root[k] = last[k];
  }
}

/**
 * Busca script en device_decode_config y, si hay bytes de payload, fusiona telemetría decodificada.
 * @param {{ getDeviceDecodeConfig: (id: string) => { decoderScript?: string } }} store
 * @param {string} canonicalDeviceId
 * @param {string|number} rawDeviceId
 * @param {Record<string, unknown>} properties
 */
function tryApplyStoredDecoder(store, canonicalDeviceId, rawDeviceId, properties) {
  if (DECODER_DISABLED) return;
  if (!properties || typeof properties !== 'object') return;

  const idCandidates = [
    canonicalDeviceId,
    rawDeviceId,
    properties.devEUI,
    properties.devEui,
    properties.deviceId,
  ]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).trim().toLowerCase());

  const seen = new Set();
  let script = '';
  let cfgUsed = null;
  for (const id of idCandidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cfg = store.getDeviceDecodeConfig(id);
    const s = cfg && cfg.decoderScript != null ? String(cfg.decoderScript).trim() : '';
    if (s) {
      script = cfg.decoderScript;
      cfgUsed = cfg;
      break;
    }
  }

  if (!script || !String(script).trim()) return;

  const buf = extractPayloadBytes(properties);
  if (!buf || buf.length === 0) return;

  const port = resolveFPortForDecoder(properties, cfgUsed);
  if (port == null) {
    console.warn(
      '[Ingest decoder] Sin FPort válido (uplink ni canal en decode-config del dispositivo); omitiendo decoder.'
    );
    return;
  }

  const meta = snapshotMeta(properties);

  try {
    const decoded = runDecoderScript(script, port, buf);
    if (!decoded || Object.keys(decoded).length === 0) return;
    Object.assign(properties, decoded);
    reapplyMeta(properties, meta);
  } catch (e) {
    console.warn('[Ingest decoder]', e.message || e);
  }
}

module.exports = {
  tryApplyStoredDecoder,
  extractPayloadBytes,
  snapshotMeta,
  INGEST_META_KEYS,
  promoteUc300GpioFromChannelHistory,
};
