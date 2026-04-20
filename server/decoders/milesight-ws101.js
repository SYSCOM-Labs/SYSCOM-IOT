'use strict';

/**
 * Decoder TLV Milesight WS101 (LoRaWAN 1.0.x), alineado con
 * https://github.com/Milesight-IoT/SensorDecoders/blob/main/ws-series/ws101/ws101-decoder.js
 *
 * Diferencias frente a copias antiguas: sin avance arbitrario de 1 byte en tipos desconocidos (break);
 * respuesta downlink desconocida no rompe todo el parseo; soporte 0x01+0x2E además de 0xFF+0x2E para evento de botón.
 */

const RAW_VALUE = 0;

function readProtocolVersion(b) {
  const major = (b & 0xf0) >> 4;
  const minor = b & 0x0f;
  return `v${major}.${minor}`;
}

function readHardwareVersion(slice) {
  const major = (slice[0] & 0xff).toString(16);
  const minor = (slice[1] & 0xff) >> 4;
  return `v${major}.${minor}`;
}

function readFirmwareVersion(slice) {
  const major = (slice[0] & 0xff).toString(16);
  const minor = (slice[1] & 0xff).toString(16);
  return `v${major}.${minor}`;
}

function readTslVersion(slice) {
  const major = slice[0] & 0xff;
  const minor = slice[1] & 0xff;
  return `v${major}.${minor}`;
}

function readSerialNumber(slice) {
  const temp = [];
  for (let idx = 0; idx < slice.length; idx++) {
    temp.push(`0${(slice[idx] & 0xff).toString(16)}`.slice(-2));
  }
  return temp.join('');
}

function readLoRaWANClass(type) {
  const classMap = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
  return getValue(classMap, type);
}

function readResetEvent(status) {
  return getValue({ 0: 'normal', 1: 'reset' }, status);
}

function readDeviceStatus(status) {
  return getValue({ 0: 'off', 1: 'on' }, status);
}

function readButtonEvent(status) {
  const statusMap = { 1: 'short press', 2: 'long press', 3: 'double press' };
  return getValue(statusMap, status);
}

function readEnableStatus(status) {
  return getValue({ 0: 'disable', 1: 'enable' }, status);
}

function readYesNoStatus(status) {
  return getValue({ 0: 'no', 1: 'yes' }, status);
}

function getRandomIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function readUInt8(b) {
  return b & 0xff;
}

function readUInt16LE(slice) {
  const value = (slice[1] << 8) + slice[0];
  return value & 0xffff;
}

function getValue(map, key) {
  if (RAW_VALUE) return key;
  const value = map[key];
  if (!value) return 'unknown';
  return value;
}

function handleDownlinkResponse(channelType, bytes, offset) {
  let o = offset;
  const decoded = {};
  switch (channelType) {
    case 0x03:
      decoded.reporting_interval = readUInt16LE(bytes.slice(o, o + 2));
      o += 2;
      break;
    case 0x10:
      decoded.reboot = readYesNoStatus(1);
      o += 1;
      break;
    case 0x28:
      decoded.query_device_status = readYesNoStatus(1);
      o += 1;
      break;
    case 0x2f:
      decoded.led_indicator_enable = readEnableStatus(bytes[o]);
      o += 1;
      break;
    case 0x3e:
      decoded.buzzer_enable = readEnableStatus(bytes[o]);
      o += 1;
      break;
    case 0x74:
      decoded.double_click_enable = readEnableStatus(bytes[o]);
      o += 1;
      break;
    default:
      return { unknown: true, data: {}, offset: o };
  }
  return { unknown: false, data: decoded, offset: o };
}

function attachButtonAliases(decoded) {
  if (!decoded || typeof decoded !== 'object') return;
  const be = decoded.button_event;
  if (be && typeof be === 'object' && !Array.isArray(be) && be.status != null) {
    decoded.button_event_status = be.status;
    if (decoded.press == null) decoded.press = be.status;
  }
}

/**
 * @param {number[]|Buffer|Uint8Array} input
 * @returns {Record<string, unknown>}
 */
function milesightWs101Decode(input) {
  const bytes = Array.isArray(input) ? input : Array.from(Buffer.isBuffer(input) ? input : Buffer.from(input));
  const decoded = {};

  for (let i = 0; i < bytes.length; ) {
    const channelId = bytes[i++];
    const channelType = bytes[i++];

    if (channelId === 0xff && channelType === 0x01) {
      decoded.ipso_version = readProtocolVersion(bytes[i]);
      i += 1;
    } else if (channelId === 0xff && channelType === 0x09) {
      decoded.hardware_version = readHardwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channelId === 0xff && channelType === 0x0a) {
      decoded.firmware_version = readFirmwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channelId === 0xff && channelType === 0xff) {
      decoded.tsl_version = readTslVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channelId === 0xff && channelType === 0x08) {
      decoded.sn = readSerialNumber(bytes.slice(i, i + 6));
      i += 6;
    } else if (channelId === 0xff && channelType === 0x0f) {
      decoded.lorawan_class = readLoRaWANClass(bytes[i]);
      i += 1;
    } else if (channelId === 0xff && channelType === 0xfe) {
      decoded.reset_event = readResetEvent(bytes[i]);
      i += 1;
    } else if (channelId === 0xff && channelType === 0x0b) {
      decoded.device_status = readDeviceStatus(bytes[i]);
      i += 1;
    } else if (channelId === 0x01 && channelType === 0x75) {
      decoded.battery = readUInt8(bytes[i]);
      i += 1;
    } else if (
      (channelId === 0xff || channelId === 0x01) &&
      channelType === 0x2e &&
      i < bytes.length
    ) {
      decoded.button_event = {
        status: readButtonEvent(bytes[i]),
        msgid: getRandomIntInclusive(100000, 999999),
      };
      i += 1;
    } else if (channelId === 0xfe || channelId === 0xff) {
      const result = handleDownlinkResponse(channelType, bytes, i);
      if (result.unknown) {
        break;
      }
      Object.assign(decoded, result.data);
      i = result.offset;
    } else {
      break;
    }
  }

  attachButtonAliases(decoded);
  return decoded;
}

module.exports = { milesightWs101Decode };
