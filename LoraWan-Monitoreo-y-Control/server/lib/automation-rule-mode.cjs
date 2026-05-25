'use strict';

function effectiveAutomationConditions(conds) {
  return (conds || []).filter(
    (c) =>
      c &&
      c.deviceId != null &&
      String(c.deviceId).trim() &&
      c.propKey != null &&
      String(c.propKey).trim()
  );
}

/** @returns {'schedule' | 'conditions'} */
function resolveAutomationRuleMode(rule) {
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

module.exports = {
  effectiveAutomationConditions,
  resolveAutomationRuleMode,
};
