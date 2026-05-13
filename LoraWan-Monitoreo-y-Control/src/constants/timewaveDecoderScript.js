/**
 * Timewave Water-Meter-LoRa (DLT/645 +0x33).
 *
 * Contrato servidor: `decodeUplink({ bytes, fPort }) → { data: { ... } }`
 * (`bytes` es `Array<number>`; ver `server/payload-decoder.js`).
 *
 * La trama real se decodifica en Node (`server/timewave-water-meter.js`) y se expone
 * en el sandbox del decoder como `Timewave.decodeFrame(bytes)`. Eso incluye: preámbulo
 * FEFEFEFE, doble 0x68, checksum, descifrado −0x33 con préstamo (no es un simple
 * `byte - 33` por octeto), BCD de lectura, tramas 91h / 94h / D4h.
 *
 * El script «manual» que solo hace `indexOf(0x68)` y `decodeMeterData` restando 33
 * puede divergir del firmware en lectura y batería; aquí se reutiliza el motor nativo
 * y se añaden alias (`meterNumber`, `cumulativeReading_m3`, …) para paneles o
 * integraciones que ya esperaban esos nombres.
 */
export const TIMEWAVE_DECODER_SCRIPT = `
function legacyTimewaveStatus(st) {
  if (!st || typeof st !== 'object') return null;
  var valveStatus = 'Excepción';
  if (st.valveOpen) valveStatus = 'Abierta';
  else if (st.valveClosed) valveStatus = 'Cerrada';
  return {
    valveStatus: valveStatus,
    lowPower: !!st.lowPowerSupply,
    alarm: !!st.alarm,
    overdraft: !!st.overdraft,
    magneticInterference: !!st.strongMagnetic,
    forceStatus: !!st.forceStatusOn
  };
}

function decodeUplink(input) {
  var bytes = input && input.bytes ? input.bytes : [];
  var r = Timewave.decodeFrame(bytes);
  if (!r || typeof r !== 'object') return { data: {} };

  var d = {};
  for (var k in r) {
    if (Object.prototype.hasOwnProperty.call(r, k)) d[k] = r[k];
  }

  if (r.timewave_meterNo != null) d.meterNumber = r.timewave_meterNo;
  if (r.water_cumulative_m3 != null) d.cumulativeReading_m3 = r.water_cumulative_m3;
  if (r.battery_voltage_mv != null) d.batteryVoltage_mV = r.battery_voltage_mv;
  if (r.battery_percent != null) d.batteryPercentage = r.battery_percent;
  if (r.timewave_control != null) {
    d.controlCode = '0x' + (Number(r.timewave_control) & 255).toString(16).toUpperCase();
  }
  if (r.timewave_di != null) d.dataId = String(r.timewave_di).toUpperCase();

  var st = r.timewave_status;
  if (st && typeof st === 'object') d.status = legacyTimewaveStatus(st);

  var frame = r.timewave_frame;
  var di = r.timewave_di != null ? String(r.timewave_di).toLowerCase() : '';
  if (frame === 'interval_ack') {
    d.message = 'Intervalo cambiado correctamente';
  } else if (frame === 'valve_ack') {
    d.message = 'Comando de válvula ejecutado';
  } else if (frame === 'command_fail') {
    if (di === '0460aa02') d.message = 'Fallo en comando de válvula';
    else if (di === '04700102') d.message = 'Error al cambiar intervalo';
    else d.message = 'Fallo en comando';
  }

  return { data: d };
}
`.trim();
