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
  Search,
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
  compareReportDeviceLabels,
  countReportDataRows,
} from '../utils/reportsExport';
import { deviceMatchesListSearch, deviceDevEuiDisplay } from '../utils/deviceListSearch';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './History.css';

const RE_LNS_KEY = /^(nwk|app)[_]?s[_]?key(\.|$)|^appskey(\.|$)/i;
const TELEMETRY_PAGE_LIMIT = 4000;

/** Metadatos LNS / sesión — no son variables de proceso para reportes. */
const REPORT_PROP_IGNORE = new Set([
  ...PROPERTY_INFER_IGNORE_KEYS,
  'awaitingConfirmedDlAck',
  'pendingMacAck',
  'lastAppUplinkMs',
  'last_update',
  'gateway_id',
  'fcntUp',
  'fcntDown',
  'lastUplinkWallMs',
  'lastRxTmst',
  'lastRxFreq',
  'lastRxDatr',
  'lastRxCodr',
  'lastRxRfch',
  'classBPingPeriodicity',
  'classBDataRate',
  'rxDelaySec',
  'deviceClass',
]);

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

function sortDevicesForReport(devices) {
  return [...devices].sort((a, b) => compareReportDeviceLabels(deviceLabel(a), deviceLabel(b)));
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
    if (!k || RE_LNS_KEY.test(k) || REPORT_PROP_IGNORE.has(k)) return;
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
    Object.keys(combined).forEach((key) => {
      if (REPORT_PROP_IGNORE.has(key) || String(key).endsWith('_alarm')) return;
      const v = combined[key];
      if (v != null && typeof v !== 'object' && !Array.isArray(v)) addKey(key, key);
    });
  } catch (e) {
    console.warn('[Reports] discoverProperties', deviceId, e?.message || e);
  }

  return [...out.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
  );
}

const HistoryPage = () => {
  const { credentials, token } = useAuth();
  const { t } = useLanguage();

  const [devices, setDevices] = useState([]);
  const [deviceSearchQuery, setDeviceSearchQuery] = useState('');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState(() => new Set());

  /** deviceId → lista de propiedades disponibles */
  const [devicePropertiesMap, setDevicePropertiesMap] = useState({});
  /** deviceId → clave de variable elegida */
  const [deviceVariableMap, setDeviceVariableMap] = useState({});
  const [loadingPropsFor, setLoadingPropsFor] = useState(() => new Set());

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  const [reportRows, setReportRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const propsLoadSeqRef = useRef({});
  const loadingPropsRef = useRef(new Set());
  const devicePropertiesRef = useRef({});

  useEffect(() => {
    devicePropertiesRef.current = devicePropertiesMap;
  }, [devicePropertiesMap]);

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
    () => sortDevicesForReport(devices.filter((d) => selectedDeviceIds.has(String(d.deviceId)))),
    [devices, selectedDeviceIds]
  );

  const filteredDevices = useMemo(
    () => devices.filter((d) => deviceMatchesListSearch(d, deviceSearchQuery)),
    [devices, deviceSearchQuery]
  );

  const filteredSelectedCount = useMemo(
    () => filteredDevices.filter((d) => selectedDeviceIds.has(String(d.deviceId))).length,
    [filteredDevices, selectedDeviceIds]
  );

  const loadPropertiesForDevice = useCallback(
    async (deviceId) => {
      const id = String(deviceId);
      if (!token || devicePropertiesRef.current[id] || loadingPropsRef.current.has(id)) return;

      loadingPropsRef.current.add(id);
      propsLoadSeqRef.current[id] = (propsLoadSeqRef.current[id] || 0) + 1;
      const seq = propsLoadSeqRef.current[id];

      setLoadingPropsFor((prev) => new Set(prev).add(id));
      try {
        const list = await discoverPropertiesForDevice(id, credentials, token);
        if (propsLoadSeqRef.current[id] !== seq) return;
        setDevicePropertiesMap((prev) => (prev[id] ? prev : { ...prev, [id]: list }));
        setDeviceVariableMap((prev) => {
          if (prev[id]) return prev;
          return { ...prev, [id]: list[0]?.propertyKey || '' };
        });
      } finally {
        loadingPropsRef.current.delete(id);
        setLoadingPropsFor((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [token, credentials]
  );

  useEffect(() => {
    [...selectedDeviceIds].forEach((id) => loadPropertiesForDevice(id));
  }, [selectedDeviceIds, loadPropertiesForDevice]);

  const toggleDevice = (deviceId) => {
    const id = String(deviceId);
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setDeviceVariableMap((m) => {
          const copy = { ...m };
          delete copy[id];
          return copy;
        });
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllDevices = () => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      filteredDevices.forEach((d) => next.add(String(d.deviceId)));
      return next;
    });
  };

  const clearDeviceSelection = () => {
    setSelectedDeviceIds(new Set());
    setDeviceVariableMap({});
  };

  const setDeviceVariable = (deviceId, propKey) => {
    const id = String(deviceId);
    setDeviceVariableMap((prev) => ({ ...prev, [id]: propKey }));
  };

  const variableLabelForDevice = (deviceId) => {
    const id = String(deviceId);
    const key = deviceVariableMap[id];
    const list = devicePropertiesMap[id] || [];
    const found = list.find((p) => p.propertyKey === key);
    return found?.name || key || '—';
  };

  const allDevicesHaveVariable = selectedDevices.every((d) => {
    const id = String(d.deviceId);
    return Boolean(deviceVariableMap[id]);
  });

  const handleGenerateReport = async () => {
    if (selectedDeviceIds.size === 0) {
      alert(t('reports.select_devices_alert'));
      return;
    }
    if (!allDevicesHaveVariable) {
      alert(t('reports.select_variable_per_device'));
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
        const idStr = String(id);
        const label = deviceLabel(device);
        const propKey = deviceVariableMap[idStr];
        const varLabel = variableLabelForDevice(id);

        rows.push({
          type: 'separator',
          deviceLabel: label,
          variableLabel: varLabel,
        });

        const raw = await fetchTelemetryRange(id, propKey, startMs, endMs, credentials, token);
        const deviceRows = [];
        for (const item of raw) {
          const ts = Number(item.ts);
          if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
          const val = getTelemetryPropertyValue(item.properties, propKey);
          if (val === undefined || val === null) continue;
          deviceRows.push({
            type: 'data',
            deviceLabel: label,
            deviceId: idStr,
            date: formatReportDate(ts),
            value: formatReportValue(val),
            variableLabel: varLabel,
            ts,
          });
        }
        deviceRows.sort((a, b) => a.ts - b.ts);
        rows.push(...deviceRows);
      }

      setReportRows(rows);
      if (countReportDataRows(rows) === 0) setError(t('reports.empty'));
    } catch (err) {
      console.error(err);
      setError(err?.message || t('reports.error'));
    } finally {
      setLoading(false);
    }
  };

  const rangeLabel = `${dateFrom} — ${dateTo}`;
  const filenameBase = `reporte_${dateFrom}_${dateTo}`.replace(/[^\w.-]+/g, '_');

  const exportMeta = {
    title: t('reports.title'),
    rangeLabel,
  };

  const dataRowCount = countReportDataRows(reportRows);
  const previewRows = reportRows.slice(0, 600);

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
                {deviceSearchQuery.trim()
                  ? `${filteredSelectedCount} / ${filteredDevices.length}`
                  : `${selectedDeviceIds.size} / ${devices.length}`}
              </span>
            </div>
            <label className="device-list-search-shimmer reports-device-search">
              <Search size={18} className="device-list-search-shimmer__icon" strokeWidth={2} aria-hidden />
              <input
                type="search"
                className="device-list-search-shimmer__input"
                placeholder={t('reports.device_search_placeholder')}
                value={deviceSearchQuery}
                onChange={(e) => setDeviceSearchQuery(e.target.value)}
                aria-label={t('reports.device_search_aria')}
                autoComplete="off"
              />
            </label>
            <div className="reports-device-list" role="listbox" aria-multiselectable="true">
              {devices.length === 0 ? (
                <p className="reports-muted">{t('reports.no_devices')}</p>
              ) : filteredDevices.length === 0 ? (
                <p className="reports-muted">{t('reports.no_devices_match')}</p>
              ) : (
                filteredDevices.map((d) => {
                  const id = String(d.deviceId);
                  const checked = selectedDeviceIds.has(id);
                  const model = String(d.model || d.productModel || d.deviceType || '').trim();
                  return (
                    <label key={id} className={`reports-device-row ${checked ? 'is-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDevice(d.deviceId)}
                      />
                      <span className="reports-device-main">
                        <span className="reports-device-name">{deviceLabel(d)}</span>
                        {model ? <span className="reports-device-model">{model}</span> : null}
                      </span>
                      <span className="reports-device-id">{deviceDevEuiDisplay(d)}</span>
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

            <div className="reports-per-device-vars">
              <label className="reports-per-device-vars__heading">{t('reports.variable_per_device')}</label>
              {selectedDevices.length === 0 ? (
                <p className="reports-muted">{t('reports.select_devices_for_vars')}</p>
              ) : (
                <div className="reports-device-var-list">
                  {selectedDevices.map((d) => {
                    const id = String(d.deviceId);
                    const props = devicePropertiesMap[id] || [];
                    const loadingDev = loadingPropsFor.has(id);
                    return (
                      <div key={id} className="reports-device-var-row">
                        <div className="reports-device-var-row__head">
                          <span className="reports-device-var-row__name">{deviceLabel(d)}</span>
                          {loadingDev && <Loader size={14} className="spin reports-device-var-row__spin" />}
                        </div>
                        <select
                          value={deviceVariableMap[id] || ''}
                          onChange={(e) => setDeviceVariable(id, e.target.value)}
                          className="glass reports-device-var-row__select"
                          disabled={loadingDev || props.length === 0}
                        >
                          {props.length === 0 ? (
                            <option value="">{t('reports.no_variables')}</option>
                          ) : (
                            props.map((p) => (
                              <option key={p.propertyKey} value={p.propertyKey}>
                                {p.name}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    );
                  })}
                </div>
              )}
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

      {dataRowCount > 0 && (
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
            {dataRowCount} {t('reports.rows_label')} · {selectedDevices.length}{' '}
            {t('reports.devices_label')} · {rangeLabel}
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
                {previewRows.map((row, i) =>
                  row.type === 'separator' ? (
                    <tr key={`sep-${row.deviceLabel}-${i}`} className="reports-table-separator">
                      <td colSpan={3}>
                        <span className="reports-table-separator__label">
                          {row.deviceLabel}
                          {row.variableLabel ? (
                            <>
                              {' '}
                              · <em>{row.variableLabel}</em>
                            </>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <tr key={`${row.deviceId}-${row.ts}-${i}`}>
                      <td>{row.deviceLabel}</td>
                      <td>{row.date}</td>
                      <td>{row.value}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
            {dataRowCount > 500 && (
              <p className="reports-muted reports-preview-note">{t('reports.preview_truncated')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryPage;
