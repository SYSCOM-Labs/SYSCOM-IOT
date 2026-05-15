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
 * Vista detalle dispositivo: mismo `BudgetSensorsDashboard` que Panel Control (`variant="panel"`),
 * con `variant="device"` y datos del equipo; no es un tablero duplicado.
 */
const DeviceDashboardModal = ({ device: initialDevice, onClose }) => {
  const { credentials, token } = useAuth();
  const { t } = useLanguage();
  /** Datos del listado al instante; `BudgetSensorsDashboard` ya fusiona API + SQLite en vivo (`mergeDeviceLive`). */
  const [localDevice, setLocalDevice] = useState(() => applyStaleOfflineConnectStatus(initialDevice));
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setLocalDevice(applyStaleOfflineConnectStatus(initialDevice));
  }, [initialDevice]);

  const mergeDeviceData = useCallback(async () => {
    const canonicalDeviceId = initialDevice.deviceId?.toString() || '';
    const [propsResp, localEntries] = await Promise.all([
      fetchDeviceProperties(canonicalDeviceId, credentials, token).catch((err) => {
        console.warn('[DeviceDashboard] Properties fetch failed:', err.message);
        return null;
      }),
      getLatestDeviceData().catch((err) => {
        console.warn('[DeviceDashboard] Local data fetch failed:', err.message);
        return [];
      }),
    ]);

    let apiData = {};
    let liveFromAPI = {};
    if (propsResp) {
      apiData = propsResp.data?.data || {};
      liveFromAPI = apiData.properties || propsResp.data?.properties || {};
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
            loadingExternal={false}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />
        </div>
      </div>
    </div>
  );
};

export default DeviceDashboardModal;
