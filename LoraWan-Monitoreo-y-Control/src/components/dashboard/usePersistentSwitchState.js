import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pickSwitchToggleKey, readSwitchOnFromTelemetry } from './switchWidgetUi';

const STORAGE_PREFIX = 'bsd_switch_manual_v1';

function storageKey(scopeKey) {
  return `${STORAGE_PREFIX}:${scopeKey}`;
}

function readStoredSwitchState(scopeKey) {
  try {
    const raw = sessionStorage.getItem(storageKey(scopeKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.locked !== true) return null;
    return Boolean(parsed.on);
  } catch {
    return null;
  }
}

function writeStoredSwitchState(scopeKey, on) {
  try {
    sessionStorage.setItem(storageKey(scopeKey), JSON.stringify({ locked: true, on: Boolean(on) }));
  } catch {
    /* quota / privado */
  }
}

/**
 * Estado del switch: solo cambia con clic del usuario o con downlink de automatización
 * (véase `useSwitchAutomationSync`). La telemetría no mueve el interruptor.
 */
export function usePersistentSwitchState({
  telemetry,
  preferredFieldKey = '',
  deviceId = null,
}) {
  const stickyKeyRef = useRef(null);
  const userLockedRef = useRef(false);
  const [isOn, setIsOn] = useState(false);

  const scopeKey = `${deviceId ?? ''}|${preferredFieldKey}`;

  useEffect(() => {
    stickyKeyRef.current = null;
    userLockedRef.current = false;

    const stored = readStoredSwitchState(scopeKey);
    if (stored !== null) {
      userLockedRef.current = true;
      setIsOn(stored);
      return;
    }
    setIsOn(false);
  }, [scopeKey]);

  const toggleKey = useMemo(() => {
    const picked = pickSwitchToggleKey(telemetry, preferredFieldKey || undefined);
    const pref = String(preferredFieldKey || '').trim();
    if (pref && picked) {
      stickyKeyRef.current = picked;
      return picked;
    }
    const sticky = stickyKeyRef.current;
    if (sticky && telemetry && typeof telemetry === 'object' && telemetry[sticky] != null && telemetry[sticky] !== '') {
      return sticky;
    }
    if (picked) stickyKeyRef.current = picked;
    return picked;
  }, [telemetry, preferredFieldKey]);

  const persistSwitchState = useCallback(
    (target) => {
      const next = Boolean(target);
      userLockedRef.current = true;
      writeStoredSwitchState(scopeKey, next);
      setIsOn(next);
    },
    [scopeKey]
  );

  const setManualSwitchState = persistSwitchState;
  const setAutomationSwitchState = persistSwitchState;

  const telemetryOn = useMemo(
    () => readSwitchOnFromTelemetry(telemetry, toggleKey),
    [telemetry, toggleKey]
  );

  return {
    toggleKey,
    isOn,
    telemetryOn,
    userLocked: userLockedRef.current,
    setManualSwitchState,
    setAutomationSwitchState,
    setOptimisticTarget: setManualSwitchState,
  };
}
