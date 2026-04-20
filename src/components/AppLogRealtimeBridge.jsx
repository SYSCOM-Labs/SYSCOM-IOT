import { useEffect, useRef } from 'react';
import { dispatchAppLog } from '../constants/appLog';
import { SYSCOM_LNS_DOWNLINK_SENT_EVENT } from '../services/api';
import { SYSCOM_REALTIME_LNS, SYSCOM_REALTIME_TELEMETRY } from '../constants/realtimeEvents';

function lnsCategory(eventType) {
  const t = String(eventType || '');
  if (t.includes('gateway') || t.includes('GW_TX') || t.includes('tx_reject') || t.includes('tx_ack')) {
    return 'gateway';
  }
  if (t.includes('downlink') || t.includes('join') || t.includes('mac')) {
    return 'action';
  }
  return 'realtime';
}

function lnsLevelAndSummary(d) {
  const et = String(d?.eventType || 'evento');
  const m = d?.meta && typeof d.meta === 'object' ? d.meta : {};
  const deui = d?.devEui ? String(d.devEui) : '';
  const deuiShort = deui ? `DevEUI ${deui}` : '';

  if (et === 'downlink_gateway_tx_ack') {
    const gw = m.gatewayEui || m.gateway_id || '';
    const ackErr = m.txpkAck?.error != null ? String(m.txpkAck.error) : m.error != null ? String(m.error) : '';
    const okAck = !ackErr || ackErr.toUpperCase() === 'NONE';
    const line = [
      'Gateway → confirmó TX (GW_TX_ACK)',
      gw ? `GW ${gw}` : null,
      m.fCnt != null ? `fCnt↓ ${m.fCnt}` : null,
      deuiShort || null,
      ackErr && !okAck ? `estado ${ackErr}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return { level: okAck ? 'info' : 'warn', message: line };
  }

  if (et === 'downlink_gateway_tx_reject') {
    const err = m.error || m.txpkAck?.error || 'rechazo';
    const gw = m.gatewayEui || '';
    const line = ['Gateway → rechazó TX', `motivo: ${err}`, gw ? `GW ${gw}` : null, deuiShort || null]
      .filter(Boolean)
      .join(' · ');
    return { level: 'error', message: line };
  }

  if (et === 'downlink_device_acked') {
    return {
      level: 'info',
      message: `Dispositivo → MAC ACK del downlink · ${deuiShort || 'DevEUI —'}`,
    };
  }

  return { level: 'info', message: `LNS: ${et}${deui ? ` · ${deuiShort}` : ''}` };
}

function telemetryHumanLine(deviceName, deviceId, props, batchCount) {
  const p = props && typeof props === 'object' ? props : {};
  const bits = [];
  if (p.fPort != null) bits.push(`fPort ${p.fPort}`);
  const fc = p.fcnt != null ? p.fcnt : p.fcnt_up != null ? p.fcnt_up : null;
  if (fc != null) bits.push(`FCnt↑ ${fc}`);
  if (p.payload_hex) {
    const hex = String(p.payload_hex);
    bits.push(`payload ${hex.length > 56 ? `${hex.slice(0, 56)}…` : hex}`);
  } else if (p.payload_b64) {
    bits.push('payload (base64 en detalle)');
  }
  if (p.gateway_id) bits.push(`GW ${String(p.gateway_id)}`);
  if (p.freq_mhz != null) bits.push(`${p.freq_mhz} MHz`);
  if (p.lora_snr != null) bits.push(`SNR ${p.lora_snr}`);
  if (p.lorawan_event) bits.push(String(p.lorawan_event));
  if (p.lora_downlink_device_acked) bits.push('MAC ACK uplink');

  const head = `${deviceName || deviceId} (${deviceId || '—'})`;
  if (batchCount > 1) {
    return bits.length ? `Telemetría ×${batchCount}: ${head} · último: ${bits.join(' · ')}` : `Telemetría ×${batchCount}: ${head}`;
  }
  return bits.length ? `Dispositivo → ${head}: ${bits.join(' · ')}` : `Dispositivo → ${head}`;
}

/**
 * Enlaza telemetría SSE, eventos LNS y downlink enviado al registro inferior (con payload en JSON al expandir).
 */
export default function AppLogRealtimeBridge() {
  const telCountRef = useRef(new Map());
  const telFlushRef = useRef(null);

  useEffect(() => {
    const onTel = (ev) => {
      const d = ev.detail || {};
      const deviceId = d.deviceId != null ? String(d.deviceId) : '';
      const deviceName = d.deviceName != null ? String(d.deviceName) : deviceId;
      const ts = d.timestamp != null ? Number(d.timestamp) : Date.now();

      const map = telCountRef.current;
      const cur = map.get(deviceId) || { n: 0, lastTs: ts, deviceName, lastProps: null };
      cur.n += 1;
      cur.lastTs = ts;
      cur.deviceName = deviceName;
      if (d.properties && typeof d.properties === 'object') {
        cur.lastProps = d.properties;
      }
      map.set(deviceId, cur);

      if (telFlushRef.current) return;
      telFlushRef.current = window.setTimeout(() => {
        telFlushRef.current = null;
        const m = telCountRef.current;
        telCountRef.current = new Map();
        for (const [did, v] of m) {
          const label = v.deviceName || did;
          const msg = telemetryHumanLine(label, did, v.lastProps, v.n);
          dispatchAppLog('info', msg, {
            category: 'sensor',
            data: {
              deviceId: did,
              deviceName: v.deviceName,
              timestamp: v.lastTs,
              batchCount: v.n,
              properties: v.lastProps,
            },
          });
        }
      }, 450);
    };

    window.addEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
    return () => {
      window.removeEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
      if (telFlushRef.current) {
        window.clearTimeout(telFlushRef.current);
        telFlushRef.current = null;
      }
    };
  }, []);

  const lnsSeenRef = useRef(new Set());

  useEffect(() => {
    const onLns = (ev) => {
      const d = ev.detail || {};
      const id = d.id;
      if (id != null && String(id) !== '') {
        const key = String(id);
        if (lnsSeenRef.current.has(key)) return;
        lnsSeenRef.current.add(key);
        if (lnsSeenRef.current.size > 300) {
          const arr = [...lnsSeenRef.current];
          lnsSeenRef.current = new Set(arr.slice(-150));
        }
      }
      const { level, message } = lnsLevelAndSummary(d);
      dispatchAppLog(level, message, {
        category: lnsCategory(d.eventType),
        data: d,
      });
    };
    window.addEventListener(SYSCOM_REALTIME_LNS, onLns);
    return () => window.removeEventListener(SYSCOM_REALTIME_LNS, onLns);
  }, []);

  useEffect(() => {
    const onSent = (ev) => {
      const d = ev.detail || {};
      if (d.kind === 'service_call') {
        dispatchAppLog('info', `Acción → llamada a servicio "${d.serviceId || '—'}" · dispositivo ${d.deviceId || '—'}`, {
          category: 'action',
          data: d,
        });
        return;
      }
      const hexLen = d.payloadHexLength != null ? Number(d.payloadHexLength) : null;
      const parts = [
        'Downlink → enviado al servidor LNS',
        d.deviceId ? `dispositivo ${d.deviceId}` : null,
        d.fPort != null ? `fPort ${d.fPort}` : null,
        d.confirmed ? 'confirmado' : 'no confirmado',
        hexLen != null && Number.isFinite(hexLen) ? `payload ${hexLen / 2} B` : null,
        d.fCnt != null ? `fCnt↓ ${d.fCnt}` : null,
      ].filter(Boolean);
      dispatchAppLog('info', parts.join(' · '), {
        category: 'action',
        data: d,
      });
    };
    window.addEventListener(SYSCOM_LNS_DOWNLINK_SENT_EVENT, onSent);
    return () => window.removeEventListener(SYSCOM_LNS_DOWNLINK_SENT_EVENT, onSent);
  }, []);

  return null;
}
