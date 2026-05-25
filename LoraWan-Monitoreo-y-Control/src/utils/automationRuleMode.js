/** Condiciones IF con dispositivo y propiedad elegidos. */
export function effectiveAutomationConditions(conds) {
  return (conds || []).filter(
    (c) =>
      c &&
      c.deviceId != null &&
      String(c.deviceId).trim() &&
      c.propKey != null &&
      String(c.propKey).trim()
  );
}

/**
 * @returns {'schedule' | 'conditions'}
 * - schedule: solo días/horas (sin IF)
 * - conditions: solo telemetría IF (sin ventana horaria)
 */
export function resolveAutomationRuleMode(rule) {
  const explicit =
    rule?.ruleMode != null
      ? String(rule.ruleMode).trim().toLowerCase()
      : rule?.useSchedule === true
        ? 'schedule'
        : rule?.useSchedule === false
          ? 'conditions'
          : '';
  if (explicit === 'schedule' || explicit === 'horario') return 'schedule';
  if (explicit === 'conditions' || explicit === 'condiciones') return 'conditions';
  return effectiveAutomationConditions(rule?.conditions).length === 0 ? 'schedule' : 'conditions';
}

export function isScheduleAutomationRule(rule) {
  return resolveAutomationRuleMode(rule) === 'schedule';
}
