import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Calendar,
  Download,
  Database,
  Settings,
  Loader,
  AlertTriangle,
  FileSpreadsheet,
  CheckSquare,
  Square,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { fetchDevices, fetchDeviceHistory, fetchDeviceTsl, fetchDeviceProperties } from '../services/api';
import { queryTelemetry, getLatestDeviceData } from '../services/localAuth';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../utils/gatewayPayload';
import { getTelemetryPropertyValue } from '../utils/telemetryPropertyPath';
import {
  downloadReportCsv,
  downloadReportPdf,
  formatReportDate,
  formatReportValue,
} from '../utils/reportsExport';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './History.css';

const RE_LNS_KEY = /^(nwk|app)[_]?s[_]?key(\.|$)|^appskey(\.|$)/i;
const TELEMETRY_PAGE_LIMIT = 4000;

function startOfDayMs(dateStr) {
  if (!dateStr) return NaN;
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getTime();
}

function endOfDayMs(dateStr) {
  if (!dateStr) return NaN;
  const d = new Date(`${dateStr}T23:59:59.999`);
  return d.getTime();
}

function deviceLabel(device) {
  if (!device) return '—';
  const name = device.name || device.deviceName;
  if (name && String(name).trim()) return String(name).trim();
  return String(device.deviceId ?? device.sn ?? '—');
}

async function fetchTelemetryRange(deviceId, propKey, startMs, endMs, credentials, token) {
  let results = [];
  try {
    const localData = await queryTelemetry(deviceId, propKey, startMs, endMs, TELEMETRY_PAGE_LIMIT);
    if (localData?.length) {
      results = localData
        .filter(
          (item) =>
            item &&
            (item.deviceId == null || String(item.deviceId) === String(deviceId))
        )
        .map((item) => ({
          ts: item.timestamp ?? item.ts,
          properties: item.properties || {},
        }));
    }
  } catch (e) {
    console.warn('[Reports] queryTelemetry', deviceId, e?.message || e);
  }
  if (results.length === 0) {
    const resp = await fetchDeviceHistory(
      deviceId,
      { startTime: startMs, endTime: endMs, pageSize: TELEMETRY_PAGE_LIMIT, order: 'asc' },
      credentials,
      token
    );
    const list = resp.list || resp.data?.list || [];
    results = list.map((item) => ({
      ts: item.timestamp ?? item.ts,
      properties: item.properties || {},
    }));
  }
  return results;
}

async function discoverPropertiesForDevice(deviceId, credentials, token) {
  const out = new Map();
  const addKey = (key, name) => {
    const k = String(key || '').trim();
    if (!k || RE_LNS_KEY.test(k)) return;
    if (!out.has(k)) out.set(k, { propertyKey: k, name: name || k });
  };

  try {
    const [tslResp, propsResp, localResp] = await Promise.all([
      fetchDeviceTsl(deviceId, credentials, token),
      fetchDeviceProperties(deviceId, credentials, token),
      getLatestDeviceData(),
    ]);

    let props = tslResp.data?.data?.properties || tslResp.data?.properties || tslResp.properties || [];
    if (Array.isArray(props)) {
      props.forEach((p) => {
        if (p?.propertyKey != null) addKey(p.propertyKey, p.name || p.propertyKey);
      });
    }

    const liveFromAPI = propsResp.data?.properties || propsResp.data?.data?.properties || {};
    const sel = String(deviceId);
    const localEntry = (localResp || []).find((d) => d && d.deviceId != null && String(d.deviceId) === sel);
    const combined = expandNestedGatewayTelemetry({ ...liveFromAPI, ...(localEntry?.properties || {}) });
    const ignore = new Set(PROPERTY_INFER_IGNORE_KEYS);
    Object.keys(combined).forEach((key) => {
      if (ignore.has(key) || String(key).endsWith('_alarm')) return;
      const v = combined[key];
      if (v != null && typeof v !== 'object' && !Array.isArray(v)) addKey(key, key);
    });
  } catch (e) {
    console.warn('[Reports] discoverProperties', deviceId, e?.message || e);
  }

  return out;
}

const HistoryPage = () => {
  const { credentials, token } = useAuth();
  const { t } = useLanguage();

  const [devices, setDevices] = useState([]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState(() => new Set());
  const [properties, setProperties] = useState([]);
  const [selectedPropKey, setSelectedPropKey] = useState('');

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  const [reportRows, setReportRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingProps, setLoadingProps] = useState(false);
  const [error, setError] = useState(null);
  const propsLoadSeqRef = useRef(0);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const resp = await fetchDevices(credentials, token);
        const list = resp.data?.data?.content || resp.data?.content || [];
        setDevices(list);
      } catch (err) {
        console.error('Failed to load devices', err);
      }
    };
    if (token) loadDevices();
  }, [token, credentials]);

  const selectedDevices = useMemo(
    () => devices.filter((d) => selectedDeviceIds.has(String(d.deviceId))),
    [devices, selectedDeviceIds]
  );

  const loadPropertiesForSelection = useCallback(async () => {
    const ids = [...selectedDeviceIds];
    if (!ids.length || !token) {
      setProperties([]);
      setSelectedPropKey('');
      return;
    }

    const loadId = ++propsLoadSeqRef.current;
    setLoadingProps(true);
    try {
      const merged = new Map();
      for (const id of ids) {
        const part = await discoverPropertiesForDevice(id, credentials, token);
        part.forEach((v, k) => {
          if (!merged.has(k)) merged.set(k, v);
        });
      }
      if (loadId !== propsLoadSeqRef.current) return;
      const list = [...merged.values()].sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
      );
      setProperties(list);
      setSelectedPropKey((prev) => (list.some((p) => p.propertyKey === prev) ? prev : list[0]?.propertyKey || ''));
    } finally {
      if (loadId === propsLoadSeqRef.current) setLoadingProps(false);
    }
  }, [selectedDeviceIds, token, credentials]);

  useEffect(() => {
    loadPropertiesForSelection();
  }, [loadPropertiesForSelection]);

  const toggleDevice = (deviceId) => {
    const id = String(deviceId);
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllDevices = () => {
    setSelectedDeviceIds(new Set(devices.map((d) => String(d.deviceId))));
  };

  const clearDeviceSelection = () => {
    setSelectedDeviceIds(new Set());
  };

  const handleGenerateReport = async () => {
    if (selectedDeviceIds.size === 0) {
      alert(t('reports.select_devices_alert'));
      return;
    }
    if (!selectedPropKey) {
      alert(t('reports.select_variable_alert'));
      return;
    }

    const startMs = startOfDayMs(dateFrom);
    const endMs = endOfDayMs(dateTo);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      alert(t('reports.invalid_dates'));
      return;
    }
    if (startMs > endMs) {
      alert(t('reports.date_order'));
      return;
    }

    setLoading(true);
    setError(null);
    setReportRows([]);

    try {
      const rows = [];
      for (const device of selectedDevices) {
        const id = device.deviceId;
        const label = deviceLabel(device);
        const raw = await fetchTelemetryRange(id, selectedPropKey, startMs, endMs, credentials, token);
        for (const item of raw) {
          const ts = Number(item.ts);
          if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
          const val = getTelemetryPropertyValue(item.properties, selectedPropKey);
          if (val === undefined || val === null) continue;
          rows.push({
            deviceLabel: label,
            deviceId: String(id),
            date: formatReportDate(ts),
            value: formatReportValue(val),
            ts,
          });
        }
      }
      rows.sort((a, b) => a.deviceLabel.localeCompare(b.deviceLabel) || a.ts - b.ts);
      setReportRows(rows);
      if (rows.length === 0) setError(t('reports.empty'));
    } catch (err) {
      console.error(err);
      setError(err?.message || t('reports.error'));
    } finally {
      setLoading(false);
    }
  };

  const variableLabel =
    properties.find((p) => p.propertyKey === selectedPropKey)?.name || selectedPropKey || '—';

  const rangeLabel = `${dateFrom} — ${dateTo}`;
  const filenameBase = `reporte_${selectedPropKey || 'telemetria'}_${dateFrom}_${dateTo}`.replace(
    /[^\w.-]+/g,
    '_'
  );

  const exportMeta = {
    title: t('reports.title'),
    variableLabel,
    rangeLabel,
  };

  return (
    <div className="history-page reports-page device-list-page device-list-page--premium premium-shell">
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <FileSpreadsheet size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">{t('reports.title')}</span>
          </h1>
          <p className="premium-hero-subtitle">{t('reports.subtitle')}</p>
        </div>
      </div>

      <div className="reports-panel glass card">
        <div className="reports-panel-grid">
          <section className="reports-section">
            <h3 className="reports-section-title">
              <Database size={16} /> {t('reports.devices_section')}
            </h3>
            <div className="reports-device-toolbar">
              <button type="button" className="btn btn-secondary reports-link-btn" onClick={selectAllDevices}>
                <CheckSquare size={14} /> {t('reports.select_all')}
              </button>
              <button type="button" className="btn btn-secondary reports-link-btn" onClick={clearDeviceSelection}>
                <Square size={14} /> {t('reports.clear_selection')}
              </button>
              <span className="reports-device-count">
                {selectedDeviceIds.size} / {devices.length}
              </span>
            </div>
            <div className="reports-device-list" role="listbox" aria-multiselectable="true">
              {devices.length === 0 ? (
                <p className="reports-muted">{t('reports.no_devices')}</p>
              ) : (
                devices.map((d) => {
                  const id = String(d.deviceId);
                  const checked = selectedDeviceIds.has(id);
                  return (
                    <label key={id} className={`reports-device-row ${checked ? 'is-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDevice(d.deviceId)}
                      />
                      <span className="reports-device-name">{deviceLabel(d)}</span>
                      <span className="reports-device-id">{id}</span>
                    </label>
                  );
                })
              )}
            </div>
          </section>

          <section className="reports-section reports-section--filters">
            <h3 className="reports-section-title">
              <Settings size={16} /> {t('reports.filters_section')}
            </h3>

            <div className="filter-group">
              <label>{t('reports.variable')}</label>
              <select
                value={selectedPropKey}
                onChange={(e) => setSelectedPropKey(e.target.value)}
                className="glass"
                disabled={loadingProps || selectedDeviceIds.size === 0}
              >
                {properties.length === 0 ? (
                  <option value="">{t('reports.no_variables')}</option>
                ) : (
                  properties.map((p) => (
                    <option key={p.propertyKey} value={p.propertyKey}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="reports-date-row">
              <div className="filter-group">
                <label>
                  <Calendar size={14} /> {t('reports.date_from')}
                </label>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="glass" />
              </div>
              <div className="filter-group">
                <label>
                  <Calendar size={14} /> {t('reports.date_to')}
                </label>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="glass" />
              </div>
            </div>

            <button
              type="button"
              className="btn btn-accent reports-generate-btn"
              onClick={handleGenerateReport}
              disabled={loading || selectedDeviceIds.size === 0}
            >
              {loading ? <Loader className="spin" size={18} /> : <FileSpreadsheet size={18} />}
              {t('reports.generate_btn')}
            </button>
          </section>
        </div>
      </div>

      {error && (
        <div className="error-message glass reports-error">
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      {reportRows.length > 0 && (
        <div className="reports-result glass card">
          <div className="reports-result-header">
            <h3>{t('reports.preview_title')}</h3>
            <div className="reports-download-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => downloadReportCsv(reportRows, filenameBase)}
              >
                <Download size={16} /> {t('reports.download_csv')}
              </button>
              <button
                type="button"
                className="btn btn-primary device-create-top-btn"
                onClick={() => downloadReportPdf(reportRows, exportMeta, filenameBase)}
              >
                <Download size={16} /> {t('reports.download_pdf')}
              </button>
            </div>
          </div>
          <p className="reports-result-meta">
            {reportRows.length} {t('reports.rows_label')} · {variableLabel} · {rangeLabel}
          </p>
          <div className="table-wrapper reports-table-wrap">
            <table className="log-table reports-table">
              <thead>
                <tr>
                  <th>{t('reports.col_device')}</th>
                  <th>{t('reports.col_date')}</th>
                  <th>{t('reports.col_value')}</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.slice(0, 500).map((row, i) => (
                  <tr key={`${row.deviceId}-${row.ts}-${i}`}>
                    <td>{row.deviceLabel}</td>
                    <td>{row.date}</td>
                    <td>{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reportRows.length > 500 && (
              <p className="reports-muted reports-preview-note">{t('reports.preview_truncated')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryPage;
