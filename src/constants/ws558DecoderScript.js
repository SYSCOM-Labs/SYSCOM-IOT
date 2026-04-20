/**
 * Decoder Milesight WS558 adaptado a Syscom (node:vm / payload-decoder.js).
 * Basado en SensorDecoders ws-series/ws558/ws558-decoder.js — sin polyfill Object.assign,
 * lecturas reales de bytes en reset/status/downlink yes/no, merge seguro y downlink desconocido → null.
 */
export const WS558_DECODER_SCRIPT = `
var RAW_VALUE = 0x00;

function decodeUplink(input) {
  var decoded = milesightDeviceDecode(input.bytes);
  return { data: decoded || {} };
}

function Decode(fPort, bytes) {
  return milesightDeviceDecode(bytes);
}

function Decoder(bytes, port) {
  return milesightDeviceDecode(bytes);
}

function milesightDeviceDecode(bytes) {
  var decoded = {};

  for (var i = 0; i < bytes.length; ) {
    var channel_id = bytes[i++];
    var channel_type = bytes[i++];

    if (channel_id === 0xff && channel_type === 0x01) {
      decoded.ipso_version = readProtocolVersion(bytes[i]);
      i += 1;
    } else if (channel_id === 0xff && channel_type === 0x09) {
      decoded.hardware_version = readHardwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x0a) {
      decoded.firmware_version = readFirmwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0xff) {
      decoded.tsl_version = readTslVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x16) {
      decoded.sn = readSerialNumber(bytes.slice(i, i + 8));
      i += 8;
    } else if (channel_id === 0xff && channel_type === 0x0f) {
      decoded.lorawan_class = readLoRaWANClass(bytes[i]);
      i += 1;
    } else if (channel_id === 0xff && channel_type === 0xfe) {
      decoded.reset_event = readResetEvent(bytes[i]);
      i += 1;
    } else if (channel_id === 0xff && channel_type === 0x0b) {
      decoded.device_status = readDeviceStatus(bytes[i]);
      i += 1;
    } else if (channel_id === 0x03 && channel_type === 0x74) {
      decoded.voltage = readUInt16LE(bytes.slice(i, i + 2)) / 10;
      i += 2;
    } else if (channel_id === 0x04 && channel_type === 0x80) {
      decoded.active_power = readUInt32LE(bytes.slice(i, i + 4));
      i += 4;
    } else if (channel_id === 0x05 && channel_type === 0x81) {
      decoded.power_factor = readUInt8(bytes[i]);
      i += 1;
    } else if (channel_id === 0x06 && channel_type === 0x83) {
      decoded.power_consumption = readUInt32LE(bytes.slice(i, i + 4));
      i += 4;
    } else if (channel_id === 0x07 && channel_type === 0xc9) {
      decoded.total_current = readUInt16LE(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0x08 && channel_type === 0x31) {
      var switchFlags = bytes[i + 1];
      for (var idx = 0; idx < 8; idx++) {
        var switchTag = "switch_" + (idx + 1);
        decoded[switchTag] = readSwitchStatus((switchFlags >> idx) & 1);
      }
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x26) {
      decoded.power_consumption_enable = readEnableStatus(bytes[i]);
      i += 1;
    } else if (channel_id === 0xfe || channel_id === 0xff) {
      var result = handle_downlink_response(channel_type, bytes, i);
      if (!result) {
        break;
      }
      var __src = result.data;
      for (var __k in __src) {
        if (Object.prototype.hasOwnProperty.call(__src, __k)) {
          decoded[__k] = __src[__k];
        }
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
      decoded.reboot = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x28:
      decoded.report_status = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x03:
      decoded.report_interval = readUInt16LE(bytes.slice(offset, offset + 2));
      offset += 2;
      break;
    case 0x23:
      decoded.cancel_delay_task = readUInt8(bytes[offset]);
      offset += 2;
      break;
    case 0x26:
      decoded.power_consumption_enable = readEnableStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x27:
      decoded.clear_power_consumption = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x32:
      decoded.delay_task = {};
      decoded.delay_task.task_id = readUInt8(bytes[offset]);
      decoded.delay_task.delay_time = readUInt16LE(bytes.slice(offset + 1, offset + 3));
      var mask = readUInt8(bytes[offset + 3]);
      var status = readUInt8(bytes[offset + 4]);
      offset += 5;
      var switch_bit_offset = { switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3, switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7 };
      for (var key in switch_bit_offset) {
        if ((mask >> switch_bit_offset[key]) & 0x01) {
          decoded.delay_task[key] = readSwitchStatus((status >> switch_bit_offset[key]) & 0x01);
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
  var class_map = { 0: "Class A", 1: "Class B", 2: "Class C", 3: "Class CtoB" };
  return getValue(class_map, type);
}

function readResetEvent(status) {
  return getValue({ 0: "normal", 1: "reset" }, status);
}

function readDeviceStatus(status) {
  return getValue({ 0: "off", 1: "on" }, status);
}

function readSwitchStatus(status) {
  return getValue({ 0: "off", 1: "on" }, status);
}

function readEnableStatus(status) {
  return getValue({ 0: "disable", 1: "enable" }, status);
}

function readYesNoStatus(status) {
  return getValue({ 0: "no", 1: "yes" }, status);
}

function readUInt8(b) {
  return b & 0xff;
}

function readUInt16LE(bytes) {
  var value = (bytes[1] << 8) + bytes[0];
  return value & 0xffff;
}

function readUInt32LE(bytes) {
  var value = (bytes[3] << 24) + (bytes[2] << 16) + (bytes[1] << 8) + bytes[0];
  return value >>> 0;
}

function getValue(map, key) {
  if (RAW_VALUE) return key;
  var value = map[key];
  if (!value) value = "unknown";
  return value;
}
`.trim();
