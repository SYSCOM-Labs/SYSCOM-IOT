/**
 * Decoder Milesight WS501 (interruptor mural LoRaWAN).
 * Basado en github.com/Milesight-IoT/SensorDecoders (ws-series/ws501/ws501-decoder.js), ajustado para Node / Syscom.
 */
export const WS501_DECODER_SCRIPT = `
/**
 * Payload Decoder — WS501 (Milesight)
 * @product WS501
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
    } else if (channel_id === 0xff && channel_type === 0x29) {
      if (i >= bytes.length) break;
      var value = bytes[i++];
      decoded.switch_1 = readOnOffStatus((value >>> 0) & 1);
      decoded.switch_1_change = readYesNoStatus((value >>> 4) & 1);
    } else if (channel_id === 0xff && channel_type === 0x2b) {
      if (i >= bytes.length) break;
      decoded.function_key_event = readYesNoStatus(bytes[i++]);
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
    case 0x03:
      if (offset + 2 > bytes.length) return { data: decoded, offset: offset };
      decoded.report_interval = readUInt16LE(bytes.slice(offset, offset + 2));
      offset += 2;
      break;
    case 0x10:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.reboot = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x22:
      if (offset + 4 > bytes.length) return { data: decoded, offset: offset };
      decoded.delay_task = {};
      decoded.delay_task.frame_count = readUInt8(bytes[offset]);
      decoded.delay_task.delay_time = readUInt16LE(bytes.slice(offset + 1, offset + 3));
      var data = readUInt8(bytes[offset + 3]);
      if ((data >>> 4) & 0x01) decoded.delay_task.switch_1 = readOnOffStatus(data & 0x01);
      offset += 4;
      break;
    case 0x23:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.cancel_delay_task = readUInt8(bytes[offset]);
      offset += 2;
      break;
    case 0x25:
      if (offset + 2 > bytes.length) return { data: decoded, offset: offset };
      var lockData = readUInt16LE(bytes.slice(offset, offset + 2));
      decoded.child_lock_config = {};
      decoded.child_lock_config.enable = readEnableStatus((lockData >>> 15) & 0x01);
      decoded.child_lock_config.lock_time = lockData & 0x7fff;
      offset += 2;
      break;
    case 0x28:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.report_status = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x29:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      var sw = readUInt8(bytes[offset]);
      if ((sw >>> 4) & 0x01) decoded.switch_1 = readOnOffStatus(sw & 0x01);
      offset += 1;
      break;
    case 0x2c:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.report_attribute = readYesNoStatus(bytes[offset]);
      offset += 1;
      break;
    case 0x2f:
      if (offset >= bytes.length) return { data: decoded, offset: offset };
      decoded.led_mode = readLedMode(bytes[offset]);
      offset += 1;
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
  return "v" + (bytes[0] & 0xff) + "." + (bytes[1] & 0xff);
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

function readOnOffStatus(status) {
  return getValue({ 0: "off", 1: "on" }, status);
}

function readYesNoStatus(status) {
  return getValue({ 0: "no", 1: "yes" }, status);
}

function readEnableStatus(status) {
  return getValue({ 0: "disable", 1: "enable" }, status);
}

function readLedMode(type) {
  return getValue({ 0: "off", 1: "on_inverted", 2: "on_synced" }, type);
}

function readUInt8(bytes) {
  return bytes & 0xff;
}

function readUInt16LE(bytes) {
  return ((bytes[1] << 8) + bytes[0]) & 0xffff;
}

function getValue(map, key) {
  if (RAW_VALUE) return key;
  var value = map[key];
  return value != null ? value : "unknown";
}
`.trim();
