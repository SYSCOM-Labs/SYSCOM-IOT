/**
 * Decoder WS101 (Milesight LoRaWAN).
 * Basado en github.com/Milesight-IoT/SensorDecoders (ws-series/ws101/ws101-decoder.js):
 * TLV 0xFF/* meta, batería 0x01/0x75, pulsación 0xFF/0x2E, respuestas a downlink 0xFE|0xFF + tipo.
 * Ajustes: sin polyfill Object.assign; tipos de respuesta downlink desconocidos no desincronizan el buffer;
 * reset_event / device_status leen el byte del payload; 0x01/0x2E como pulsación (compat. firmware).
 *
 * Contrato servidor: decodeUplink({ bytes, fPort }) → { data } (ver server/payload-decoder.js).
 * El FPort de downlink lo define la plantilla (campo channel → device_decode_config).
 */
export const WS101_DECODER_SCRIPT = `
// ws101-decoder (Milesight; FPort app típ. 85 para downlinks)
function decodeUplink(input) {
  var bytes = input.bytes;
  return { data: milesightDeviceDecode(bytes) };
}

function milesightDeviceDecode(bytes) {
  var decoded = {};
  if (!bytes || bytes.length === 0) return decoded;

  for (var i = 0; i < bytes.length; ) {
    if (i + 1 >= bytes.length) break;
    var channel_id = bytes[i++] & 255;
    var channel_type = bytes[i++] & 255;

    if (channel_id === 255 && channel_type === 1) {
      if (i >= bytes.length) break;
      decoded.ipso_version = readProtocolVersion(bytes[i++]);
    } else if (channel_id === 255 && channel_type === 9) {
      if (i + 2 > bytes.length) break;
      decoded.hardware_version = readHardwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 255 && channel_type === 10) {
      if (i + 2 > bytes.length) break;
      decoded.firmware_version = readFirmwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 255 && channel_type === 255) {
      if (i + 2 > bytes.length) break;
      decoded.tsl_version = readTslVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 255 && channel_type === 8) {
      if (i + 6 > bytes.length) break;
      decoded.sn = readSerialNumber(bytes.slice(i, i + 6));
      i += 6;
    } else if (channel_id === 255 && channel_type === 15) {
      if (i >= bytes.length) break;
      decoded.lorawan_class = readLoRaWANClass(bytes[i++]);
    } else if (channel_id === 255 && channel_type === 254) {
      if (i >= bytes.length) break;
      decoded.reset_event = readResetEvent(bytes[i++]);
    } else if (channel_id === 255 && channel_type === 11) {
      if (i >= bytes.length) break;
      decoded.device_status = readDeviceStatus(bytes[i++]);
    } else if (channel_id === 1 && channel_type === 117) {
      if (i >= bytes.length) break;
      decoded.battery = readUInt8(bytes[i++]);
    } else if ((channel_id === 255 || channel_id === 1) && channel_type === 46) {
      if (i >= bytes.length) break;
      var rawBtn = bytes[i] & 255;
      var stBtn = readButtonEvent(rawBtn);
      decoded.button_event = {
        status: stBtn,
        raw: rawBtn,
        msgid: getRandomIntInclusive(100000, 999999),
      };
      if (stBtn === 'short press') decoded.press = 'short';
      else if (stBtn === 'long press') decoded.press = 'long';
      else if (stBtn === 'double press') decoded.press = 'double';
      decoded.button_event_status = stBtn;
      decoded.press_raw = rawBtn;
      i += 1;
    } else if (channel_id === 254 || channel_id === 255) {
      var handled = handleDownlinkResponse(channel_type, bytes, i);
      if (handled == null) break;
      var k;
      for (k in handled.data) {
        if (Object.prototype.hasOwnProperty.call(handled.data, k)) decoded[k] = handled.data[k];
      }
      i = handled.offset;
    } else {
      break;
    }
  }
  return decoded;
}

function handleDownlinkResponse(channel_type, bytes, offset) {
  var decoded = {};
  var o = offset;
  switch (channel_type) {
    case 3:
      if (o + 2 > bytes.length) return null;
      decoded.reporting_interval = readUInt16LE(bytes.slice(o, o + 2));
      o += 2;
      break;
    case 16:
      if (o >= bytes.length) return null;
      decoded.reboot = readYesNoStatus(bytes[o++]);
      break;
    case 40:
      if (o >= bytes.length) return null;
      decoded.query_device_status = readYesNoStatus(bytes[o++]);
      break;
    case 47:
      if (o >= bytes.length) return null;
      decoded.led_indicator_enable = readEnableStatus(bytes[o++]);
      break;
    case 62:
      if (o >= bytes.length) return null;
      decoded.buzzer_enable = readEnableStatus(bytes[o++]);
      break;
    case 116:
      if (o >= bytes.length) return null;
      decoded.double_click_enable = readEnableStatus(bytes[o++]);
      break;
    default:
      return null;
  }
  return { data: decoded, offset: o };
}

function readProtocolVersion(b) {
  var major = (b & 240) >> 4;
  var minor = b & 15;
  return 'v' + major + '.' + minor;
}

function readHardwareVersion(arr) {
  var major = (arr[0] & 255).toString(16);
  var minor = (arr[1] & 255) >> 4;
  return 'v' + major + '.' + minor;
}

function readFirmwareVersion(arr) {
  var major = (arr[0] & 255).toString(16);
  var minor = (arr[1] & 255).toString(16);
  return 'v' + major + '.' + minor;
}

function readTslVersion(arr) {
  return 'v' + (arr[0] & 255) + '.' + (arr[1] & 255);
}

function readSerialNumber(arr) {
  var temp = [];
  for (var idx = 0; idx < arr.length; idx++) {
    temp.push(('0' + (arr[idx] & 255).toString(16)).slice(-2));
  }
  return temp.join('');
}

function readLoRaWANClass(type) {
  var class_map = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
  return class_map[type] != null ? class_map[type] : 'unknown';
}

function readResetEvent(status) {
  var status_map = { 0: 'normal', 1: 'reset' };
  return status_map[status] != null ? status_map[status] : 'unknown';
}

function readDeviceStatus(status) {
  var status_map = { 0: 'off', 1: 'on' };
  return status_map[status] != null ? status_map[status] : 'unknown';
}

function readButtonEvent(status) {
  var status_map = { 1: 'short press', 2: 'long press', 3: 'double press' };
  return status_map[status] != null ? status_map[status] : 'unknown';
}

function readEnableStatus(status) {
  var status_map = { 0: 'disable', 1: 'enable' };
  return status_map[status] != null ? status_map[status] : 'unknown';
}

function readYesNoStatus(status) {
  var status_map = { 0: 'no', 1: 'yes' };
  return status_map[status] != null ? status_map[status] : 'unknown';
}

function getRandomIntInclusive(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function readUInt8(b) {
  return b & 255;
}

function readUInt16LE(arr) {
  var value = ((arr[1] & 255) << 8) + (arr[0] & 255);
  return value & 65535;
}
`.trim();
