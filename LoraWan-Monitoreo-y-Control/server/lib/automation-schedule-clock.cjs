'use strict';

const WEEKDAY_TO_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Zona horaria para evaluar reglas por horario.
 * Prioridad: regla → SYSCOM_AUTOMATION_TIMEZONE → TZ → America/Mexico_City.
 * @param {object | null | undefined} rule
 */
function resolveAutomationTimezone(rule) {
  const fromRule =
    rule?.scheduleTimezone != null && String(rule.scheduleTimezone).trim()
      ? String(rule.scheduleTimezone).trim()
      : rule?.timezone != null && String(rule.timezone).trim()
        ? String(rule.timezone).trim()
        : '';
  if (fromRule) return fromRule;
  const fromEnv =
    process.env.SYSCOM_AUTOMATION_TIMEZONE != null && String(process.env.SYSCOM_AUTOMATION_TIMEZONE).trim()
      ? String(process.env.SYSCOM_AUTOMATION_TIMEZONE).trim()
      : process.env.TZ != null && String(process.env.TZ).trim()
        ? String(process.env.TZ).trim()
        : '';
  if (fromEnv) return fromEnv;
  return 'America/Mexico_City';
}

/**
 * Día (0=dom) y reloj "HH:mm" en la zona indicada.
 * @param {Date} now
 * @param {string} timeZone
 * @returns {{ currentDay: number, currentTimeStr: string }}
 */
function getScheduleClockParts(now, timeZone) {
  const d = now instanceof Date ? now : new Date(now);
  const tz = timeZone || 'UTC';
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

module.exports = {
  resolveAutomationTimezone,
  getScheduleClockParts,
};
