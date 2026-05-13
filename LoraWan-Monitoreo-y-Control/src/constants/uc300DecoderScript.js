/**
 * Decoder Milesight UC300 (LoRaWAN).
 * Adaptado del codec oficial (SensorDecoders) al contrato servidor:
 * `decodeUplink({ bytes, fPort }) → { data }` (ver server/payload-decoder.js).
 *
 * Ajustes respecto al script de referencia:
 * - Entrada `input.bytes` (array de números 0–255).
 * - `reset_event` / `device_status` leen el byte real del payload.
 * - `readUInt8` acepta número o array de un byte (evita NaN con slice).
 * - Respuesta a downlink desconocida: no lanza; corta el TLV (break) para no desincronizar.
 * - Canal desconocido final: break (no rellenar `text` con el resto del buffer).
 * - Historial Modbus: MB_COIL escribe en el objeto `data` del evento (coherencia con el resto).
 * - Tras decodificar: si solo llegan entradas en `channel_history` (0x20/0xdc), se copian GPIO a la raíz
 *   para que tarjetas/Resumen vean el mismo estado que dentro del historial (ToolBox vs radio).
 * - Sin polyfill `Object.assign` (Node ya lo tiene).
 *
 * El FPort de downlink lo define la plantilla (`channel` → device_decode_config).
 */
export const UC300_DECODER_SCRIPT = `
// uc300-decoder (Milesight)
function decodeUplink(input) {
  var bytes = input.bytes;
  return { data: milesightDeviceDecode(bytes) };
}

var gpio_input_chns = [0x03, 0x04, 0x05, 0x06];
var gpio_output_chns = [0x07, 0x08];
var pt100_chns = [0x09, 0x0a];
var ai_chns = [0x0b, 0x0c];
var av_chns = [0x0d, 0x0e];

/** GPIO en trama 0x20/0xdc suele ir solo dentro del último objeto de channel_history; la app usa claves raíz. */
function promoteChannelHistoryScalarsToRoot(decoded) {
  if (!decoded || !decoded.channel_history || !decoded.channel_history.length) return;
  var last = decoded.channel_history[decoded.channel_history.length - 1];
  if (!last || typeof last !== 'object') return;
  var re = /^(gpio_input_[1-4]|gpio_output_[12]|gpio_counter_[1-4])$/;
  for (var pk in last) {
    if (!Object.prototype.hasOwnProperty.call(last, pk)) continue;
    if (!re.test(pk)) continue;
    if (decoded[pk] != null) continue;
    var vv = last[pk];
    if (vv == null || typeof vv === 'object') continue;
    decoded[pk] = vv;
  }
}

function milesightDeviceDecode(bytes) {
  var decoded = {};
  if (!bytes || bytes.length === 0) return decoded;

  var i = 0;
  main: while (i < bytes.length) {
    if (i + 1 >= bytes.length) break;
    var channel_id = bytes[i++] & 255;
    var channel_type = bytes[i++] & 255;

    if (channel_id === 0xff && channel_type === 0x01) {
      if (i >= bytes.length) break main;
      decoded.ipso_version = readProtocolVersion(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0x09) {
      if (i + 2 > bytes.length) break main;
      decoded.hardware_version = readHardwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x0a) {
      if (i + 2 > bytes.length) break main;
      decoded.firmware_version = readFirmwareVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0xff) {
      if (i + 2 > bytes.length) break main;
      decoded.tsl_version = readTslVersion(bytes.slice(i, i + 2));
      i += 2;
    } else if (channel_id === 0xff && channel_type === 0x16) {
      if (i + 8 > bytes.length) break main;
      decoded.sn = readSerialNumber(bytes.slice(i, i + 8));
      i += 8;
    } else if (channel_id === 0xff && channel_type === 0x0f) {
      if (i >= bytes.length) break main;
      decoded.lorawan_class = readLoRaWANClass(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0xfe) {
      if (i >= bytes.length) break main;
      decoded.reset_event = readResetEvent(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0x0b) {
      if (i >= bytes.length) break main;
      decoded.device_status = readOnOffStatus(bytes[i++]);
    } else if (channel_id === 0x01 && channel_type === 0x75) {
      if (i >= bytes.length) break main;
      decoded.battery = readUInt8(bytes[i++]);
    } else if (channel_id === 0xff && channel_type === 0x08) {
      if (i + 6 > bytes.length) break main;
      decoded.sn = readSerialNumber(bytes.slice(i, i + 6));
      i += 6;
    } else if (includes(gpio_input_chns, channel_id) && channel_type === 0x00) {
      if (i >= bytes.length) break main;
      var gi = channel_id - gpio_input_chns[0] + 1;
      decoded['gpio_input_' + gi] = readOnOffStatus(bytes[i++]);
    } else if (includes(gpio_output_chns, channel_id) && channel_type === 0x01) {
      if (i >= bytes.length) break main;
      var go = channel_id - gpio_output_chns[0] + 1;
      decoded['gpio_output_' + go] = readOnOffStatus(bytes[i++]);
    } else if (includes(gpio_input_chns, channel_id) && channel_type === 0xc8) {
      if (i + 4 > bytes.length) break main;
      var gc = channel_id - gpio_input_chns[0] + 1;
      decoded['gpio_counter_' + gc] = readUInt32LE(bytes.slice(i, i + 4));
      i += 4;
    } else if (includes(pt100_chns, channel_id) && channel_type === 0x67) {
      if (i + 2 > bytes.length) break main;
      var pt = channel_id - pt100_chns[0] + 1;
      decoded['pt100_' + pt] = readInt16LE(bytes.slice(i, i + 2)) / 10;
      i += 2;
    } else if (includes(ai_chns, channel_id) && channel_type === 0x02) {
      if (i + 4 > bytes.length) break main;
      var ad = channel_id - ai_chns[0] + 1;
      decoded['adc_' + ad] = readUInt32LE(bytes.slice(i, i + 4)) / 100;
      i += 4;
    } else if (includes(av_chns, channel_id) && channel_type === 0x02) {
      if (i + 4 > bytes.length) break main;
      var av = channel_id - av_chns[0] + 1;
      decoded['adv_' + av] = readUInt32LE(bytes.slice(i, i + 4)) / 100;
      i += 4;
    } else if (channel_id === 0xff && channel_type === 0x19) {
      if (i + 3 > bytes.length) break main;
      var modbus_chn_id = bytes[i++] + 1;
      bytes[i++];
      var data_type = bytes[i++];
      var sign = (data_type >>> 7) & 0x01;
      var typ = data_type & 0x7f;
      var chn = 'modbus_chn_' + modbus_chn_id;
      switch (typ) {
        case 0:
          if (i >= bytes.length) break main;
          decoded[chn] = readOnOffStatus(bytes[i++]);
          break;
        case 1:
          if (i >= bytes.length) break main;
          decoded[chn] = sign ? readInt8(bytes.slice(i, i + 1)) : readUInt8(bytes.slice(i, i + 1));
          i += 1;
          break;
        case 2:
        case 3:
          if (i + 2 > bytes.length) break main;
          decoded[chn] = sign ? readInt16LE(bytes.slice(i, i + 2)) : readUInt16LE(bytes.slice(i, i + 2));
          i += 2;
          break;
        case 4:
        case 6:
          if (i + 4 > bytes.length) break main;
          decoded[chn] = sign ? readInt32LE(bytes.slice(i, i + 4)) : readUInt32LE(bytes.slice(i, i + 4));
          i += 4;
          break;
        case 8:
        case 10:
          if (i + 4 > bytes.length) break main;
          decoded[chn] = sign ? readInt16LE(bytes.slice(i, i + 2)) : readUInt16LE(bytes.slice(i, i + 2));
          i += 4;
          break;
        case 9:
        case 11:
          if (i + 4 > bytes.length) break main;
          decoded[chn] = sign ? readInt16LE(bytes.slice(i + 2, i + 4)) : readUInt16LE(bytes.slice(i + 2, i + 4));
          i += 4;
          break;
        case 5:
        case 7:
          if (i + 4 > bytes.length) break main;
          decoded[chn] = readFloatLE(bytes.slice(i, i + 4));
          i += 4;
          break;
        default:
          break main;
      }
    } else if (channel_id === 0xff && channel_type === 0x15) {
      if (i >= bytes.length) break main;
      var merr = bytes[i++] + 1;
      decoded['modbus_chn_' + merr + '_alarm'] = 'read error';
    } else if (includes(ai_chns, channel_id) && channel_type === 0xe2) {
      if (i + 8 > bytes.length) break main;
      var ai2 = channel_id - ai_chns[0] + 1;
      var an = 'adc_' + ai2;
      decoded[an] = readFloat16LE(bytes.slice(i, i + 2));
      decoded[an + '_max'] = readFloat16LE(bytes.slice(i + 2, i + 4));
      decoded[an + '_min'] = readFloat16LE(bytes.slice(i + 4, i + 6));
      decoded[an + '_avg'] = readFloat16LE(bytes.slice(i + 6, i + 8));
      i += 8;
    } else if (includes(av_chns, channel_id) && channel_type === 0xe2) {
      if (i + 8 > bytes.length) break main;
      var av2 = channel_id - av_chns[0] + 1;
      var vn = 'adv_' + av2;
      decoded[vn] = readFloat16LE(bytes.slice(i, i + 2));
      decoded[vn + '_max'] = readFloat16LE(bytes.slice(i + 2, i + 4));
      decoded[vn + '_min'] = readFloat16LE(bytes.slice(i + 4, i + 6));
      decoded[vn + '_avg'] = readFloat16LE(bytes.slice(i + 6, i + 8));
      i += 8;
    } else if (includes(pt100_chns, channel_id) && channel_type === 0xe2) {
      if (i + 8 > bytes.length) break main;
      var pt2 = channel_id - pt100_chns[0] + 1;
      var pn = 'pt100_' + pt2;
      decoded[pn] = readFloat16LE(bytes.slice(i, i + 2));
      decoded[pn + '_max'] = readFloat16LE(bytes.slice(i + 2, i + 4));
      decoded[pn + '_min'] = readFloat16LE(bytes.slice(i + 4, i + 6));
      decoded[pn + '_avg'] = readFloat16LE(bytes.slice(i + 6, i + 8));
      i += 8;
    } else if (channel_id === 0x20 && channel_type === 0xdc) {
      if (i + 6 > bytes.length) break main;
      var timestamp = readUInt32LE(bytes.slice(i, i + 4));
      var channel_mask = numToBits(readUInt16LE(bytes.slice(i + 4, i + 6)), 16);
      i += 6;
      var hdata = { timestamp: timestamp };
      for (var j = 0; j < channel_mask.length; j++) {
        if (channel_mask[j] !== 1) continue;
        if (j < 4) {
          if (i >= bytes.length) break main;
          var t0 = bytes[i++];
          if (t0 === 0) {
            if (i + 4 > bytes.length) break main;
            hdata['gpio_input_' + (j + 1)] = readOnOffStatus(readUInt32LE(bytes.slice(i, i + 4)));
            i += 4;
          } else {
            if (i + 4 > bytes.length) break main;
            hdata['gpio_counter_' + (j + 1)] = readUInt32LE(bytes.slice(i, i + 4));
            i += 4;
          }
        } else if (j < 6) {
          if (i >= bytes.length) break main;
          hdata['gpio_output_' + (j - 4 + 1)] = readOnOffStatus(bytes[i++]);
        } else if (j < 8) {
          if (i + 2 > bytes.length) break main;
          hdata['pt100_' + (j - 6 + 1)] = readFloat16LE(bytes.slice(i, i + 2));
          i += 2;
        } else if (j < 10) {
          if (i + 8 > bytes.length) break main;
          var hn = 'adc_' + (j - 8 + 1);
          hdata[hn] = readFloat16LE(bytes.slice(i, i + 2));
          hdata[hn + '_max'] = readFloat16LE(bytes.slice(i + 2, i + 4));
          hdata[hn + '_min'] = readFloat16LE(bytes.slice(i + 4, i + 6));
          hdata[hn + '_avg'] = readFloat16LE(bytes.slice(i + 6, i + 8));
          i += 8;
        } else if (j < 12) {
          if (i + 8 > bytes.length) break main;
          var hn2 = 'adv_' + (j - 10 + 1);
          hdata[hn2] = readFloat16LE(bytes.slice(i, i + 2));
          hdata[hn2 + '_max'] = readFloat16LE(bytes.slice(i + 2, i + 4));
          hdata[hn2 + '_min'] = readFloat16LE(bytes.slice(i + 4, i + 6));
          hdata[hn2 + '_avg'] = readFloat16LE(bytes.slice(i + 6, i + 8));
          i += 8;
        } else if (j < 13) {
          if (i + 48 > bytes.length) break main;
          hdata.text = readAscii(bytes.slice(i, i + 48));
          i += 48;
        }
      }
      if (!decoded.channel_history) decoded.channel_history = [];
      decoded.channel_history.push(hdata);
    } else if (channel_id === 0x20 && channel_type === 0xdd) {
      if (i + 8 > bytes.length) break main;
      var ts2 = readUInt32LE(bytes.slice(i, i + 4));
      var modbus_chn_mask = numToBits(readUInt32LE(bytes.slice(i + 4, i + 8)), 32);
      i += 8;
      var mdata = { timestamp: ts2 };
      for (var j2 = 0; j2 < modbus_chn_mask.length; j2++) {
        if (modbus_chn_mask[j2] !== 1) continue;
        if (i + 5 > bytes.length) break main;
        var chn2 = 'modbus_chn_' + (j2 + 1);
        var dt = bytes[i++];
        var sg = (dt >>> 7) & 0x01;
        var tp = dt & 0x7f;
        switch (tp) {
          case 0:
            mdata[chn2] = readOnOffStatus(bytes[i]);
            break;
          case 1:
            mdata[chn2] = sg ? readInt8(bytes.slice(i, i + 1)) : readUInt8(bytes.slice(i, i + 1));
            break;
          case 2:
          case 3:
            mdata[chn2] = sg ? readInt16LE(bytes.slice(i, i + 2)) : readUInt16LE(bytes.slice(i, i + 2));
            break;
          case 4:
          case 6:
            mdata[chn2] = sg ? readInt32LE(bytes.slice(i, i + 4)) : readUInt32LE(bytes.slice(i, i + 4));
            break;
          case 8:
          case 10:
            mdata[chn2] = sg ? readInt16LE(bytes.slice(i, i + 2)) : readUInt16LE(bytes.slice(i, i + 2));
            break;
          case 9:
          case 11:
            mdata[chn2] = sg ? readInt16LE(bytes.slice(i + 2, i + 4)) : readUInt16LE(bytes.slice(i + 2, i + 4));
            break;
          case 5:
          case 7:
            mdata[chn2] = readFloatLE(bytes.slice(i, i + 4));
            break;
          default:
            break main;
        }
        i += 4;
      }
      if (!decoded.modbus_history) decoded.modbus_history = [];
      decoded.modbus_history.push(mdata);
    } else if (channel_id === 0xfe || channel_id === 0xff) {
      var result = handle_downlink_response(channel_type, bytes, i);
      if (result == null) break main;
      var key;
      for (key in result.data) {
        if (Object.prototype.hasOwnProperty.call(result.data, key)) {
          decoded[key] = result.data[key];
        }
      }
      i = result.offset;
    } else {
      break main;
    }
  }
  promoteChannelHistoryScalarsToRoot(decoded);
  return decoded;
}

function handle_downlink_response(channel_type, bytes, offset) {
  var out = {};
  var o = offset;
  switch (channel_type) {
    case 0x02:
      if (o + 2 > bytes.length) return null;
      out.collection_interval = readUInt16LE(bytes.slice(o, o + 2));
      o += 2;
      break;
    case 0x03:
      if (o + 2 > bytes.length) return null;
      out.report_interval = readUInt16LE(bytes.slice(o, o + 2));
      o += 2;
      break;
    case 0x11:
      if (o + 4 > bytes.length) return null;
      out.timestamp = readUInt32LE(bytes.slice(o, o + 4));
      o += 4;
      break;
    case 0x17:
      if (o + 2 > bytes.length) return null;
      out.time_zone = readTimeZone(readInt16LE(bytes.slice(o, o + 2)));
      o += 2;
      break;
    case 0x91:
      if (o + 5 > bytes.length) return null;
      out.jitter_config = out.jitter_config || {};
      var channel_map = { all: 0, gpio_input_1: 1, gpio_input_2: 2, gpio_input_3: 3, gpio_input_4: 4, gpio_output_1: 5, gpio_output_2: 6 };
      var ch = readUInt8(bytes[o]);
      out.jitter_config[channel_map[ch]] = readUInt32LE(bytes.slice(o + 1, o + 5));
      o += 5;
      break;
    case 0x93:
      if (o + 6 > bytes.length) return null;
      var gpio_index = readUInt8(bytes[o]);
      var gpio_output_chn_name = 'gpio_output_' + gpio_index + '_control';
      out[gpio_output_chn_name] = {
        status: readOnOffStatus(bytes[o + 1]),
        duration: readUInt32LE(bytes.slice(o + 2, o + 6)),
      };
      o += 6;
      break;
    default:
      return null;
  }
  return { data: out, offset: o };
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

function readOnOffStatus(status) {
  var s = typeof status === 'number' ? status & 255 : readUInt8(status);
  if (s === 0) return 'off';
  if (s === 1) return 'on';
  return 'unknown';
}

function readTimeZone(time_zone) {
  var timezone_map = { '-120': 'UTC-12', '-110': 'UTC-11', '-100': 'UTC-10', '-95': 'UTC-9:30', '-90': 'UTC-9', '-80': 'UTC-8', '-70': 'UTC-7', '-60': 'UTC-6', '-50': 'UTC-5', '-40': 'UTC-4', '-35': 'UTC-3:30', '-30': 'UTC-3', '-20': 'UTC-2', '-10': 'UTC-1', 0: 'UTC', 10: 'UTC+1', 20: 'UTC+2', 30: 'UTC+3', 35: 'UTC+3:30', 40: 'UTC+4', 45: 'UTC+4:30', 50: 'UTC+5', 55: 'UTC+5:30', 57: 'UTC+5:45', 60: 'UTC+6', 65: 'UTC+6:30', 70: 'UTC+7', 80: 'UTC+8', 90: 'UTC+9', 95: 'UTC+9:30', 100: 'UTC+10', 105: 'UTC+10:30', 110: 'UTC+11', 120: 'UTC+12', 127: 'UTC+12:45', 130: 'UTC+13', 140: 'UTC+14' };
  return timezone_map[time_zone] != null ? timezone_map[time_zone] : 'unknown';
}

function numToBits(num, bit_count) {
  var bits = [];
  for (var bi = 0; bi < bit_count; bi++) {
    bits.push((num >> bi) & 1);
  }
  return bits;
}

function readUInt8(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return x & 255;
  if (x.length !== undefined && x.length > 0) return x[0] & 255;
  return 0;
}

function readInt8(arr) {
  var ref = readUInt8(arr);
  return ref > 0x7f ? ref - 0x100 : ref;
}

function readUInt16LE(arr) {
  var value = ((arr[1] & 255) << 8) + (arr[0] & 255);
  return value & 0xffff;
}

function readInt16LE(arr) {
  var ref = readUInt16LE(arr);
  return ref > 0x7fff ? ref - 0x10000 : ref;
}

function readUInt32LE(arr) {
  var value = ((arr[3] & 255) << 24) + ((arr[2] & 255) << 16) + ((arr[1] & 255) << 8) + (arr[0] & 255);
  return (value & 0xffffffff) >>> 0;
}

function readInt32LE(arr) {
  var ref = readUInt32LE(arr);
  return ref > 0x7fffffff ? ref - 0x100000000 : ref;
}

function readFloatLE(arr) {
  var bits = ((arr[3] & 255) << 24) | ((arr[2] & 255) << 16) | ((arr[1] & 255) << 8) | (arr[0] & 255);
  var sign = bits >>> 31 === 0 ? 1.0 : -1.0;
  var e = (bits >>> 23) & 0xff;
  var m = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  var f = sign * m * Math.pow(2, e - 150);
  return Number(f.toFixed(2));
}

function readFloat16LE(arr) {
  var bits = ((arr[1] & 255) << 8) | (arr[0] & 255);
  var sign = bits >>> 15 === 0 ? 1.0 : -1.0;
  var e = (bits >>> 10) & 0x1f;
  var m = e === 0 ? (bits & 0x3ff) << 1 : (bits & 0x3ff) | 0x400;
  var f = sign * m * Math.pow(2, e - 25);
  return Number(f.toFixed(2));
}

function readAscii(arr) {
  var str = '';
  for (var ai = 0; ai < arr.length; ai++) {
    str += String.fromCharCode(arr[ai] & 255);
  }
  return str;
}

function includes(data, value) {
  for (var ii = 0; ii < data.length; ii++) {
    if (data[ii] == value) return true;
  }
  return false;
}
`.trim();
