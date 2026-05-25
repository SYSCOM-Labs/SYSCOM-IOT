import React, { useCallback, useMemo, useState } from 'react';
import { pushAppActivityLog } from '../../utils/appActivityLog';
import { sendDownlink } from '../../services/api';
import { readDownlinksFromLocalStorage, getDownlinkSendOptionsForDevice } from '../../services/deviceTemplates';
import BsdRealisticSwitch from './BsdRealisticSwitch';
import { usePersistentSwitchState } from './usePersistentSwitchState';
import { useSwitchAutomationSync } from './useSwitchAutomationSync';
import { pickSwitchDownlinkHexForToggle } from './switchDownlinkBinding';
function downlinkErrorMessage(err) {
  return err?.response?.data?.errMsg || err?.response?.data?.error || err?.message || 'Error al enviar downlink';
}

function loadDownlinksFromStorage(deviceId, deviceModel) {
  if (!deviceId) return [];
  try {
    const list = readDownlinksFromLocalStorage(deviceId, { deviceModel });
    return Array.isArray(list) ? list.filter((d) => d && String(d.hex || '').trim()) : [];
  } catch {
    return [];
  }
}

export default function BsdSwitchWidgetSlot({
  slotId,
  variant,
  device,
  controlDeviceId,
  canSendLnsCommands,
  dk,
  widgetConfigs,
  resolveWidgetBoundDeviceId,
  telemetryLivePropsForPanelWidget,
  liveProps,
  downlinkList,
  panelDevices,
  credentials,
  token,
  expandTelemetryLive,
  wTitle,
  wTitleStyle,
  mergeShell,
  dashWidgetChrome,
  openDashWidgetEdit,
}) {
  const targetDeviceId =
    variant === 'device' && device?.deviceId
      ? String(device.deviceId)
      : variant === 'panel'
        ? resolveWidgetBoundDeviceId(slotId)
        : controlDeviceId;

  const resolvePanelDeviceModel = useCallback(
    (devId) => {
      if (!devId) return '';
      const dev = (panelDevices || []).find((d) => String(d.deviceId) === String(devId));
      return dev?.model || dev?.productModel || '';
    },
    [panelDevices]
  );

  const switchWidgetDownlinkList = useMemo(() => {
    if (variant !== 'panel') return downlinkList;
    if (!targetDeviceId) return [];
    return loadDownlinksFromStorage(targetDeviceId, resolvePanelDeviceModel(targetDeviceId));
  }, [variant, downlinkList, targetDeviceId, resolvePanelDeviceModel]);

  const switchTelemetryForToggle = useMemo(() => {
    const raw = variant === 'panel' ? telemetryLivePropsForPanelWidget(slotId) : liveProps;
    return expandTelemetryLive ? expandTelemetryLive(raw) : raw || {};
  }, [variant, liveProps, telemetryLivePropsForPanelWidget, slotId, expandTelemetryLive]);

  const switchWidgetData = widgetConfigs[dk(slotId)]?.data;
  const switchTelemetryFieldCfg = switchWidgetData?.switchTelemetryField;
  const switchTelemetryField =
    typeof switchTelemetryFieldCfg === 'string' ? switchTelemetryFieldCfg.trim() : '';

  const { isOn: switchOn, setManualSwitchState, setAutomationSwitchState } = usePersistentSwitchState({
    telemetry: switchTelemetryForToggle,
    preferredFieldKey: switchTelemetryField,
    deviceId: targetDeviceId,
  });

  useSwitchAutomationSync({
    switchTargetDeviceId: targetDeviceId,
    switchWidgetData,
    switchWidgetDownlinkList,
    setAutomationSwitchState,
  });

  const [switchProcessing, setSwitchProcessing] = useState(false);

  const handleSwitchClick = useCallback(async () => {
    if (!canSendLnsCommands || !targetDeviceId || switchProcessing) return;
    const dls = switchWidgetDownlinkList;
    if (dls.length === 0) {
      window.alert('No hay downlinks guardados. Configúralos en Dispositivos → acciones → Downlink.');
      return;
    }
    const hex = pickSwitchDownlinkHexForToggle(switchOn, switchWidgetData, dls);
    if (!hex) {
      window.alert('Configura los downlinks ON y OFF del widget Switch.');
      return;
    }
    const switchRow =
      variant === 'device' && device
        ? device
        : (panelDevices || []).find((d) => String(d.deviceId) === String(targetDeviceId));
    const dlOpts = getDownlinkSendOptionsForDevice(targetDeviceId, switchRow);
    const previousOn = switchOn;
    const targetOn = !switchOn;
    setManualSwitchState(targetOn);
    setSwitchProcessing(true);
    try {
      await sendDownlink(targetDeviceId, hex, credentials, token, dlOpts);
    } catch (err) {
      setManualSwitchState(previousOn);
      const code = err.response?.data?.code;
      const st = err.response?.status;
      pushAppActivityLog({
        level: 'warn',
        tag: 'Downlink',
        message: `Intento switch · ${targetDeviceId}${code ? ` · ${code}` : st ? ` · HTTP ${st}` : ''}`,
        detail: err.response?.data?.errMsg || err.response?.data?.error || err.message,
      });
      window.alert(downlinkErrorMessage(err));
    } finally {
      setSwitchProcessing(false);
    }
  }, [
    canSendLnsCommands,
    targetDeviceId,
    switchProcessing,
    switchWidgetDownlinkList,
    switchOn,
    setManualSwitchState,
    credentials,
    token,
    switchWidgetData,
    variant,
    device,
    panelDevices,
  ]);

  return (
    <div
      key={slotId}
      {...mergeShell(slotId, 'widget bsd-control-widget bsd-switch-widget bsd-widget-editable')}
    >
      {dashWidgetChrome(slotId, (e) => {
        e.stopPropagation();
        openDashWidgetEdit(slotId, () => ({
          id: 0,
          name: 'Switch',
          value: switchOn ? 1 : 0,
          unit: '',
          icon: '⚡',
          threshold: 1,
          propertyKey: `__bsd_${slotId}`,
          sourceDeviceId: 'dashboard',
        }));
      })}
      <div className="widget-header">
        <div className="widget-title" style={wTitleStyle(slotId)}>
          <span className="bsd-control-ico">⚡</span> {wTitle(slotId, 'Switch')}
        </div>
      </div>
      <div className="bsd-switch-body">
        <BsdRealisticSwitch
          isOn={switchOn}
          busy={switchProcessing}
          disabled={!canSendLnsCommands || !targetDeviceId || switchWidgetDownlinkList.length === 0}
          onClick={handleSwitchClick}
        />
        {!canSendLnsCommands && (
          <p className="bsd-control-hint">Inicie sesión para enviar comandos LoRaWAN desde el panel.</p>
        )}
      </div>
    </div>
  );
}
