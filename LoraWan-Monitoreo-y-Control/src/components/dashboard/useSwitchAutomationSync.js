import { useEffect, useMemo } from 'react';
import { SYSCOM_REALTIME_LNS } from '../../constants/realtimeEvents';
import {
  inferSwitchStateFromDownlinkHex,
  parseAutomationDownlinkLnsEvent,
  resolveSwitchDownlinkHexPair,
} from './switchDownlinkBinding';

/**
 * Actualiza el switch cuando una regla de automatización encola/envía un downlink
 * que coincide con los HEX ON/OFF configurados en el widget.
 */
export function useSwitchAutomationSync({
  switchTargetDeviceId,
  switchWidgetData,
  switchWidgetDownlinkList,
  setAutomationSwitchState,
}) {
  const hexPair = useMemo(
    () => resolveSwitchDownlinkHexPair(switchWidgetData, switchWidgetDownlinkList),
    [switchWidgetData, switchWidgetDownlinkList]
  );

  useEffect(() => {
    const devId = switchTargetDeviceId != null ? String(switchTargetDeviceId).trim() : '';
    if (!devId || !setAutomationSwitchState) return undefined;
    if (!hexPair.onHex && !hexPair.offHex) return undefined;

    const onLns = (ev) => {
      const parsed = parseAutomationDownlinkLnsEvent(ev?.detail);
      if (!parsed || String(parsed.deviceId) !== devId) return;
      const nextOn = inferSwitchStateFromDownlinkHex(parsed.payloadHex, hexPair);
      if (nextOn === null) return;
      setAutomationSwitchState(nextOn);
    };

    window.addEventListener(SYSCOM_REALTIME_LNS, onLns);
    return () => window.removeEventListener(SYSCOM_REALTIME_LNS, onLns);
  }, [switchTargetDeviceId, hexPair, setAutomationSwitchState]);
}
