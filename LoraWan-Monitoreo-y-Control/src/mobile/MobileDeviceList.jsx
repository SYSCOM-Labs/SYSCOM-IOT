import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader, RefreshCw, Search } from 'lucide-react';
import { fetchDevices } from '../services/api';
import { getLatestDeviceData } from '../services/localAuth';
import { useAuth } from '../context/AuthContext';
import {
  applyStaleOfflineConnectStatus,
  isDeviceVisuallyOnline,
} from '../utils/deviceConnectionStatus';
import { deviceRowWithPreloadedTelemetry } from '../utils/deviceTelemetryPreload';
import { deviceMatchesListSearch } from '../utils/deviceListSearch';
import './MobileDeviceList.css';

function statusDotClass(device) {
  if (isDeviceVisuallyOnline(device)) return 'mobile-device-card__dot--online';
  const st = String(device.connectStatus || device.status || '').toLowerCase();
  if (st.includes('error') || st.includes('offline')) return 'mobile-device-card__dot--offline';
  return 'mobile-device-card__dot--idle';
}

export default function MobileDeviceList({ onOpenDevice }) {
  const { token } = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState('list');

  const load = useCallback(async (opts = {}) => {
    const silent = Boolean(opts.silent);
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const [listResp, latest] = await Promise.all([
        fetchDevices(),
        getLatestDeviceData().catch(() => []),
      ]);
      const raw = listResp?.data?.content || listResp?.content || [];
      const latestArr = Array.isArray(latest) ? latest : [];
      const merged = raw.map((d) => {
        const row = deviceRowWithPreloadedTelemetry(d);
        const hit = latestArr.find(
          (x) => String(x.deviceId) === String(d.deviceId) || String(x.deviceName) === String(d.name)
        );
        if (hit?.properties) {
          return applyStaleOfflineConnectStatus({ ...row, ...hit.properties, lastUpdateTime: hit.timestamp });
        }
        return applyStaleOfflineConnectStatus(row);
      });
      setDevices(merged);
    } catch (e) {
      setError(e?.message || 'No se pudieron cargar los dispositivos.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (token) load();
  }, [token, load]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return devices;
    return devices.filter((d) => deviceMatchesListSearch(d, q));
  }, [devices, query]);

  return (
    <div className="mobile-device-list">
      <header className="mobile-device-list__header">
        <h1>Dispositivos</h1>
        <button
          type="button"
          className="mobile-device-list__refresh"
          onClick={() => load({ silent: true })}
          disabled={refreshing}
          aria-label="Actualizar lista"
        >
          <RefreshCw size={20} className={refreshing ? 'mobile-spin' : ''} />
        </button>
      </header>

      <div className="mobile-device-list__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'list'}
          className={viewMode === 'list' ? 'is-active' : ''}
          onClick={() => setViewMode('list')}
        >
          Lista
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'gallery'}
          className={viewMode === 'gallery' ? 'is-active' : ''}
          onClick={() => setViewMode('gallery')}
        >
          Galería
        </button>
      </div>

      <div className="mobile-device-list__search">
        <Search size={18} aria-hidden />
        <input
          type="search"
          placeholder="Buscar dispositivo…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          aria-label="Buscar"
        />
      </div>

      {loading ? (
        <div className="mobile-device-list__state">
          <Loader size={28} className="mobile-spin" />
          <span>Cargando equipos…</span>
        </div>
      ) : error ? (
        <div className="mobile-device-list__state mobile-device-list__state--error">
          <p>{error}</p>
          <button type="button" onClick={() => load()}>
            Reintentar
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="mobile-device-list__state">
          <p>No hay dispositivos asignados a su cuenta.</p>
        </div>
      ) : (
        <ul className={`mobile-device-list__grid mobile-device-list__grid--${viewMode}`}>
          {filtered.map((d) => {
            const name = d.name || d.displayName || d.deviceId || 'Sin nombre';
            const id = String(d.deviceId || '');
            return (
              <li key={id}>
                <button type="button" className="mobile-device-card" onClick={() => onOpenDevice(d)}>
                  <span className={`mobile-device-card__dot ${statusDotClass(d)}`} aria-hidden />
                  <span className="mobile-device-card__body">
                    <span className="mobile-device-card__name">{name}</span>
                    <span className="mobile-device-card__id">{id}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
