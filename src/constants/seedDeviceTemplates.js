import { WS558_DECODER_SCRIPT } from './ws558DecoderScript';
import { UC300_DECODER_SCRIPT } from './uc300DecoderScript';

/**
 * Plantillas predefinidas (Milesight / familia habitual).
 * Los HEX se guardan sin espacios y en minúsculas (formato que usa la app al enviar downlinks).
 * Decoder en blanco: se puede completar en Plantillas o por dispositivo.
 */
const TIMEWAVE_DECODER_SCRIPT = `
function decodeUplink(input) {
  var r = Timewave.decodeFrame(input.bytes);
  if (!r || typeof r !== 'object') return { data: {} };
  return { data: r };
}
`.trim();

const EASTRON_DECODER_SCRIPT = `
function decodeUplink(input) {
  var r = Eastron.decodeActiveUpload(input.bytes);
  if (!r || typeof r !== 'object') return { data: {} };
  return { data: r };
}
`.trim();

/** TLV Milesight WS101 (referencia SensorDecoders ws101-decoder.js); FPort típico 85 en \`channel\`. */
const WS101_DECODER_SCRIPT = `
function decodeUplink(input) {
  var r = MilesightWs101.decode(input.bytes);
  if (!r || typeof r !== 'object') return { data: {} };
  return { data: r };
}
`.trim();

export const SEED_DEVICE_TEMPLATES = [
  {
    modelo: 'Water-Meter-LoRa',
    marca: 'Timewave',
    channel: '1',
    decoderScript: TIMEWAVE_DECODER_SCRIPT,
    downlinks: [
      {
        name: 'Válvula abrir (ej. medidor 022025001955; sustituir en HEX si otro nº)',
        hex: 'fefefefe6855190025200268140e35dd93373533333363636363aaaa3116',
      },
      {
        name: 'Válvula cerrar (mismo ejemplo de medidor)',
        hex: 'fefefefe6855190025200268140e35dd93373533333363636363bbbb5316',
      },
      {
        name: 'Intervalo subida 1440 min (24 h)',
        hex: 'fefefefe6855190025200268140e3534a33735333333636363637347fe16',
      },
      {
        name: 'Intervalo subida 60 min',
        hex: 'fefefefe6855190025200268140e3534a337353333336363636393330a16',
      },
    ],
  },
  {
    modelo: 'SDM230-LoRaWAN',
    marca: 'Eastron',
    channel: '1',
    decoderScript: EASTRON_DECODER_SCRIPT,
    downlinks: [
      { name: 'FC04 — Leer tensión L-N (30001), esclavo 1', hex: '01040000000271cb' },
      { name: 'FC04 — Leer corriente (30007)', hex: '01040006000291ca' },
      { name: 'FC04 — Leer potencia activa (30013)', hex: '0104000c0002b1c8' },
      { name: 'FC04 — Leer potencia aparente (30019)', hex: '010400120002d1ce' },
      { name: 'FC04 — Leer factor de potencia (30031)', hex: '0104001e000211cd' },
      { name: 'FC04 — Leer frecuencia (30071)', hex: '010400460002901e' },
      { name: 'FC04 — Leer energía activa importada kWh (30073)', hex: '010400480002f1dd' },
      { name: 'FC10 — Ancho pulso salida 1 = 60 ms (40013)', hex: '0110000c00020442700000e659' },
      { name: 'FC10 — Ancho pulso salida 1 = 100 ms (40013)', hex: '0110000c00020442c80000667c' },
      { name: 'FC10 — Ancho pulso salida 1 = 200 ms (40013)', hex: '0110000c000204434800006668' },
      { name: 'FC10 — Tipo pulso 1 = import Wh (40087)', hex: '011000560002043f8000007b45' },
      { name: 'FC10 — Tipo pulso 1 = export Wh (40087)', hex: '01100056000204408000006291' },
      { name: 'FC10 — Reset demanda máxima (reg. F010 = 0000)', hex: '0110f010000102000054cf' },
      { name: 'FC10 — Reset energía reseteable (F010 = 0003)', hex: '0110f010000102000314ce' },
    ],
  },
  {
    modelo: 'WS101',
    marca: 'Milesight',
    channel: '85',
    decoderScript: WS101_DECODER_SCRIPT,
    downlinks: [
      { name: 'Intervalo de reporte (20 min)', hex: 'ff03b004' },
      { name: 'Intervalo de reporte (5 min)', hex: 'ff032c01' },
      { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
      { name: 'Consultar estado del dispositivo', hex: 'ff28ff' },
      { name: 'Habilitar LED indicador', hex: 'ff2f01' },
      { name: 'Deshabilitar LED indicador', hex: 'ff2f00' },
      { name: 'Habilitar buzzer', hex: 'ff3e01' },
      { name: 'Deshabilitar buzzer', hex: 'ff3e00' },
      { name: 'Habilitar doble clic', hex: 'ff7401' },
      { name: 'Deshabilitar doble clic', hex: 'ff7400' },
    ],
  },
  {
    modelo: 'UC300',
    marca: 'Milesight',
    channel: '85',
    decoderScript: UC300_DECODER_SCRIPT,
    downlinks: [
      { name: 'DO 1 - Activar', hex: '070101ff' },
      { name: 'DO 1 - Desactivar', hex: '070100ff' },
      { name: 'DO 2 - Activar', hex: '080101ff' },
      { name: 'DO 2 - Desactivar', hex: '080100ff' },
      { name: 'Reinicio del dispositivo', hex: 'ff10ff' },
    ],
  },
  {
    modelo: 'WS558',
    marca: 'Milesight',
    channel: '85',
    decoderScript: WS558_DECODER_SCRIPT,
    downlinks: [
      { name: 'Abrir L1 (encender)', hex: '080101' },
      { name: 'Cerrar L1 (apagar)', hex: '080100' },
      { name: 'Abrir L2', hex: '080202' },
      { name: 'Cerrar L2', hex: '080200' },
      { name: 'Abrir L3', hex: '080404' },
      { name: 'Cerrar L3', hex: '080400' },
      { name: 'Abrir L4', hex: '080808' },
      { name: 'Cerrar L4', hex: '080800' },
      { name: 'Abrir L5', hex: '081010' },
      { name: 'Cerrar L5', hex: '081000' },
      { name: 'Abrir L6', hex: '082020' },
      { name: 'Cerrar L6', hex: '082000' },
      { name: 'Abrir L7', hex: '084040' },
      { name: 'Cerrar L7', hex: '084000' },
      { name: 'Abrir L8', hex: '088080' },
      { name: 'Cerrar L8', hex: '088800' },
    ],
  },
  {
    modelo: 'WS523',
    marca: 'Milesight',
    channel: '85',
    decoderScript: '',
    downlinks: [
      { name: 'Abrir socket (encender)', hex: '080100ff' },
      { name: 'Cerrar socket (apagar)', hex: '080000ff' },
      { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
      { name: 'Intervalo de reporte (20 min)', hex: 'ff03b004' },
      { name: 'Intervalo de reporte (5 min)', hex: 'ff032c01' },
      { name: 'Habilitar LED indicador', hex: 'ff2f01' },
      { name: 'Deshabilitar LED indicador', hex: 'ff2f00' },
      { name: 'Habilitar consumo energético', hex: 'ff2601' },
      { name: 'Deshabilitar consumo energético', hex: 'ff2600' },
      { name: 'Reset consumo energético', hex: 'ff27ff' },
      { name: 'Consultar estado eléctrico', hex: 'ff28ff' },
      { name: 'Bloquear botón físico', hex: 'ff250080' },
      { name: 'Desbloquear botón físico', hex: 'ff250000' },
      { name: 'Habilitar alarma sobrecorriente (10A)', hex: 'ff24010a' },
      { name: 'Deshabilitar alarma sobrecorriente', hex: 'ff240000' },
      { name: 'Habilitar protección sobrecorriente (10A)', hex: 'ff30010a' },
      { name: 'Deshabilitar protección sobrecorriente', hex: 'ff300000' },
      { name: 'Abrir socket después de 1 minuto', hex: 'ff22003c0011' },
      { name: 'Cerrar socket después de 1 minuto', hex: 'ff22003c0010' },
      { name: 'Eliminar tarea pendiente', hex: 'ff2300ff' },
    ],
  },
  {
    modelo: 'WS501',
    marca: 'Milesight',
    channel: '85',
    decoderScript: '',
    downlinks: [
      { name: 'Apagar L1', hex: '0810ff' },
      { name: 'Encender L1', hex: '0811ff' },
      { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
      { name: 'Intervalo de reporte (20 min)', hex: 'ff03b004' },
      { name: 'Intervalo de reporte (5 min)', hex: 'ff032c01' },
      { name: 'Habilitar LED indicador (apagado)', hex: 'ff2f01' },
      { name: 'Habilitar LED indicador (encendido)', hex: 'ff2f02' },
      { name: 'Deshabilitar LED indicador', hex: 'ff2f00' },
      { name: 'Habilitar consumo energético', hex: 'ff2601' },
      { name: 'Deshabilitar consumo energético', hex: 'ff2600' },
      { name: 'Reset consumo energético', hex: 'ff27ff' },
      { name: 'Consultar estado eléctrico', hex: 'ff28ff' },
      { name: 'Bloquear botones físicos (ON/OFF)', hex: 'ff250080' },
      { name: 'Desbloquear botones físicos', hex: 'ff250000' },
      { name: 'Bloquear reset por botón', hex: 'ff5e01' },
      { name: 'Desbloquear reset por botón', hex: 'ff5e00' },
      { name: 'Encender L1 después de 1 minuto', hex: 'ff22003c0011' },
      { name: 'Apagar L1 después de 1 minuto', hex: 'ff22003c0010' },
      { name: 'Eliminar tarea pendiente', hex: 'ff2300ff' },
    ],
  },
  {
    modelo: 'UC512',
    marca: 'Milesight',
    channel: '85',
    decoderScript: '',
    downlinks: [
      { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
      { name: 'Intervalo de recolección (collect)', hex: 'ff022b' },
      { name: 'Intervalo de reporte (20 min)', hex: 'ff03b004' },
      { name: 'Consultar estado actual', hex: 'ff28ff' },
      { name: 'Zona horaria (ej. UTC-2)', hex: 'ff17ecff' },
      { name: 'Auto-confirmed mechanism', hex: 'fff301' },
      { name: 'Abrir Valve 1 por 60s', hex: 'ff1da0013c0000' },
      { name: 'Abrir Valve 2 por 60s', hex: 'ff1da1023c0000' },
      { name: 'Abrir Valve 1 hasta 60s o 16 pulsos', hex: 'ff1de0043c000010000000' },
      { name: 'Cerrar Valve 1', hex: 'ff1d2001000000' },
      { name: 'Cerrar Valve 2', hex: 'ff1d2102000000' },
      { name: 'Rain special control (todas válvulas)', hex: 'ff1d1700060000d897f968' },
      { name: 'Consultar estado Valve 1', hex: 'f9a500' },
      { name: 'Consultar estado Valve 2', hex: 'f9a501' },
      { name: 'Prevenir jitter (tiempo antirrebote)', hex: 'ff461b' },
      { name: 'Cambio temporizado de modo LoRaWAN', hex: 'f9a48b' },
      { name: 'Consultar hora desde servidor', hex: 'ff4aff' },
    ],
  },
];
