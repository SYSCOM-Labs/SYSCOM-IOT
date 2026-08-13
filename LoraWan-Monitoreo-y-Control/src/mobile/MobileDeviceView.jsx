import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { fetchDeviceProperties } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { getLatestDeviceData } from '../services/localAuth';
import { applyStaleOfflineConnectStatus, isDeviceVisuallyOnline } from '../utils/deviceConnectionStatus';
import { hasMeaningfulAppTelemetry, mergeDeviceTelemetryForWidgets } from '../utils/gatewayPayload';
import {
  deviceRowWithPreloadedTelemetry,
  getDeviceTelemetryPreload,
  isDeviceTelemetryPreloadFresh,
  setDeviceTelemetryPreload,
} from '../utils/deviceTelemetryPreload';
import BudgetSensorsDashboard from '../components/dashboard/BudgetSensorsDashboard';
import SyscomRealtimeBridge from '../components/SyscomRealtimeBridge';
import './MobileDeviceView.css';

export default function MobileDeviceView({ device: initialDevice, onBack }) {
  const { credentials, token } = useAuth();
  const [localDevice, setLocalDevice] = useState(() =>
    applyStaleOfflineConnectStatus(deviceRowWithPreloadedTelemetry(initialDevice))
  );
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setLocalDevice(applyStaleOfflineConnectStatus(deviceRowWithPreloadedTelemetry(initialDevice)));
  }, [initialDevice]);

  const mergeDeviceData = useCallback(async (opts = {}) => {
    const force = Boolean(opts.force);
    const canonicalDeviceId = initialDevice.deviceId?.toString() || '';
    if (!force && isDeviceTelemetryPreloadFresh(canonicalDeviceId, 45000)) {
      const hit = getDeviceTelemetryPreload(canonicalDeviceId);
      if (hit?.flat && hasMeaningfulAppTelemetry(hit.flat)) {
        setLocalDevice(
          applyStaleOfflineConnectStatus({
            ...initialDevice,
            ...hit.flat,
            lastUpdateTime: hit.flat.lastUpdateTime ?? initialDevice.lastUpdateTime ?? null,
          })
        );
        return;
      }
    }
    const [propsResp, localEntries] = await Promise.all([
      fetchDeviceProperties(canonicalDeviceId, credentials, token).catch(() => null),
      getLatestDeviceData().catch(() => []),
    ]);
    let apiData = {};
    let liveFromAPI = {};
    if (propsResp) {
      apiData = propsResp.data?.data || {};
      liveFromAPI = apiData.properties || propsResp.data?.properties || {};
    }
    const devId = initialDevice.deviceId?.toString();
    const localEntry = (Array.isArray(localEntries) ? localEntries : []).find(
      (d) => d.deviceId?.toString() === devId
    );
    const liveFromLocal = localEntry ? localEntry.properties || {} : {};
    const flattened = mergeDeviceTelemetryForWidgets(initialDevice, liveFromAPI, liveFromLocal);
    const lastSeen = [apiData.lastTimestamp, localEntry?.timestamp, initialDevice.lastUpdateTime, flattened.lastUpdateTime]
      .filter((x) => x != null)
      .map((x) => (typeof x === 'number' ? x : new Date(x).getTime()))
      .filter((n) => Number.isFinite(n));
    const lastUpdateTime = lastSeen.length ? Math.max(...lastSeen) : flattened.lastUpdateTime ?? null;
    setDeviceTelemetryPreload(canonicalDeviceId, flattened);
    setLocalDevice(
      applyStaleOfflineConnectStatus({
        ...initialDevice,
        ...flattened,
        lastUpdateTime,
      })
    );
  }, [initialDevice, credentials, token]);

  useEffect(() => {
    mergeDeviceData({ force: true });
  }, [mergeDeviceData, initialDevice.deviceId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await mergeDeviceData({ force: true });
    } finally {
      setRefreshing(false);
    }
  };

  const preloadedLive = useMemo(() => mergeDeviceTelemetryForWidgets(localDevice), [localDevice]);
  const online = isDeviceVisuallyOnline(localDevice);
  const title = localDevice.name || localDevice.displayName || localDevice.deviceId;

  return (
    <div className="mobile-device-view">
      <SyscomRealtimeBridge />
      <header className="mobile-device-view__header">
        <button type="button" className="mobile-device-view__back" onClick={onBack} aria-label="Volver">
          <ArrowLeft size={22} />
        </button>
        <div className="mobile-device-view__titles">
          <h1>{title}</h1>
          <span className={`mobile-device-view__status ${online ? 'is-online' : ''}`}>
            {online ? 'En línea' : 'Sin señal reciente'}
          </span>
        </div>
        <button
          type="button"
          className="mobile-device-view__refresh"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Actualizar"
        >
          <RefreshCw size={20} className={refreshing ? 'mobile-spin' : ''} />
        </button>
      </header>
      <div className="mobile-device-view__body">
        <BudgetSensorsDashboard
          variant="device"
          device={localDevice}
          preloadedTelemetry={preloadedLive}
          embedded
          readOnlyView
          loadingExternal={false}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />
      </div>
    </div>
  );
}
