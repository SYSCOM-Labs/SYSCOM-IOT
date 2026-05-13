/**
 * WS101 (Milesight) — decoder listo para Syscom IoT
 *
 * Basado en el codec de ejemplo Milesight 2025, con estos ajustes:
 * - Contrato servidor: `decodeUplink({ bytes, fPort })` → `{ data: { ... } }` (ver `server/payload-decoder.js`).
 * - Sin polyfill `Object.assign` (Node ya lo tiene; el bloque Milesight comentado rompía o ensuciaba el entorno).
 * - `reset_event` / `device_status` leen el byte real del TLV (no el literal `1`).
 * - Fusión de respuestas downlink sin `Object.assign(decoded, …)` (bucle explícito).
 * - Respuesta downlink desconocida: no lanza error (evita caída del decoder en la VM).
 * - `readYesNoStatus` en downlink usa el byte en `offset`, no el literal `1`.
 * - Pulsador: además de `button_event`, expone `press` / `press_raw` / `button_event_status` para el dashboard
 *   (alineado con `expandNestedGatewayTelemetry` en `src/utils/gatewayPayload.js`).
 * - Canal pulsación `0x01 / 0x2E` además de `0xFF / 0x2E` (algunos firmwares).
 *
 * Pegar TODO este archivo en Plantillas → Payload decoder → «Ajustar» → «Guardar plantilla».
 */

var RAW_VALUE = 0;

function decodeUplink(input) {
  var bytes = input.bytes;
  return { data: milesightDeviceDecode(bytes) };
}

/** ChirpStack v3 */
function Decode(fPort, bytes) {
  return milesightDeviceDecode(bytes);
}

/** The Things Network */
function Decoder(bytes, port) {
  return milesightDeviceDecode(bytes);
}

function milesightDeviceDecode(bytes) {
  var decoded = {};
  if (!bytes || bytes.length === 0) return decoded;

  for (var i = 0; i < bytes.length; ) {
    if (i + 1 >= bytes.length) break;
    var channel_id = bytes[i++] & 255;
    var channel_type = bytes[i++] & 255;

    if (channel_id === 0xff && channel_type === 0x01) {
      if (i >= bytes.length) break;
      decoded.ipso_version = readProtocolVersion(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0x09) {
      if (i + 2 > bytes.length) break;
      decoded.hardware_version = readHardwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x0a) {
      if (i + 2 > bytes.length) break;
      decoded.firmware_version = readFirmwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0xff) {
      if (i + 2 > bytes.length) break;
      decoded.tsl_version = readTslVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x08) {
      if (i + 6 > bytes.length) break;
      decoded.sn = readSerialNumber(bytes.slice(i, i + 6));
      i += 6;
    } else if (channel_id === 0xff && channel_type === 0x0f) {
      if (i >= bytes.length) break;
      decoded.lorawan_class = readLoRaWANClass(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0xfe) {
      if (i >= bytes.length) break;
      decoded.reset_event = readResetEvent(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0x0b) {
      if (i >= bytes.length) break;
      decoded.device_status = readDeviceStatus(bytes[i++]);
    } else if (channel_id === 0x01 && channel_type === 0x75) {
      if (i >= bytes.length) break;
      decoded.battery = readUInt8(bytes[i++]);
    } else if ((channel_id === 0xff || channel_id === 0x01) && channel_type === 0x2e) {
      if (i >= bytes.length) break;
      var rawBtn = bytes[i] & 255;
      var stBtn = readButtonEvent(rawBtn);
      decoded.button_event = { status: stBtn, msgid: getRandomIntInclusive(100000, 999999) };
      decoded.button_event_status = stBtn;
      decoded.press_raw = rawBtn;
      if (stBtn === 'short press') decoded.press = 'short';
      else if (stBtn === 'long press') decoded.press = 'long';
      else if (stBtn === 'double press') decoded.press = 'double';
      i += 1;
    } else if (channel_id === 0xfe || channel_id === 0xff) {
      var result = handle_downlink_response(channel_type, bytes, i);
      if (result == null) break;
      var __src = result.data;
      var __k;
      for (__k in __src) {
        if (Object.prototype.hasOwnProperty.call(__src, __k)) decoded[__k] = __src[__k];
      }
      i = result.offset;
    } else {
      break;
    }
  }

  return decoded;
}

function handle_downlink_response(channel_type, bytes, offset) {
  var decoded = {};
  var o = offset;

  switch (channel_type) {
    case 0x03:
      if (o + 2 > bytes.length) return null;
      decoded.reporting_interval = readUInt16LE(bytes.slice(o, o + 2));
      o += 2;
      break;
    case 0x10:
      if (o >= bytes.length) return null;
      decoded.reboot = readYesNoStatus(bytes[o]);
      o += 1;
      break;
    case 0x28:
      if (o >= bytes.length) return null;
      decoded.query_device_status = readYesNoStatus(bytes[o]);
      o += 1;
      break;
    case 0x2f:
      if (o >= bytes.length) return null;
      decoded.led_indicator_enable = readEnableStatus(bytes[o]);
      o += 1;
      break;
    case 0x3e:
      if (o >= bytes.length) return null;
      decoded.buzzer_enable = readEnableStatus(bytes[o]);
      o += 1;
      break;
    case 0x74:
      if (o >= bytes.length) return null;
      decoded.double_click_enable = readEnableStatus(bytes[o]);
      o += 1;
      break;
    default:
      return null;
  }

  return { data: decoded, offset: o };
}

function readProtocolVersion(bytes) {
  var major = (bytes & 0xf0) >> 4;
  var minor = bytes & 0x0f;
  return 'v' + major + '.' + minor;
}

function readHardwareVersion(bytes) {
  var major = (bytes[0] & 0xff).toString(16);
  var minor = (bytes[1] & 0xff) >> 4;
  return 'v' + major + '.' + minor;
}

function readFirmwareVersion(bytes) {
  var major = (bytes[0] & 0xff).toString(16);
  var minor = (bytes[1] & 0xff).toString(16);
  return 'v' + major + '.' + minor;
}

function readTslVersion(bytes) {
  var major = bytes[0] & 0xff;
  var minor = bytes[1] & 0xff;
  return 'v' + major + '.' + minor;
}

function readSerialNumber(bytes) {
  var temp = [];
  for (var idx = 0; idx < bytes.length; idx++) {
    temp.push(('0' + (bytes[idx] & 0xff).toString(16)).slice(-2));
  }
  return temp.join('');
}

function readLoRaWANClass(type) {
  var class_map = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
  return getValue(class_map, type);
}

function readResetEvent(status) {
  var status_map = { 0: 'normal', 1: 'reset' };
  return getValue(status_map, status);
}

function readDeviceStatus(status) {
  var status_map = { 0: 'off', 1: 'on' };
  return getValue(status_map, status);
}

function readButtonEvent(status) {
  var status_map = { 1: 'short press', 2: 'long press', 3: 'double press' };
  return getValue(status_map, status);
}

function readEnableStatus(status) {
  var status_map = { 0: 'disable', 1: 'enable' };
  return getValue(status_map, status);
}

function readYesNoStatus(status) {
  var status_map = { 0: 'no', 1: 'yes' };
  return getValue(status_map, status);
}

function getRandomIntInclusive(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function readUInt8(bytes) {
  return bytes & 0xff;
}

function readUInt16LE(bytes) {
  var value = (bytes[1] << 8) + bytes[0];
  return value & 0xffff;
}

function getValue(map, key) {
  if (RAW_VALUE) return key;
  var value = map[key];
  if (!value) value = 'unknown';
  return value;
}
