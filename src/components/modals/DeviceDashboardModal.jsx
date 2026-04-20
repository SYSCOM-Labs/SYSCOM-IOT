import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { fetchDeviceProperties } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { getLatestDeviceData } from '../../services/localAuth';
import { applyStaleOfflineConnectStatus, isDeviceVisuallyOnline } from '../../utils/deviceConnectionStatus';
import BudgetSensorsDashboard from '../dashboard/BudgetSensorsDashboard';
import './DeviceDashboardModal.css';

/**
 * Vista detalle dispositivo: mismo dashboard premium que el Panel, con datos del equipo.
 */
const DeviceDashboardModal = ({ device: initialDevice, onClose }) => {
  const { credentials, token } = useAuth();
  const { t } = useLanguage();
  const [localDevice, setLocalDevice] = useState(initialDevice);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const mergeDeviceData = useCallback(async () => {
    const canonicalDeviceId = initialDevice.deviceId?.toString() || '';
    let apiData = {};
    let liveFromAPI = {};
    let localEntries = [];

    try {
      const propsResp = await fetchDeviceProperties(canonicalDeviceId, credentials, token);
      apiData = propsResp.data?.data || {};
      liveFromAPI = apiData.properties || propsResp.data?.properties || {};
    } catch (err) {
      console.warn('[DeviceDashboard] Properties fetch failed:', err.message);
    }

    try {
      localEntries = (await getLatestDeviceData()) || [];
    } catch (err) {
      console.warn('[DeviceDashboard] Local data fetch failed:', err.message);
    }

    const devId = initialDevice.deviceId?.toString();
    const devEUI = initialDevice.devEUI || initialDevice.devEui;
    const devName = initialDevice.name || initialDevice.deviceName;

    const localEntry = localEntries.find((d) => {
      if (d.deviceId?.toString() === devId) return true;
      if (devEUI && d.properties?.devEUI === devEUI) return true;
      if (devName && d.deviceName === devName) return true;
      return false;
    });

    const liveFromLocal = localEntry ? localEntry.properties || {} : {};
    const combinedLive = { ...initialDevice, ...liveFromAPI, ...liveFromLocal };
    const lastSeen = [apiData.lastTimestamp, localEntry?.timestamp, initialDevice.lastUpdateTime]
      .filter((x) => x != null)
      .map((x) => (typeof x === 'number' ? x : new Date(x).getTime()))
      .filter((n) => Number.isFinite(n));
    const lastUpdateTime = lastSeen.length ? Math.max(...lastSeen) : combinedLive.lastUpdateTime ?? null;

    setLocalDevice(
      applyStaleOfflineConnectStatus({
        ...combinedLive,
        lastUpdateTime,
      })
    );
  }, [initialDevice, credentials, token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await mergeDeviceData();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mergeDeviceData]);

  /** Sincronizar con la fila del listado cuando el padre refresca telemetría (poll / SSE). */
  useEffect(() => {
    if (!initialDevice) return;
    setLocalDevice((prev) => {
      if (!prev || String(prev.deviceId) !== String(initialDevice.deviceId)) {
        return applyStaleOfflineConnectStatus({ ...initialDevice });
      }
      return applyStaleOfflineConnectStatus({ ...prev, ...initialDevice });
    });
  }, [initialDevice]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await mergeDeviceData();
    } catch (err) {
      console.error('Refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const headerVisuallyOnline = isDeviceVisuallyOnline(localDevice);

  return (
    <div className="modal-overlay dashboard-overlay">
      <div className="modal-content dashboard-content glass device-bsd-modal">
        <header className="dashboard-header device-bsd-modal__chrome">
          <div className="device-id-info">
            <div className="title-group">
              <h2>{localDevice.name || t('devices.unnamed')}</h2>
              <span className="sn-badge">{localDevice.sn}</span>
            </div>
            <div className="status-badge-container">
              <span className={`status-pill ${headerVisuallyOnline ? 'online' : 'offline'}`}>
                {headerVisuallyOnline ? t('devices.online') : t('devices.offline')}
              </span>
            </div>
          </div>
          <div className="header-actions">
            <button type="button" className="btn-icon close-btn" onClick={onClose} aria-label="Cerrar">
              <X size={32} />
            </button>
          </div>
        </header>

        <div className="dashboard-body device-bsd-modal__body">
          <BudgetSensorsDashboard
            variant="device"
            device={localDevice}
            embedded
            loadingExternal={loading}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />
        </div>
      </div>
    </div>
  );
};

export default DeviceDashboardModal;
