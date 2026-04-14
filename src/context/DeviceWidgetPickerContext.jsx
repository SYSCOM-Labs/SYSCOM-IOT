import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const DeviceWidgetPickerContext = createContext(null);

/**
 * Encola un dispositivo para abrir el selector de widgets en el Panel y cambia a esa vista.
 */
export function DeviceWidgetPickerProvider({ children, onSwitchToDashboard }) {
  const [pendingDeviceId, setPendingDeviceId] = useState(null);

  const requestQuickWidgetPicker = useCallback(
    (deviceId) => {
      if (deviceId == null || deviceId === '') return;
      setPendingDeviceId(String(deviceId));
      onSwitchToDashboard?.();
    },
    [onSwitchToDashboard]
  );

  const clearPendingDeviceId = useCallback(() => setPendingDeviceId(null), []);

  const value = useMemo(
    () => ({
      pendingDeviceId,
      clearPendingDeviceId,
      requestQuickWidgetPicker,
    }),
    [pendingDeviceId, clearPendingDeviceId, requestQuickWidgetPicker]
  );

  return <DeviceWidgetPickerContext.Provider value={value}>{children}</DeviceWidgetPickerContext.Provider>;
}

export function useDeviceWidgetPicker() {
  const ctx = useContext(DeviceWidgetPickerContext);
  if (!ctx) {
    throw new Error('useDeviceWidgetPicker debe usarse dentro de DeviceWidgetPickerProvider');
  }
  return ctx;
}
