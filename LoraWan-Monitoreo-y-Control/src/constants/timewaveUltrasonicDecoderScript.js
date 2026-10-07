/**
 * Timewave Ultrasonic-Water-Meter-LoRa (CJ/T 188-2004 V1.0.2).
 *
 * No mezclar con Water-Meter-LoRa (DLT/645 +0x33). Trama: 68 11 [7 B addr LE] C L DATA CS 16.
 * DI en orden de documento (90 97 / A0 17), sin segundo 0x68.
 */
export const TIMEWAVE_ULTRASONIC_DECODER_SCRIPT = `
function legacyUltrasonicStatus(st) {
  if (!st || typeof st !== 'object') return null;
  var valveStatus = 'Excepción';
  if (st.valveOpen) valveStatus = 'Abierta';
  else if (st.valveClosed) valveStatus = 'Cerrada';
  return {
    valveStatus: valveStatus,
    lowPower: !!st.lowPowerSupply,
    batteryLevelAlarm: !!st.batteryLevelAlarm,
    emptyPipe: !!st.emptyPipe,
    reverseFlow: !!st.reverseFlow,
    overRange: !!st.overRange,
    waterTemperatureAlarm: !!st.waterTemperatureAlarm,
    eeAlarm: !!st.eeAlarm
  };
}

function decodeUplink(input) {
  var bytes = input && input.bytes ? input.bytes : [];
  var r = TimewaveUltrasonic.decodeFrame(bytes);
  if (!r || typeof r !== 'object') return { data: {} };

  var d = {};
  for (var k in r) {
    if (Object.prototype.hasOwnProperty.call(r, k)) d[k] = r[k];
  }

  if (r.timewave_meterNo != null) d.meterNumber = r.timewave_meterNo;
  if (r.water_cumulative_m3 != null) d.cumulativeReading_m3 = r.water_cumulative_m3;
  if (r.timewave_control != null) {
    d.controlCode = '0x' + (Number(r.timewave_control) & 255).toString(16).toUpperCase();
  }
  if (r.timewave_di != null) d.dataId = String(r.timewave_di).toUpperCase();

  var st = r.timewave_status;
  if (st && typeof st === 'object') d.status = legacyUltrasonicStatus(st);

  var frame = r.timewave_frame;
  if (frame === 'valve_ack') d.message = 'Comando de válvula ejecutado';
  else if (frame === 'valve_nack') d.message = 'Fallo en comando de válvula';
  else if (frame === 'upload_params') d.message = 'Parámetros de subida actualizados';
  else if (frame === 'upload_params_nack') d.message = 'Error al cambiar parámetros de subida';
  else if (frame === 'reading_nack') d.message = 'Fallo al leer acumulado';

  return { data: d };
}
`.trim();
