/**
 * Decoder Milesight WS558 (regleta LoRaWAN, 8 canales).
 * Basado en github.com/Milesight-IoT/SensorDecoders (ws-series/ws558/ws558-decoder.js), ajustado para Node / Syscom:
 * - reset_event / device_status leen el byte real del payload (no el literal 1).
 * - Respuestas a downlink: default sin throw (evita cortar la VM).
 * - readYesNoStatus en ACK de downlink lee bytes[offset].
 * - Sin polyfill Object.assign (Node ya lo tiene; el original lo dejaba mal comentado).
 *
 * Contrato: decodeUplink({ bytes, fPort }) → { data } (server/payload-decoder.js).
 */
export const WS558_DECODER_SCRIPT = `
/**
 * Payload Decoder — WS558 (Milesight)
 * @product WS558
 */
var RAW_VALUE = 0x00;

function decodeUplink(input) {
  var decoded = milesightDeviceDecode(input.bytes);
  return { data: decoded };
}

function Decode(fPort, bytes) {
  return milesightDeviceDecode(bytes);
}

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
    } else if (channel_id === 0xff && channel_type === 0x16) {
      if (i + 8 > bytes.length) break;
      decoded.sn = readSerialNumber(bytes.slice(i, i + 8));
      i += 8;
    } else if (channel_id === 0xff && channel_type === 0x0f) {
      if (i >= bytes.length) break;
      decoded.lorawan_class = readLoRaWANClass(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0xfe) {
      if (i >= bytes.length) break;
      decoded.reset_event = readResetEvent(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0x0b) {
      if (i >= bytes.length) break;
      decoded.device_status = readDeviceStatus(bytes[i++]);
    } else if (channel_id === 0x03 && channel_type === 0x74) {
      if (i + 2 > bytes.length) break;
      decoded.voltage = readUInt16LE(bytes.slice(i, i + 2)) / 10;
      i += 2;
    } else if (channel_id === 0x04 && channel_type === 0x80) {
      if (i + 4 > bytes.length) break;
      decoded.active_power = readUInt32LE(bytes.slice(i, i + 4));
      i += 4;
    } else if (channel_id === 0x05 && channel_type === 0x81) {
      if (i >= bytes.length) break;
      decoded.power_factor = readUInt8(bytes[i++]);
    } else if (channel_id === 0x06 && channel_type === 0x83) {
      if (i + 4 > bytes.length) break;
      decoded.power_consumption = readUInt32LE(bytes.slice(i, i + 4));
      i += 4;
    } else if (channel_id === 0x07 && channel_type === 0xc9) {
      if (i + 2 > bytes.length) break;
      decoded.total_current = readUInt16LE(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0x08 && channel_type === 0x31) {
      if (i + 2 > bytes.length) break;
      var switchFlags = bytes[i + 1];
      for (var idx = 0; idx < 8; idx++) {
        var switchTag = "switch_" + (idx + 1);
        decoded[switchTag] = readSwitchStatus((switchFlags >> idx) & 1);
      }
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x26) {
      if (i >= bytes.length) break;
      decoded.power_consumption_enable = readEnableStatus(bytes[i++]);
    } else if (channel_id === 0xfe || channel_id === 0xff) {
      var result = handle_downlink_response(channel_type, bytes, i);
      if (result == null) break;
      var k;
      for (k in result.data) {
        if (Object.prototype.hasOwnProperty.call(result.data, k)) decoded[k] = result.data[k];
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

  switch (channel_type) {
    case 0x10:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.reboot = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x28:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.report_status = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x03:
      if (offset + 2 > bytes.length) return { data: decoded, offset: offset };
      decoded.report_interval = readUInt16LE(bytes.slice(offset, offset + 2));
      offset += 2;
      break;
    case 0x23:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.cancel_delay_task = readUInt8(bytes[offset]);
      offset += 2;
      break;
    case 0x26:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.power_consumption_enable = readEnableStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x27:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.clear_power_consumption = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x32:
      if (offset + 5 > bytes.length) return { data: decoded, offset: offset };
      decoded.delay_task = {};
      decoded.delay_task.task_id = readUInt8(bytes[offset]);
      decoded.delay_task.delay_time = readUInt16LE(bytes.slice(offset + 1, offset + 3));
      var mask = readUInt8(bytes[offset + 3]);
      var status = readUInt8(bytes[offset + 4]);
      offset += 5;
      var switch_bit_offset = { switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3, switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7 };
      var key;
      for (key in switch_bit_offset) {
        if (Object.prototype.hasOwnProperty.call(switch_bit_offset, key)) {
          if ((mask >> switch_bit_offset[key]) & 0x01) {
            decoded.delay_task[key] = readSwitchStatus((status >> switch_bit_offset[key]) & 0x01);
          }
        }
      }
      break;
    default:
      return null;
  }

  return { data: decoded, offset: offset };
}

function readProtocolVersion(b) {
  var major = (b & 0xf0) >> 4;
  var minor = b & 0x0f;
  return "v" + major + "." + minor;
}

function readHardwareVersion(bytes) {
  var major = (bytes[0] & 0xff).toString(16);
  var minor = (bytes[1] & 0xff) >> 4;
  return "v" + major + "." + minor;
}

function readFirmwareVersion(bytes) {
  var major = (bytes[0] & 0xff).toString(16);
  var minor = (bytes[1] & 0xff).toString(16);
  return "v" + major + "." + minor;
}

function readTslVersion(bytes) {
  var major = bytes[0] & 0xff;
  var minor = bytes[1] & 0xff;
  return "v" + major + "." + minor;
}

function readSerialNumber(bytes) {
  var temp = [];
  for (var idx = 0; idx < bytes.length; idx++) {
    temp.push(("0" + (bytes[idx] & 0xff).toString(16)).slice(-2));
  }
  return temp.join("");
}

function readLoRaWANClass(type) {
  var class_map = {
    0: "Class A",
    1: "Class B",
    2: "Class C",
    3: "Class CtoB",
  };
  return getValue(class_map, type);
}

function readResetEvent(status) {
  var status_map = {
    0: "normal",
    1: "reset",
  };
  return getValue(status_map, status);
}

function readDeviceStatus(status) {
  var status_map = {
    0: "off",
    1: "on",
  };
  return getValue(status_map, status);
}

function readSwitchStatus(status) {
  var status_map = {
    0: "off",
    1: "on",
  };
  return getValue(status_map, status);
}

function readEnableStatus(status) {
  var status_map = { 0: "disable", 1: "enable" };
  return getValue(status_map, status);
}

function readYesNoStatus(status) {
  var yes_no_map = { 0: "no", 1: "yes" };
  return getValue(yes_no_map, status);
}

function readUInt8(b) {
  return b & 0xff;
}

function readInt8(b) {
  var ref = readUInt8(b);
  return ref > 0x7f ? ref - 0x100 : ref;
}

function readUInt16LE(bytes) {
  var value = (bytes[1] << 8) + bytes[0];
  return value & 0xffff;
}

function readInt16LE(bytes) {
  var ref = readUInt16LE(bytes);
  return ref > 0x7fff ? ref - 0x10000 : ref;
}

function readUInt32LE(bytes) {
  var value = (bytes[3] << 24) + (bytes[2] << 16) + (bytes[1] << 8) + bytes[0];
  return value & 0xffffffff;
}

function readInt32LE(bytes) {
  var ref = readUInt32LE(bytes);
  return ref > 0x7fffffff ? ref - 0x100000000 : ref;
}

function getValue(map, key) {
  if (RAW_VALUE) return key;
  var value = map[key];
  if (!value) value = "unknown";
  return value;
}
`.trim();
