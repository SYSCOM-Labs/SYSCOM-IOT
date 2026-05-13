/**
 * Shengda Application Layer Protocol V1.6 (TV / TLV; big-endian; CS = sum of all bytes except CS mod 256).
 * Uplink frame header típico 0x24; comandos hacia módulo 0x26 (no decodificamos como telemetría uplink).
 * @see docs/SHENGDA-APP-LAYER-V1.6.md
 */
'use strict';

const HDR_UPLINK = 0x24;
const HDR_CMD = 0x26;

/** @type {Record<number, { key: string, len: number, scale?: number, unit?: string } | { key: string, len: 'lv' } | { key: string, len: 'rest' }>} */
const TYPE_SPEC = {
  0x01: { key: 'shengda_cooling_capacity_kwh', len: 4, scale: 1, unit: 'kWh' },
  0x02: { key: 'shengda_heat_kwh', len: 4, scale: 1, unit: 'kWh' },
  0x03: { key: 'shengda_heat_power_kw', len: 4, scale: 1, unit: 'kW' },
  0x04: { key: 'shengda_instantaneous_flow_m3h', len: 4, scale: 1, unit: 'm3/h' },
  0x05: { key: 'shengda_data_length', len: 1 },
  0x06: { key: 'shengda_supply_water_temp_c', len: 3, scale: 0.01, unit: 'C' },
  0x07: { key: 'shengda_return_water_temp_c', len: 3, scale: 0.01, unit: 'C' },
  0x08: { key: 'shengda_cumulative_working_time_h', len: 3, scale: 1, unit: 'h' },
  0x09: { key: 'shengda_lorawan_working_mode_raw', len: 1 },
  0x0a: { key: 'shengda_sensor_voltage_mv', len: 2, scale: 1, unit: 'mV' },
  0x0b: { key: 'shengda_pulse_count', len: 4 },
  0x0c: { key: 'shengda_accumulated_flow_settlement_day', len: 4 },
  0x0d: { key: 'shengda_monthly_frozen_cumulative_flow', len: 4 },
  0x0e: { key: 'shengda_yearly_frozen_cumulative_flow', len: 4 },
  0x0f: { key: 'shengda_settlement_date', len: 1 },
  0x10: { key: 'shengda_day_of_meter_reading', len: 1 },
  0x11: { key: 'shengda_class_b_downlink_cycle_x', len: 1 },
  0x12: { key: 'shengda_metering_mode_raw', len: 1 },
  0x13: { key: 'shengda_maximum_metering_value', len: 4 },
  0x14: { key: 'shengda_pulse_constant_raw', len: 1 },
  0x15: { key: 'shengda_rssi_dbm', len: 1, unit: 'dBm' },
  0x16: { key: 'shengda_meter_number', len: 4 },
  0x17: { key: 'shengda_valve_type_raw', len: 1 },
  0x18: { key: 'shengda_device_version', len: 'lv' },
  0x19: { key: 'shengda_packet_sequence', len: 1 },
  0x1a: { key: 'shengda_battery_raw', len: 2 },
  0x1b: { key: 'shengda_meter_type_raw', len: 1 },
  0x1c: { key: 'shengda_module_time', len: 6 },
  0x1d: { key: 'shengda_frozen_data_time_ymd', len: 3 },
  0x1e: { key: 'shengda_device_eui', len: 8 },
  0x1f: { key: 'shengda_valve_control_raw', len: 1 },
  0x20: { key: 'shengda_remote_meter_reading_raw', len: 1 },
  0x21: { key: 'shengda_cumulative_reverse_flow', len: 4 },
  0x22: { key: 'shengda_historical_flow_record', len: 'lv' },
  0x23: { key: 'shengda_trigger_source_raw', len: 1 },
  0x24: { key: 'shengda_max_valve_control_time_s', len: 1 },
  0x25: { key: 'shengda_timing_reporting_interval_s', len: 4 },
  0x26: { key: 'shengda_overcurrent_value', len: 4 },
  0x27: { key: 'shengda_overcurrent_duration_h', len: 4 },
  0x28: { key: 'shengda_continuous_water_usage_h', len: 4 },
  0x29: { key: 'shengda_max_single_water_usage', len: 4 },
  0x2a: { key: 'shengda_max_continuous_reverse', len: 4 },
  0x2b: { key: 'shengda_reporting_start_hour', len: 1 },
  0x2c: { key: 'shengda_dense_sampling_period_min', len: 2 },
  0x2d: { key: 'shengda_q3_lph', len: 2 },
  0x2e: { key: 'shengda_enable_reporting_lorawan_raw', len: 1 },
  0x33: { key: 'shengda_status_word_1', len: 2 },
  0x34: { key: 'shengda_appeui', len: 8 },
  0x35: { key: 'shengda_appkey', len: 16 },
  0x36: { key: 'shengda_center_freq_offset_hz', len: 2 },
  0x37: { key: 'shengda_switch_on_off_raw', len: 1 },
  0x38: { key: 'shengda_total_power_kwh', len: 4 },
  0x39: { key: 'shengda_a_phase_current', len: 2 },
  0x3a: { key: 'shengda_b_phase_current', len: 2 },
  0x3b: { key: 'shengda_c_phase_current', len: 2 },
  0x3c: { key: 'shengda_a_phase_active_power', len: 2 },
  0x3d: { key: 'shengda_b_phase_active_power', len: 2 },
  0x3e: { key: 'shengda_c_phase_active_power', len: 2 },
};

function verifyChecksum(buf) {
  if (!buf || buf.length < 2) return false;
  let s = 0;
  for (let i = 0; i < buf.length - 1; i += 1) s = (s + buf[i]) & 0xff;
  return s === buf[buf.length - 1];
}

function readUIntBE(buf, off, len) {
  if (off + len > buf.length) return null;
  return buf.readUIntBE(off, len);
}

function lorawanModeLabel(raw) {
  const n = Number(raw);
  if (n === 0) return 'Class A';
  if (n === 1) return 'Class B';
  if (n === 2) return 'Class C';
  if (n === 3) return 'LoRaWAN dual communication mode';
  return `unknown(${n})`;
}

/** Period_ms = 122880 / (128 / (2 ** X)) */
function classBDownlinkPeriodMs(x) {
  const xi = Number(x) & 0xff;
  const denom = 128 / 2 ** xi;
  if (!Number.isFinite(denom) || denom === 0) return null;
  return 122880 / denom;
}

function decodeStatusWord1Water(w) {
  const v = Number(w) & 0xffff;
  return {
    valve_fault: Boolean(v & 0x80),
    battery_undervoltage: Boolean(v & 0x40),
    magnetic_attack: Boolean(v & 0x20),
    battery_removed: Boolean(v & 0x10),
    der_wrong: Boolean(v & 0x08),
    valve_closed: Boolean(v & 0x04),
    metering_fault: Boolean(v & 0x02),
    remote_data: Boolean(v & 0x01),
  };
}

function decodeStatusWord2Water(w) {
  const v = Number(w) & 0xffff;
  const meterStatus = (v >> 2) & 7;
  const labels = [
    'Normal',
    'Empty pipe',
    'Flow overload',
    'Reserve',
    'Data storage fault',
    'Transducer fault',
    'Wrong direction',
    'Reserve',
  ];
  return {
    water_inlet_alarm: Boolean(v & 0x80),
    water_return_alarm: Boolean(v & 0x40),
    flow_alarm_historical_dismantle: Boolean(v & 0x20),
    meter_status_bits: meterStatus,
    meter_status: labels[meterStatus] || `code_${meterStatus}`,
    historical_magnetic_attack: Boolean(v & 0x02),
  };
}

/**
 * @param {Buffer} input
 * @returns {Record<string, unknown>|null}
 */
function decodeUplinkFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 3) return null;
  const hdr = buf[0];
  /** Solo uplink desde dispositivo (0x24). El 0x26 es trama de comando hacia el módulo. */
  if (hdr !== HDR_UPLINK) return null;
  const csOk = verifyChecksum(buf);
  const out = {
    shengda_protocol: true,
    shengda_protocol_version: '1.6',
    shengda_frame_header: hdr,
    shengda_frame_header_hex: `0x${hdr.toString(16).padStart(2, '0')}`,
    shengda_checksum_ok: csOk,
  };

  let i = 1;
  const end = buf.length - 1;

  while (i < end) {
    const b0 = buf[i];
    const lenFlag = (b0 >> 7) & 1;
    const contFlag = (b0 >> 6) & 1;

    /** Transparent transmission T=0x90, TLV */
    if (b0 === 0x90) {
      i += 1;
      if (i >= end) break;
      const L = buf[i++];
      if (i + L > end) {
        out.shengda_parse_error = 'transparent_truncated';
        break;
      }
      const raw = buf.subarray(i, i + L);
      i += L;
      out.shengda_transparent_hex = raw.toString('hex').toUpperCase();
      continue;
    }

    /** Upgrade command T(T0T1)V */
    if (b0 === 0x50 && i + 1 < end && buf[i + 1] === 0x48) {
      i += 2;
      const ulen = 5;
      if (i + ulen > end) {
        out.shengda_parse_error = 'upgrade_truncated';
        break;
      }
      const v = buf.subarray(i, i + ulen);
      i += ulen;
      out.shengda_upgrade_command = v.toString('hex').toUpperCase();
      continue;
    }

    let typeId;
    if (contFlag) {
      if (i + 1 >= end) {
        out.shengda_parse_error = 'type_continuation_truncated';
        break;
      }
      typeId = (b0 << 8) | buf[i + 1];
      i += 2;
    } else {
      typeId = b0 & 0x7f;
      i += 1;
    }

    const spec = TYPE_SPEC[typeId];
    let vlen = 0;
    if (lenFlag) {
      if (i >= end) {
        out.shengda_parse_error = 'missing_L';
        break;
      }
      vlen = buf[i++];
    } else if (spec && spec.len === 'lv') {
      if (i >= end) {
        out.shengda_parse_error = 'missing_L_var';
        break;
      }
      vlen = buf[i++];
    } else if (spec) {
      vlen = spec.len;
    } else {
      out.shengda_unknown_type = typeId;
      out.shengda_parse_error = `unknown_type_0x${typeId.toString(16)}`;
      break;
    }

    if (i + vlen > end) {
      out.shengda_parse_error = 'v_truncated';
      break;
    }
    const chunk = vlen ? buf.subarray(i, i + vlen) : Buffer.alloc(0);
    i += vlen;

    const key = spec ? spec.key : `shengda_type_0x${typeId.toString(16)}`;

    if (typeId === 0x18 || typeId === 0x22) {
      out[key] = chunk.toString('utf8').replace(/\0/g, '').trim() || chunk.toString('hex').toUpperCase();
      if (typeId === 0x22) out.shengda_historical_flow_hex = chunk.toString('hex').toUpperCase();
      continue;
    }

    if (!chunk.length) {
      out[key] = null;
      continue;
    }

    if (typeId === 0x1a && chunk.length >= 2) {
      const rawBat = chunk.readUInt16BE(0);
      out[key] = rawBat;
      out.shengda_battery_v = rawBat / 16.4;
      continue;
    }

    if (typeId === 0x09 && chunk.length >= 1) {
      out[key] = chunk[0];
      out.lorawan_class = lorawanModeLabel(chunk[0]);
      continue;
    }

    if (typeId === 0x11 && chunk.length >= 1) {
      const x = chunk[0] & 0xff;
      out[key] = x;
      const ms = classBDownlinkPeriodMs(x);
      if (ms != null) out.shengda_class_b_downlink_period_ms = Math.round(ms);
      continue;
    }

    if (typeId === 0x1c && chunk.length >= 6) {
      const y = 2000 + chunk[0];
      const mon = chunk[1];
      const day = chunk[2];
      const hh = chunk[3];
      const mm = chunk[4];
      const ss = chunk[5];
      out[key] = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      continue;
    }

    if (typeId === 0x1d && chunk.length >= 3) {
      const y = 2000 + chunk[0];
      const mon = chunk[1];
      const day = chunk[2];
      if (chunk[0] === 0 && chunk[1] === 0 && chunk[2] === 0) {
        out[key] = null;
      } else if (day === 0) {
        out[key] = `${y}-${String(mon).padStart(2, '0')}`;
      } else {
        out[key] = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
      continue;
    }

    if (typeId === 0x1e && chunk.length >= 8) {
      out[key] = chunk.toString('hex').toLowerCase();
      continue;
    }

    if (typeId === 0x34 && chunk.length >= 8) {
      out[key] = chunk.toString('hex').toLowerCase();
      continue;
    }

    if (typeId === 0x35 && chunk.length >= 16) {
      out[key] = chunk.toString('hex').toLowerCase();
      continue;
    }

    if (typeId === 0x33 && chunk.length >= 2) {
      const w = chunk.readUInt16BE(0);
      out[key] = w;
      out.shengda_status_word_1_bits = decodeStatusWord1Water(w);
      continue;
    }

    if (spec && spec.scale != null && chunk.length >= 1 && chunk.length <= 4) {
      const raw = readUIntBE(chunk, 0, chunk.length);
      if (raw != null) out[key] = Number(raw) * spec.scale;
      else out[key] = chunk.toString('hex').toUpperCase();
      continue;
    }

    if (chunk.length === 4) {
      out[key] = chunk.readUInt32BE(0);
    } else if (chunk.length === 3) {
      out[key] = readUIntBE(chunk, 0, 3);
    } else if (chunk.length === 2) {
      out[key] = chunk.readUInt16BE(0);
    } else if (chunk.length === 1) {
      out[key] = chunk[0];
    } else {
      out[key] = chunk.toString('hex').toUpperCase();
    }
  }

  return out;
}

/**
 * @param {Buffer|number[]} input
 * @returns {Record<string, unknown>|null}
 */
function decodeFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const r = decodeUplinkFrame(buf);
  return r && Object.keys(r).length ? r : null;
}

/** Ejemplos documento (solo verificación en desarrollo). */
function selfTest() {
  const samples = [
    '2419041c1301010101052304a0',
    '24190d1d1304000d0000c35014032307df',
    '2419081d1300000e0001d4c0140323085a',
  ];
  for (const hex of samples) {
    const buf = Buffer.from(hex, 'hex');
    decodeUplinkFrame(buf);
  }
}

module.exports = {
  decodeFrame,
  decodeUplinkFrame,
  verifyChecksum,
  HDR_UPLINK,
  HDR_CMD,
  selfTest,
};

if (require.main === module) {
  selfTest();
  // eslint-disable-next-line no-console
  console.log('shengda-app-layer selfTest ok');
}
