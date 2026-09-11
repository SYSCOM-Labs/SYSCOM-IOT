/**
 * Etiquetas de estado de telemetría → español mexicano.
 * Cubre valores Milesight y combinaciones futuras (p. ej. stage-N + heat/cool).
 * El payload del decoder no se modifica: solo cambia lo que se pinta en UI.
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
  hold: 'Mantener',
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
  'stage 1': 'Etapa 1',
  'stage 2': 'Etapa 2',
  'stage 3': 'Etapa 3',
  'stage 4': 'Etapa 4',
  'stage 1 cool': 'Etapa 1 frío',
  'stage 1 heat': 'Etapa 1 calor',
  'stage 2 cool': 'Etapa 2 frío',
  'stage 2 heat': 'Etapa 2 calor',
  'stage 3 heat': 'Etapa 3 calor',
  'stage 4 heat': 'Etapa 4 calor',
  'on cool': 'Enfriando',
  'on heat': 'Calentando',
  'em heat': 'Calor de emergencia',
  'emergency heat': 'Calor de emergencia',
  'fan only': 'Solo ventilador',
  'freeze protection alarm': 'Alarma anticongelante',
  'freeze protection alarm release': 'Anticongelante liberado',
  'continuous high temperature': 'Temperatura alta continua',
  'continuous low temperature': 'Temperatura baja continua',
  'auxiliary heating timeout alarm': 'Tiempo agotado de calor auxiliar',
  'emergency heating timeout alarm': 'Tiempo agotado de calor de emergencia',
  'remote control': 'Control remoto',
  'open window alarm': 'Alarma de ventana abierta',
  'filter clean alarm': 'Alarma de filtro sucio',
  'low battery alarm': 'Alarma de batería baja',
  'threshold alarm': 'Alarma de umbral',
  'threshold alarm release': 'Alarma de umbral liberada',
  'persistent high temperature alarm': 'Alarma de temperatura alta persistente',
  'persistent high temperature alarm release': 'Temperatura alta persistente liberada',
  'persistent low temperature alarm': 'Alarma de temperatura baja persistente',
  'persistent low temperature alarm release': 'Temperatura baja persistente liberada',
  'read error': 'Error de lectura',
  'read failed': 'Lectura fallida',
  'command fail': 'Fallo de comando',
  'not executed': 'No ejecutado',
  'out of range': 'Fuera de rango',
  'high speed': 'Alta velocidad',
  'low speed': 'Baja velocidad',
  'class a': 'Clase A',
  'class b': 'Clase B',
  'class c': 'Clase C',
  'class ctob': 'Clase C a B',
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
  home: 'En casa',
  away: 'Ausente',
  sleep: 'Reposo',
  wake: 'Activo',
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
  above: 'Por encima',
  below: 'Por debajo',
  between: 'Entre',
  outside: 'Fuera',
  forbidden: 'Prohibido',
  debug: 'Depuración',
  fatal: 'Fatal',
  trace: 'Traza',
  periodic: 'Periódico',
  tamper: 'Sabotaje',
  celsius: 'Celsius',
  fahrenheit: 'Fahrenheit',
  reboot: 'Reinicio',
  reconnect: 'Reconectar',
};

const PHRASE_KEYS = Object.keys(STATUS_ES_MX).sort((a, b) => b.length - a.length || a.localeCompare(b));

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

function lookupStatus(norm, fieldKey) {
  if (!Object.prototype.hasOwnProperty.call(STATUS_ES_MX, norm)) return null;
  return applyOpenCloseGender(STATUS_ES_MX[norm], norm, fieldKey);
}

function looksLikeConfigPath(original) {
  const s = String(original || '');
  if (s.includes('.') && /[a-z0-9_]+\.[a-z0-9_. ]{4,}/i.test(s) && s.split('.').length >= 3) return true;
  return false;
}

/**
 * Traduce combinaciones futuras palabra a palabra (p. ej. stage-5 cool).
 * @param {string} norm
 * @param {string | null | undefined} fieldKey
 * @returns {string | null}
 */
function translateGreedyPhrases(norm, fieldKey) {
  const words = String(norm || '')
    .split(' ')
    .filter(Boolean);
  if (!words.length || words.length > 10) return null;

  const out = [];
  let translated = 0;
  let i = 0;
  while (i < words.length) {
    let hit = null;
    let hitKey = '';
    let hitLen = 0;
    for (const phrase of PHRASE_KEYS) {
      const pw = phrase.split(' ');
      if (!pw.length || i + pw.length > words.length) continue;
      const slice = words.slice(i, i + pw.length).join(' ');
      if (slice === phrase) {
        hit = lookupStatus(phrase, fieldKey);
        hitKey = phrase;
        hitLen = pw.length;
        break;
      }
    }
    if (hit) {
      out.push(hit);
      translated += 1;
      void hitKey;
      i += hitLen;
    } else if (/^\d+(\.\d+)?$/.test(words[i])) {
      out.push(words[i]);
      i += 1;
    } else {
      out.push(words[i]);
      i += 1;
    }
  }
  if (!translated) return null;
  return out.join(' ');
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
  if (looksLikeConfigPath(original)) return null;

  const norm = normalizeTelemetryStatusKey(original);

  const gpioIn = /^(input|entrada)\s+(\d+)\s+(on|off)$/.exec(norm);
  if (gpioIn) {
    return `Entrada ${gpioIn[2]} ${gpioIn[3] === 'on' ? 'encendida' : 'apagada'}`;
  }
  const gpioOut = /^(output|salida)\s+(\d+)\s+(on|off)$/.exec(norm);
  if (gpioOut) {
    return `Salida ${gpioOut[2]} ${gpioOut[3] === 'on' ? 'encendida' : 'apagada'}`;
  }

  const exact = lookupStatus(norm, fieldKey);
  if (exact) return exact;

  const stageCombo = /^stage\s+(\d+)(?:\s+(.+))?$/.exec(norm);
  if (stageCombo) {
    const n = stageCombo[1];
    const restRaw = stageCombo[2] ? String(stageCombo[2]).trim() : '';
    if (!restRaw) return `Etapa ${n}`;
    const rest = lookupStatus(restRaw, fieldKey);
    if (rest) return `Etapa ${n} ${rest.toLowerCase()}`;
  }

  return translateGreedyPhrases(norm, fieldKey);
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

/**
 * Recorre objetos/arreglos y traduce hojas de texto (resúmenes, reportes).
 * @param {unknown} value
 * @param {string | null | undefined} [fieldKey]
 * @returns {unknown}
 */
export function translateTelemetryTreeEsMx(value, fieldKey) {
  if (typeof value === 'string') return applyTelemetryStatusEsMx(value, fieldKey);
  if (Array.isArray(value)) return value.map((item) => translateTelemetryTreeEsMx(item, fieldKey));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = translateTelemetryTreeEsMx(v, k);
    }
    return out;
  }
  return value;
}
