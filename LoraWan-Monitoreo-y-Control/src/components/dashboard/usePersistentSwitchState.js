import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pickSwitchToggleKey, readSwitchOnFromTelemetry } from './switchWidgetUi';

const STORAGE_PREFIX = 'bsd_switch_manual_v1';

function storageKey(scopeKey) {
  return `${STORAGE_PREFIX}:${scopeKey}`;
}

function readStoredManualState(scopeKey) {
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

function writeStoredManualState(scopeKey, on) {
  try {
    sessionStorage.setItem(storageKey(scopeKey), JSON.stringify({ locked: true, on: Boolean(on) }));
  } catch {
    /* quota / privado */
  }
}

/**
 * Estado del switch: solo cambia con clic del usuario (persistido en sesión por dispositivo/campo).
 * La telemetría se muestra en el panel de detalle pero no mueve el interruptor tras el primer uso manual.
 */
export function usePersistentSwitchState({
  telemetry,
  preferredFieldKey = '',
  deviceId = null,
}) {
  const stickyKeyRef = useRef(null);
  const initializedRef = useRef(false);
  const userLockedRef = useRef(false);
  const [isOn, setIsOn] = useState(false);

  const scopeKey = `${deviceId ?? ''}|${preferredFieldKey}`;

  useEffect(() => {
    stickyKeyRef.current = null;
    initializedRef.current = false;
    userLockedRef.current = false;

    const stored = readStoredManualState(scopeKey);
    if (stored !== null) {
      userLockedRef.current = true;
      initializedRef.current = true;
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

  /** Lectura inicial única (solo si el usuario aún no ha fijado el estado manualmente). */
  useEffect(() => {
    if (!toggleKey || userLockedRef.current || initializedRef.current) return;
    if (!telemetry || typeof telemetry !== 'object') return;
    if (telemetry[toggleKey] === undefined || telemetry[toggleKey] === null) return;
    initializedRef.current = true;
    setIsOn(readSwitchOnFromTelemetry(telemetry, toggleKey));
  }, [telemetry, toggleKey, scopeKey]);

  const setManualSwitchState = useCallback(
    (target) => {
      const next = Boolean(target);
      userLockedRef.current = true;
      initializedRef.current = true;
      writeStoredManualState(scopeKey, next);
      setIsOn(next);
    },
    [scopeKey]
  );

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
    setOptimisticTarget: setManualSwitchState,
  };
}
