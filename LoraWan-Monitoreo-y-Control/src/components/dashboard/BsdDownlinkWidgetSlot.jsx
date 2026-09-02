import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { pushAppActivityLog } from '../../utils/appActivityLog';
import { sendDownlink } from '../../services/api';
import { readDownlinksFromLocalStorage, getDownlinkSendOptionsForDevice } from '../../services/deviceTemplates';
import {
  ensureDownlinkButtonsDraft,
  normalizeDownlinkHex,
  parseCssHex,
  resolveDownlinkButtonTextColor,
} from './widgetConfigUtils';

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

export default function BsdDownlinkWidgetSlot({
  slotId,
  variant,
  device,
  controlDeviceId,
  canSendLnsCommands,
  dk,
  widgetConfigs,
  resolveWidgetBoundDeviceId,
  downlinkList,
  panelDevices,
  credentials,
  token,
  isDemo = false,
  lastTelemetryAtLabel,
  wTitle,
  wTitleStyle,
  mergeShell,
  dashWidgetChrome,
  openDashWidgetEdit,
}) {
  const downlinkSendingHexRef = useRef(new Set());
  const [downlinkSendingVersion, setDownlinkSendingVersion] = useState(0);

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

  const downlinkWidgetDownlinkList = useMemo(() => {
    if (variant !== 'panel') return downlinkList;
    if (!targetDeviceId) return [];
    return loadDownlinksFromStorage(targetDeviceId, resolvePanelDeviceModel(targetDeviceId));
  }, [variant, downlinkList, targetDeviceId, resolvePanelDeviceModel]);

  const panelDownlinkActions = useMemo(() => {
    const cfgData = widgetConfigs[dk(slotId)]?.data || {};
    const ensured = ensureDownlinkButtonsDraft(cfgData);
    const fromRows = (ensured.downlinkButtons || [])
      .map((r) => {
        const n = normalizeDownlinkHex(r.hex);
        if (!n) return null;
        if (isDemo) {
          const label = String(r.label || '').trim() || 'Comando';
          const buttonColor = parseCssHex(r.buttonColor) || '';
          return { hex: n, label, buttonColor };
        }
        const hit = downlinkWidgetDownlinkList.find((d) => normalizeDownlinkHex(d.hex) === n);
        if (!hit) return null;
        const label = String(r.label || '').trim() || String(hit.name || '').trim() || 'Enviar';
        const buttonColor = parseCssHex(r.buttonColor) || '';
        return { hex: hit.hex, label, buttonColor };
      })
      .filter(Boolean);
    if (fromRows.length) return fromRows;
    const legacy = normalizeDownlinkHex(cfgData.downlinkDefaultHex);
    if (legacy) {
      const hit = downlinkWidgetDownlinkList.find((d) => normalizeDownlinkHex(d.hex) === legacy);
      if (hit) {
        return [{ hex: hit.hex, label: String(hit.name || '').trim() || 'Enviar comando', buttonColor: '' }];
      }
    }
    if (downlinkWidgetDownlinkList[0]) {
      return [
        {
          hex: downlinkWidgetDownlinkList[0].hex,
          label: String(downlinkWidgetDownlinkList[0].name || '').trim() || 'Enviar comando',
          buttonColor: '',
        },
      ];
    }
    return [];
  }, [downlinkWidgetDownlinkList, widgetConfigs, dk, slotId, isDemo]);

  const downlinkWidgetTitleColor = useMemo(
    () => widgetConfigs[dk(slotId)]?.appearance?.titleColor || '#f97316',
    [widgetConfigs, dk, slotId]
  );

  const handlePanelDownlinkClick = useCallback(
    async (hex) => {
      const n = normalizeDownlinkHex(hex);
      const dl = downlinkWidgetDownlinkList.find((d) => normalizeDownlinkHex(d.hex) === n);
      if (!canSendLnsCommands || !targetDeviceId || !dl) return;
      if (downlinkSendingHexRef.current.has(n)) return;
      downlinkSendingHexRef.current.add(n);
      setDownlinkSendingVersion((v) => v + 1);
      const sendingSafetyMs = 45000;
      const sendingSafetyId = window.setTimeout(() => {
        if (downlinkSendingHexRef.current.delete(n)) {
          setDownlinkSendingVersion((v) => v + 1);
        }
      }, sendingSafetyMs);
      const dlRow =
        variant === 'device' && device
          ? device
          : (panelDevices || []).find((d) => String(d.deviceId) === String(targetDeviceId));
      const dlOpts = getDownlinkSendOptionsForDevice(targetDeviceId, dlRow);
      try {
        await sendDownlink(targetDeviceId, dl.hex, credentials, token, dlOpts);
      } catch (err) {
        const code = err.response?.data?.code;
        const st = err.response?.status;
        const deferred = err.response?.data?.deferred;
        pushAppActivityLog({
          level: deferred ? 'info' : 'warn',
          tag: 'Downlink',
          message: deferred
            ? `Encolado (próximo uplink) · ${targetDeviceId}`
            : `Intento · ${targetDeviceId}${code ? ` · ${code}` : st ? ` · HTTP ${st}` : ''}`,
          detail: err.response?.data?.errMsg || err.response?.data?.error || err.message,
        });
        window.alert(`${dl.name || 'Downlink'}: ${downlinkErrorMessage(err)}`);
      } finally {
        window.clearTimeout(sendingSafetyId);
        downlinkSendingHexRef.current.delete(n);
        setDownlinkSendingVersion((v) => v + 1);
      }
    },
    [canSendLnsCommands, targetDeviceId, downlinkWidgetDownlinkList, credentials, token, variant, device, panelDevices]
  );

  return (
    <div
      key={slotId}
      {...mergeShell(slotId, 'widget bsd-control-widget bsd-widget-editable bsd-downlink-widget')}
    >
      {dashWidgetChrome(slotId, (e) => {
        e.stopPropagation();
        openDashWidgetEdit(slotId, () => ({
          id: 0,
          name: 'Downlink',
          value: downlinkWidgetDownlinkList.length,
          unit: 'cmds',
          icon: '⚡',
          threshold: 10,
          propertyKey: `__bsd_${slotId}`,
          sourceDeviceId: 'dashboard',
        }));
      })}
      <div className="widget-header">
        <div className="widget-title" style={wTitleStyle(slotId)}>
          <Zap size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(slotId, 'Downlink')}
        </div>
      </div>
      <div className="bsd-downlink-widget-body">
        {panelDownlinkActions.length > 0 ? (
          <div className="bsd-downlink-stack" data-downlink-sending={downlinkSendingVersion}>
            {panelDownlinkActions.map((act, i) => {
              const hexKey = normalizeDownlinkHex(act.hex);
              const isSending = downlinkSendingHexRef.current.has(hexKey);
              return (
                <button
                  key={`${hexKey}_${i}`}
                  type="button"
                  className={`bsd-downlink-btn bsd-downlink-btn--send${isSending ? ' bsd-downlink-btn--sending' : ''}`}
                  disabled={isDemo || !canSendLnsCommands || !targetDeviceId || isSending}
                  aria-busy={isSending}
                  onClick={() => handlePanelDownlinkClick(act.hex)}
                  style={
                    act.buttonColor
                      ? {
                          background: act.buttonColor,
                          color: resolveDownlinkButtonTextColor(downlinkWidgetTitleColor, act.buttonColor),
                          borderColor: 'rgba(255, 255, 255, 0.22)',
                        }
                      : undefined
                  }
                >
                  {isSending ? 'Enviando…' : act.label}
                </button>
              );
            })}
          </div>
        ) : downlinkWidgetDownlinkList.length === 0 ? (
          <div className="bsd-control-hint">
            Sin comandos guardados. Créalos en la ficha del dispositivo → Downlink y define los botones en Editar widget →
            Datos.
          </div>
        ) : (
          <div className="bsd-control-hint">Añade al menos un comando con HEX válido en Editar widget → Datos.</div>
        )}
      </div>
      {isDemo ? (
        <p className="bsd-control-hint">Cuenta demo: los botones no envían comandos reales.</p>
      ) : !canSendLnsCommands ? (
        <p className="bsd-control-hint">Inicie sesión para enviar downlinks desde el panel.</p>
      ) : null}
      {lastTelemetryAtLabel ? (
        <div className="bsd-widget-footnote" style={wTitleStyle(slotId)}>
          {lastTelemetryAtLabel}
        </div>
      ) : null}
    </div>
  );
}
