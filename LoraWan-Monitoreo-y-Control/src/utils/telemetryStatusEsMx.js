/**
 * Etiquetas de estado de telemetría (Milesight / GPIO / HVAC) → español mexicano.
 * Se aplica al mostrar widgets; el payload del decoder sigue en inglés.
 */

const STATUS_ES_MX = {
  on: 'Encendido',
  off: 'Apagado',
  open: 'Abierto',
  close: 'Cerrado',
  closed: 'Cerrado',
  opening: 'Abriendo',
  closing: 'Cerrando',
  standby: 'En espera',
  keep: 'Mantener',
  idle: 'Inactivo',
  enable: 'Activado',
  enabled: 'Activado',
  disable: 'Desactivado',
  disabled: 'Desactivado',
  yes: 'Sí',
  no: 'No',
  auto: 'Automático',
  heat: 'Calor',
  cool: 'Frío',
  fan: 'Ventilador',
  dry: 'Seco',
  wet: 'Húmedo',
  circulate: 'Circular',
  circulation: 'Circulación',
  stage: 'Etapa',
  'stage 2': 'Etapa 2',
  'stage-2': 'Etapa 2',
  'emergency heat': 'Calor de emergencia',
  short: 'Corta',
  long: 'Larga',
  double: 'Doble',
  'short press': 'Pulsación corta',
  'long press': 'Pulsación larga',
  'double press': 'Pulsación doble',
  'alarm triggered': 'Alarma activa',
  'alarm released': 'Alarma liberada',
  occupied: 'Ocupado',
  vacant: 'Desocupado',
  occupancy: 'Ocupación',
  normal: 'Normal',
  error: 'Error',
  warning: 'Advertencia',
  unknown: 'Desconocido',
  lock: 'Bloqueado',
  locked: 'Bloqueado',
  unlock: 'Desbloqueado',
  unlocked: 'Desbloqueado',
  high: 'Alto',
  low: 'Bajo',
  medium: 'Medio',
  stop: 'Detenido',
  stopped: 'Detenido',
  run: 'En marcha',
  running: 'En marcha',
  ventilation: 'Ventilación',
  'always open': 'Siempre abierto',
  'always close': 'Siempre cerrado',
  'always closed': 'Siempre cerrado',
  'on inverted': 'Encendido invertido',
  'on synced': 'Encendido sincronizado',
  reset: 'Reinicio',
  leak: 'Fuga',
  online: 'En línea',
  offline: 'Fuera de línea',
  success: 'Éxito',
  fail: 'Fallo',
  failed: 'Falló',
  pass: 'Correcto',
  active: 'Activo',
  inactive: 'Inactivo',
  trigger: 'Disparo',
  triggered: 'Disparado',
  released: 'Liberado',
};

const FEMININE_FIELD_RE =
  /valve|valvula|válvula|damper|compuerta|door|puerta|window|ventana|solenoid|electrovalv/i;

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTelemetryStatusKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * @param {string | null | undefined} fieldKey
 */
function prefersFeminineOpenClose(fieldKey) {
  return FEMININE_FIELD_RE.test(String(fieldKey || ''));
}

/**
 * @param {string} mapped
 * @param {string} norm
 * @param {string | null | undefined} fieldKey
 */
function applyOpenCloseGender(mapped, norm, fieldKey) {
  if (!prefersFeminineOpenClose(fieldKey)) return mapped;
  if (norm === 'open' || mapped === 'Abierto') return 'Abierta';
  if (norm === 'close' || norm === 'closed' || mapped === 'Cerrado') return 'Cerrada';
  if (norm === 'always open') return 'Siempre abierta';
  if (norm === 'always close' || norm === 'always closed') return 'Siempre cerrada';
  return mapped;
}

/**
 * Traduce un valor de estado conocido. Devuelve null si no hay equivalencia
 * (números, fechas, identificadores o texto ya en español).
 *
 * @param {unknown} raw
 * @param {string | null | undefined} [fieldKey]
 * @returns {string | null}
 */
export function translateTelemetryStatusLabel(raw, fieldKey) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return null;
  if (typeof raw === 'object') return null;

  const original = String(raw).trim();
  if (!original) return null;
  if (/^-?\d+(\.\d+)?$/.test(original)) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(original)) return null;
  if (/^[0-9a-f:]{8,}$/i.test(original) && original.length >= 8) return null;

  const norm = normalizeTelemetryStatusKey(original);

  const gpioIn = /^(input|entrada)\s+(\d+)\s+(on|off)$/.exec(norm);
  if (gpioIn) {
    return `Entrada ${gpioIn[2]} ${gpioIn[3] === 'on' ? 'encendida' : 'apagada'}`;
  }
  const gpioOut = /^(output|salida)\s+(\d+)\s+(on|off)$/.exec(norm);
  if (gpioOut) {
    return `Salida ${gpioOut[2]} ${gpioOut[3] === 'on' ? 'encendida' : 'apagada'}`;
  }

  if (!Object.prototype.hasOwnProperty.call(STATUS_ES_MX, norm)) return null;
  return applyOpenCloseGender(STATUS_ES_MX[norm], norm, fieldKey);
}

/**
 * Si hay traducción, la usa; si no, deja el texto original recortado.
 *
 * @param {unknown} text
 * @param {string | null | undefined} [fieldKey]
 * @returns {string}
 */
export function applyTelemetryStatusEsMx(text, fieldKey) {
  const mapped = translateTelemetryStatusLabel(text, fieldKey);
  if (mapped) return mapped;
  return text == null ? '' : String(text).trim();
}
