import emailjs from 'emailjs-com';
import axios from 'axios';
import { sendDownlink, fetchAutomationRules } from './api.js';

/**
 * Automation Engine
 */

// Memory cache for last execution times to prevent spam (Debouncing)
// Key: ruleId-actionIndex
const cooldownStorage = {};

let rulesCache = null;
let rulesCacheAt = 0;
/** Alineado con refresco de widgets (~5s) para reglas más reactivas. */
const RULES_CACHE_MS = 5000;

export function invalidateAutomationRulesCache() {
  rulesCache = null;
  rulesCacheAt = 0;
}

async function loadRulesFromServer() {
  if (rulesCache != null && Date.now() - rulesCacheAt < RULES_CACHE_MS) {
    return rulesCache;
  }
  try {
    rulesCache = await fetchAutomationRules();
    rulesCacheAt = Date.now();
    return rulesCache;
  } catch {
    if (rulesCache != null) return rulesCache;
    const legacy = localStorage.getItem('iot_automations');
    return legacy ? JSON.parse(legacy) : [];
  }
}

export const runAutomations = async (devices, deviceProperties, credentials, token, auth) => {
  const rules = await loadRulesFromServer();
  if (!rules || !rules.length) return;

  const activeRules = rules.filter(r => r.active);
  const now = new Date();
  const currentDay = now.getDay(); // 0-6 (Sun-Sat)
  const currentTimeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  for (const rule of activeRules) {
    // 1. Check Schedule
    const dayMatches = !rule.activeDays || rule.activeDays.includes(currentDay);
    const timeMatches = isTimeInRange(currentTimeStr, rule.scheduleStart || '00:00', rule.scheduleEnd || '23:59');

    if (!dayMatches || !timeMatches) continue;

    // 2. Skip if no conditions defined
    if (!rule.conditions || rule.conditions.length === 0) continue;

    // Check Conditions (All must be true - AND logic)
    let allConditionsMet = true;
    for (const cond of rule.conditions) {
      const deviceValue = deviceProperties[cond.deviceId]?.[cond.propKey];
      if (deviceValue === undefined) {
        allConditionsMet = false;
        break;
      }

      if (!evaluateCondition(deviceValue, cond.operator, cond.value)) {
        allConditionsMet = false;
        break;
      }
    }

    if (!allConditionsMet) {
      // One-shot rules must be re-armable once conditions are no longer true.
      if (!rule.allowReactivation) {
        for (let i = 0; i < (rule.actions || []).length; i++) {
          const cooldownKey = `${rule.id}-${i}`;
          cooldownStorage[cooldownKey] = 0;
        }
      }
      continue;
    }

    // 3. Execute Actions
    for (let i = 0; i < (rule.actions || []).length; i++) {
        const action = rule.actions[i];
        const cooldownKey = `${rule.id}-${i}`;
        const lastExec = cooldownStorage[cooldownKey] || 0;

        // Enforce cooldown only if reactivation is enabled
        if (rule.allowReactivation) {
          const reactivationLimit = parseInt(rule.reactivation || 600) * 1000;
          if (Date.now() - lastExec < reactivationLimit) continue;
        } else {
          // Without reactivation: only fire once (until conditions reset)
          if (lastExec > 0) continue;
        }

        // Apply delay if any
        const delaySeconds = Math.max(0, parseInt(action.delay || 0));
        if (delaySeconds > 0) {
            setTimeout(() => executeAction(action, rule, devices, credentials, token, auth), delaySeconds * 1000);
        } else {
            executeAction(action, rule, devices, credentials, token, auth);
        }

        // Update cooldown
        cooldownStorage[cooldownKey] = Date.now();
    }
  }
};

const executeAction = async (action, rule, devices, credentials, token, auth) => {
    console.log(`[Automation] Triggered: ${rule.name} -> ${action.type}`);
    
    try {
        switch (action.type) {
            case 'email':
                await sendEmailAction(action, rule, auth);
                break;
            case 'webhook':
                await axios.post(action.target, {
                    ruleName: rule.name,
                    timestamp: new Date().toISOString(),
                    triggeredBy: rule.conditions.map(c => c.propName).join(', ')
                });
                break;
            case 'downlink':
                if (action.targetDeviceId && action.commandKey) {
                    await sendDownlink(action.targetDeviceId, action.commandKey, credentials, token);
                }
                break;
            default:
                console.warn('Unknown action type:', action.type);
        }
    } catch (err) {
        console.error(`Action execution failed (${action.type}):`, err);
    }
};

const sendEmailAction = async (action, rule, auth) => {
    const config = JSON.parse(localStorage.getItem('iot_email_config') || '{}');
    
    if (!config.serviceId || !config.templateId || !config.publicKey) {
        console.warn('EmailJS not configured in Settings.');
        return;
    }

    const templateParams = {
        to_email: action.target,
        subject: `Alerta: ${rule.name}`,
        message: `La regla "${rule.name}" se ha activado.\nCondiciones: ${rule.conditions.map(c => `${c.propName} ${c.operator} ${c.value}`).join(' AND ')}\nFecha: ${new Date().toLocaleString()}`,
        rule_name: rule.name,
        user_name: auth?.user?.email || 'Usuario'
    };

    return emailjs.send(config.serviceId, config.templateId, templateParams, config.publicKey);
};

const isTimeInRange = (current, start, end) => {
  if (start <= end) {
    return current >= start && current <= end;
  } else {
    // Over midnight case (e.g. 22:00 to 06:00)
    return current >= start || current <= end;
  }
};

const evaluateCondition = (actual, operator, target) => {
  const a = parseFloat(actual);
  const t = parseFloat(target);
  
  if (isNaN(a) || isNaN(t)) {
      // String comparison
      switch (operator) {
        case '==': return String(actual) === String(target);
        case '!=': return String(actual) !== String(target);
        default: return false;
      }
  }

  switch (operator) {
    case '==': return a === t;
    case '!=': return a !== t;
    case '>': return a > t;
    case '<': return a < t;
    case '>=': return a >= t;
    case '<=': return a <= t;
    default: return false;
  }
};
