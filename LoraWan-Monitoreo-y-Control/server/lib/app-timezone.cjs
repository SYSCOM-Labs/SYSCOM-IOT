'use strict';

const APP_TIMEZONE_SETTING_KEY = 'app_timezone';

const WEEKDAY_TO_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const DEFAULT_APP_TIMEZONE = 'America/Mexico_City';

function isValidIanaTimezone(timeZone) {
  const tz = String(timeZone || '').trim();
  if (!tz || tz.length > 80) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function readEnvAppTimezone() {
  const fromAutomation =
    process.env.SYSCOM_AUTOMATION_TIMEZONE != null && String(process.env.SYSCOM_AUTOMATION_TIMEZONE).trim()
      ? String(process.env.SYSCOM_AUTOMATION_TIMEZONE).trim()
      : '';
  if (fromAutomation && isValidIanaTimezone(fromAutomation)) return fromAutomation;
  const fromTz =
    process.env.TZ != null && String(process.env.TZ).trim() ? String(process.env.TZ).trim() : '';
  if (fromTz && isValidIanaTimezone(fromTz)) return fromTz;
  return '';
}

/** Zona guardada en SQLite (Ajustes). */
function getConfiguredAppTimezone(store) {
  if (!store || typeof store.getServerSetting !== 'function') return '';
  const raw = store.getServerSetting(APP_TIMEZONE_SETTING_KEY);
  const tz = String(raw || '').trim();
  return tz && isValidIanaTimezone(tz) ? tz : '';
}

/**
 * Zona efectiva para automatizaciones por horario.
 * Prioridad: regla → Ajustes (servidor) → SYSCOM_AUTOMATION_TIMEZONE → TZ → defecto.
 * @param {object | null | undefined} store
 * @param {object | null | undefined} rule
 */
function resolveAppTimezone(store, rule) {
  const fromRule =
    rule?.scheduleTimezone != null && String(rule.scheduleTimezone).trim()
      ? String(rule.scheduleTimezone).trim()
      : rule?.timezone != null && String(rule.timezone).trim()
        ? String(rule.timezone).trim()
        : '';
  if (fromRule && isValidIanaTimezone(fromRule)) return fromRule;

  const configured = getConfiguredAppTimezone(store);
  if (configured) return configured;

  const fromEnv = readEnvAppTimezone();
  if (fromEnv) return fromEnv;

  return DEFAULT_APP_TIMEZONE;
}

function formatNowInTimezone(timeZone, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const tz = isValidIanaTimezone(timeZone) ? timeZone : DEFAULT_APP_TIMEZONE;
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * @param {object | null | undefined} store
 * @param {Date} [now]
 */
function getAppTimezoneStatus(store, now = new Date()) {
  const configured = getConfiguredAppTimezone(store);
  const envFallback = readEnvAppTimezone();
  const effective = resolveAppTimezone(store, null);
  const osHint =
    process.env.TZ != null && String(process.env.TZ).trim() ? String(process.env.TZ).trim() : '';

  let source = 'default';
  if (configured) source = 'settings';
  else if (envFallback) source = 'env';
  else source = 'default';

  return {
    timezone: effective,
    configured,
    envFallback,
    osTimezone: osHint,
    source,
    nowLocal: formatNowInTimezone(effective, now),
    nowUtc: now.toISOString(),
  };
}

/**
 * Día (0=dom) y reloj "HH:mm" en la zona indicada.
 * @param {Date} now
 * @param {string} timeZone
 * @returns {{ currentDay: number, currentTimeStr: string }}
 */
function getScheduleClockParts(now, timeZone) {
  const d = now instanceof Date ? now : new Date(now);
  const tz = isValidIanaTimezone(timeZone) ? timeZone : DEFAULT_APP_TIMEZONE;
  try {
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const dayToken = dayFmt.format(d).slice(0, 3);
    const currentDay = Object.prototype.hasOwnProperty.call(WEEKDAY_TO_INDEX, dayToken)
      ? WEEKDAY_TO_INDEX[dayToken]
      : d.getDay();

    const timeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);

    let hour = '00';
    let minute = '00';
    for (const p of timeParts) {
      if (p.type === 'hour') hour = String(p.value).padStart(2, '0');
      if (p.type === 'minute') minute = String(p.value).padStart(2, '0');
    }
    if (hour === '24') hour = '00';

    return { currentDay, currentTimeStr: `${hour}:${minute}` };
  } catch {
    return {
      currentDay: d.getDay(),
      currentTimeStr: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
  }
}

function saveAppTimezone(store, timeZone) {
  const tz = String(timeZone || '').trim();
  if (!isValidIanaTimezone(tz)) {
    const err = new Error('Zona horaria IANA no válida.');
    err.code = 'VALIDATION';
    throw err;
  }
  store.setServerSetting(APP_TIMEZONE_SETTING_KEY, tz);
  return getAppTimezoneStatus(store);
}

module.exports = {
  APP_TIMEZONE_SETTING_KEY,
  DEFAULT_APP_TIMEZONE,
  isValidIanaTimezone,
  getConfiguredAppTimezone,
  resolveAppTimezone,
  getAppTimezoneStatus,
  getScheduleClockParts,
  saveAppTimezone,
  formatNowInTimezone,
};
