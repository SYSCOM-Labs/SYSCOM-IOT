import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { flushSync } from 'react-dom';
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
  Check,
  Bookmark,
  Trash2,
  Play,
  Pencil,
  X,
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
import {
  fetchReportTemplates,
  saveReportTemplate,
  deleteReportTemplate,
} from '../services/reportTemplatesService';
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

  const [savedTemplates, setSavedTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState('');
  const [saveTemplateBusy, setSaveTemplateBusy] = useState(false);
  const [pendingSaveConfig, setPendingSaveConfig] = useState(null);
  const [showApplyTemplateModal, setShowApplyTemplateModal] = useState(false);
  const [pendingApplyTemplate, setPendingApplyTemplate] = useState(null);
  const [pdfExportBusy, setPdfExportBusy] = useState(false);

  const [editingTemplateMeta, setEditingTemplateMeta] = useState(null);
  const [editTemplateName, setEditTemplateName] = useState('');
  const [editTemplateDevices, setEditTemplateDevices] = useState([]);
  const [editDeviceSearchQuery, setEditDeviceSearchQuery] = useState('');
  const [editDevicePropertiesMap, setEditDevicePropertiesMap] = useState({});
  const [editLoadingPropsFor, setEditLoadingPropsFor] = useState(() => new Set());
  const [editTemplateSaving, setEditTemplateSaving] = useState(false);

  const propsLoadSeqRef = useRef({});
  const loadingPropsRef = useRef(new Set());
  const devicePropertiesRef = useRef({});
  const editPropsLoadSeqRef = useRef({});
  const editLoadingPropsRef = useRef(new Set());
  const editDevicePropertiesRef = useRef({});

  useEffect(() => {
    devicePropertiesRef.current = devicePropertiesMap;
  }, [devicePropertiesMap]);

  useEffect(() => {
    editDevicePropertiesRef.current = editDevicePropertiesMap;
  }, [editDevicePropertiesMap]);

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

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setTemplatesLoading(true);
      try {
        const list = await fetchReportTemplates();
        if (!cancelled) setSavedTemplates(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!cancelled) console.warn('[Reports] templates:', e?.message || e);
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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

  const buildCurrentTemplateConfig = useCallback(
    () => ({
      dateFrom,
      dateTo,
      devices: selectedDevices.map((d) => {
        const id = String(d.deviceId);
        return {
          deviceId: id,
          deviceLabel: deviceLabel(d),
          variableKey: deviceVariableMap[id] || '',
          variableLabel: variableLabelForDevice(d.deviceId),
        };
      }),
    }),
    [dateFrom, dateTo, selectedDevices, deviceVariableMap, devicePropertiesMap]
  );

  const defaultTemplateName = () => {
    const d = new Date();
    const label = d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${t('reports.template_default_name')} ${label}`;
  };

  const handleSaveTemplate = async () => {
    const cfg = pendingSaveConfig || buildCurrentTemplateConfig();
    const name = String(saveTemplateName || '').trim();
    if (!name) {
      alert(t('reports.template_name_required'));
      return;
    }
    setSaveTemplateBusy(true);
    try {
      const saved = await saveReportTemplate({ ...cfg, name });
      setSavedTemplates((prev) => {
        const rest = prev.filter((x) => x.id !== saved.id);
        return [saved, ...rest];
      });
      setShowSaveModal(false);
      setPendingSaveConfig(null);
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || t('reports.template_save_error'));
    } finally {
      setSaveTemplateBusy(false);
    }
  };

  const applyTemplateConfig = (template) => {
    if (!template) return;
    const ids = new Set();
    const vars = {};
    (template.devices || []).forEach((entry) => {
      const id = String(entry.deviceId);
      ids.add(id);
      if (entry.variableKey) vars[id] = entry.variableKey;
    });
    setSelectedDeviceIds(ids);
    setDeviceVariableMap(vars);
    setReportRows([]);
    setError(null);
    [...ids].forEach((id) => loadPropertiesForDevice(id));
  };

  const openApplyTemplateModal = (template) => {
    if (!template) return;
    setPendingApplyTemplate(template);
    setShowApplyTemplateModal(true);
  };

  const closeApplyTemplateModal = () => {
    const template = pendingApplyTemplate;
    setShowApplyTemplateModal(false);
    setPendingApplyTemplate(null);
    if (template) applyTemplateConfig(template);
  };

  const handleApplyTemplate = (template) => {
    openApplyTemplateModal(template);
  };

  const handleDeleteTemplate = async (templateId) => {
    if (!window.confirm(t('reports.template_delete_confirm'))) return;
    try {
      await deleteReportTemplate(templateId);
      setSavedTemplates((prev) => prev.filter((x) => x.id !== templateId));
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || t('reports.template_delete_error'));
    }
  };

  const loadEditPropertiesForDevice = useCallback(
    async (deviceId) => {
      const id = String(deviceId);
      if (!token || editDevicePropertiesRef.current[id] || editLoadingPropsRef.current.has(id)) return;

      editLoadingPropsRef.current.add(id);
      editPropsLoadSeqRef.current[id] = (editPropsLoadSeqRef.current[id] || 0) + 1;
      const seq = editPropsLoadSeqRef.current[id];

      setEditLoadingPropsFor((prev) => new Set(prev).add(id));
      try {
        const list = await discoverPropertiesForDevice(id, credentials, token);
        if (editPropsLoadSeqRef.current[id] !== seq) return;
        setEditDevicePropertiesMap((prev) => (prev[id] ? prev : { ...prev, [id]: list }));
        setEditTemplateDevices((prev) =>
          prev.map((entry) => {
            if (entry.deviceId !== id || entry.variableKey) return entry;
            const firstKey = list[0]?.propertyKey || '';
            return {
              ...entry,
              variableKey: firstKey,
              variableLabel: list[0]?.name || firstKey,
            };
          })
        );
      } finally {
        editLoadingPropsRef.current.delete(id);
        setEditLoadingPropsFor((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [token, credentials]
  );

  const openEditTemplate = (tpl) => {
    if (!tpl) return;
    const deviceEntries = [...(tpl.devices || [])].map((d) => ({
      deviceId: String(d.deviceId),
      deviceLabel: d.deviceLabel || String(d.deviceId),
      variableKey: d.variableKey || '',
      variableLabel: d.variableLabel || '',
    }));
    setEditTemplateName(tpl.name || '');
    setEditTemplateDevices(deviceEntries);
    setEditDeviceSearchQuery('');
    setEditDevicePropertiesMap({});
    setEditingTemplateMeta({ id: tpl.id, dateFrom: tpl.dateFrom, dateTo: tpl.dateTo });
    deviceEntries.forEach((d) => loadEditPropertiesForDevice(d.deviceId));
  };

  const resetEditTemplate = () => {
    setEditingTemplateMeta(null);
    setEditTemplateName('');
    setEditTemplateDevices([]);
    setEditDeviceSearchQuery('');
    setEditDevicePropertiesMap({});
  };

  const closeEditTemplate = () => {
    if (editTemplateSaving) return;
    resetEditTemplate();
  };

  const removeDeviceFromEditTemplate = (deviceId) => {
    const id = String(deviceId);
    setEditTemplateDevices((prev) => prev.filter((d) => d.deviceId !== id));
  };

  const addDeviceToEditTemplate = (device) => {
    const id = String(device.deviceId);
    if (editTemplateDevices.some((d) => d.deviceId === id)) return;
    setEditTemplateDevices((prev) => [
      ...prev,
      {
        deviceId: id,
        deviceLabel: deviceLabel(device),
        variableKey: '',
        variableLabel: '',
      },
    ]);
    loadEditPropertiesForDevice(id);
  };

  const setEditDeviceVariable = (deviceId, propKey) => {
    const id = String(deviceId);
    const list = editDevicePropertiesMap[id] || [];
    const found = list.find((p) => p.propertyKey === propKey);
    setEditTemplateDevices((prev) =>
      prev.map((d) =>
        d.deviceId === id
          ? { ...d, variableKey: propKey, variableLabel: found?.name || propKey }
          : d
      )
    );
  };

  const editVariableLabelForDevice = (deviceId, propKey) => {
    const id = String(deviceId);
    const list = editDevicePropertiesMap[id] || [];
    const found = list.find((p) => p.propertyKey === propKey);
    return found?.name || propKey || '—';
  };

  const handleSaveEditTemplate = async () => {
    if (!editingTemplateMeta) return;
    const name = String(editTemplateName || '').trim();
    if (!name) {
      alert(t('reports.template_name_required'));
      return;
    }
    if (editTemplateDevices.length === 0) {
      alert(t('reports.template_edit_need_device'));
      return;
    }
    if (!editTemplateDevices.every((d) => d.variableKey)) {
      alert(t('reports.template_edit_need_variable'));
      return;
    }

    setEditTemplateSaving(true);
    try {
      const saved = await saveReportTemplate({
        id: editingTemplateMeta.id,
        name,
        dateFrom: editingTemplateMeta.dateFrom,
        dateTo: editingTemplateMeta.dateTo,
        devices: editTemplateDevices.map((d) => ({
          deviceId: d.deviceId,
          deviceLabel: d.deviceLabel,
          variableKey: d.variableKey,
          variableLabel: editVariableLabelForDevice(d.deviceId, d.variableKey) || d.variableLabel,
        })),
      });
      setSavedTemplates((prev) => {
        const rest = prev.filter((x) => x.id !== saved.id);
        return [saved, ...rest];
      });
      resetEditTemplate();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || t('reports.template_save_error'));
    } finally {
      setEditTemplateSaving(false);
    }
  };

  const editSortedTemplateDevices = useMemo(
    () =>
      [...editTemplateDevices].sort((a, b) =>
        compareReportDeviceLabels(a.deviceLabel, b.deviceLabel)
      ),
    [editTemplateDevices]
  );

  const editAvailableDevices = useMemo(() => {
    const inTemplate = new Set(editTemplateDevices.map((d) => d.deviceId));
    return sortDevicesForReport(
      devices.filter(
        (d) =>
          !inTemplate.has(String(d.deviceId)) &&
          deviceMatchesListSearch(d, editDeviceSearchQuery)
      )
    );
  }, [devices, editTemplateDevices, editDeviceSearchQuery]);

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
      const dataCount = countReportDataRows(rows);
      if (dataCount === 0) {
        setError(t('reports.empty'));
      } else {
        const cfg = {
          dateFrom,
          dateTo,
          devices: selectedDevices.map((d) => {
            const idStr = String(d.deviceId);
            return {
              deviceId: idStr,
              deviceLabel: deviceLabel(d),
              variableKey: deviceVariableMap[idStr] || '',
              variableLabel: variableLabelForDevice(d.deviceId),
            };
          }),
        };
        setPendingSaveConfig(cfg);
        setSaveTemplateName(defaultTemplateName());
        setShowSaveModal(true);
      }
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

  const handleDownloadPdf = () => {
    if (pdfExportBusy || dataRowCount === 0) return;
    flushSync(() => setPdfExportBusy(true));
    try {
      downloadReportPdf(reportRows, exportMeta, filenameBase);
    } catch (e) {
      console.error('[Reports] PDF:', e);
      alert(e?.message || t('reports.pdf_error'));
    } finally {
      setPdfExportBusy(false);
    }
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
                    <div
                      key={id}
                      role="option"
                      aria-selected={checked}
                      className={`reports-device-card ${checked ? 'is-selected' : ''}`}
                      onClick={() => toggleDevice(d.deviceId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleDevice(d.deviceId);
                        }
                      }}
                      tabIndex={0}
                    >
                      <span className="reports-device-check" aria-hidden="true">
                        <span className="reports-device-check__box">{checked ? <Check size={13} strokeWidth={3} /> : null}</span>
                      </span>
                      <div className="reports-device-card__body">
                        <span className="reports-device-name">{deviceLabel(d)}</span>
                        {model ? <span className="reports-device-model-badge">{model}</span> : null}
                        <span className="reports-device-id">{deviceDevEuiDisplay(d)}</span>
                      </div>
                    </div>
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
                className={`btn btn-primary device-create-top-btn reports-download-pdf-btn${pdfExportBusy ? ' is-busy' : ''}`}
                onClick={handleDownloadPdf}
                disabled={pdfExportBusy}
                aria-busy={pdfExportBusy}
              >
                {pdfExportBusy ? (
                  <Loader size={16} className="spin reports-download-pdf-btn__spinner" />
                ) : (
                  <Download size={16} />
                )}
                {pdfExportBusy ? t('reports.download_pdf_busy') : t('reports.download_pdf')}
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

      <section className="reports-saved-templates glass card">
        <div className="reports-saved-templates__header">
          <h3>
            <Bookmark size={18} /> {t('reports.saved_templates_title')}
          </h3>
          <p className="reports-saved-templates__hint">{t('reports.saved_templates_hint')}</p>
        </div>
        {templatesLoading ? (
          <p className="reports-muted reports-saved-templates__loading">
            <Loader size={16} className="spin" /> {t('reports.templates_loading')}
          </p>
        ) : savedTemplates.length === 0 ? (
          <p className="reports-muted">{t('reports.saved_templates_empty')}</p>
        ) : (
          <ul className="reports-template-list">
            {savedTemplates.map((tpl) => (
              <li key={tpl.id} className="reports-template-card">
                <div className="reports-template-card__main">
                  <strong className="reports-template-card__name">{tpl.name}</strong>
                  <span className="reports-template-card__meta">
                    {(tpl.devices || []).length} {t('reports.devices_label')}
                    {tpl.dateFrom && tpl.dateTo ? ` · ${tpl.dateFrom} — ${tpl.dateTo}` : ''}
                  </span>
                  <ul className="reports-template-card__devices">
                    {(tpl.devices || []).slice(0, 4).map((d) => (
                      <li key={`${tpl.id}-${d.deviceId}`}>
                        {d.deviceLabel || d.deviceId}
                        {d.variableLabel ? ` · ${d.variableLabel}` : ''}
                      </li>
                    ))}
                    {(tpl.devices || []).length > 4 ? (
                      <li className="reports-template-card__more">
                        +{(tpl.devices || []).length - 4} {t('reports.more_devices')}
                      </li>
                    ) : null}
                  </ul>
                </div>
                <div className="reports-template-card__actions">
                  <button
                    type="button"
                    className="btn btn-primary reports-template-apply-btn"
                    onClick={() => handleApplyTemplate(tpl)}
                  >
                    <Play size={14} /> {t('reports.template_apply')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary reports-template-edit-btn"
                    onClick={() => openEditTemplate(tpl)}
                    title={t('reports.template_edit')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary reports-template-delete-btn"
                    onClick={() => handleDeleteTemplate(tpl.id)}
                    title={t('reports.template_delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showSaveModal && (
        <div
          className="modal-overlay reports-save-modal-overlay"
          role="presentation"
          onClick={() => !saveTemplateBusy && setShowSaveModal(false)}
        >
          <div
            className="modal-content glass reports-save-modal"
            role="dialog"
            aria-labelledby="reports-save-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="reports-save-modal-title">{t('reports.save_modal_title')}</h2>
              <button
                type="button"
                className="reports-save-modal__close"
                onClick={() => !saveTemplateBusy && setShowSaveModal(false)}
                aria-label={t('reports.save_modal_cancel')}
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p className="reports-save-modal__text">{t('reports.save_modal_question')}</p>
              <label className="filter-group" htmlFor="report-template-name">
                {t('reports.template_name_label')}
                <input
                  id="report-template-name"
                  type="text"
                  className="glass"
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)}
                  placeholder={t('reports.template_name_placeholder')}
                  maxLength={200}
                  autoFocus
                />
              </label>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={saveTemplateBusy}
                onClick={() => setShowSaveModal(false)}
              >
                {t('reports.save_modal_cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary device-create-top-btn"
                disabled={saveTemplateBusy}
                onClick={() => void handleSaveTemplate()}
              >
                {saveTemplateBusy ? <Loader size={16} className="spin" /> : <Bookmark size={16} />}
                {t('reports.save_modal_confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingTemplateMeta && (
        <div
          className="modal-overlay reports-edit-template-overlay"
          role="presentation"
          onClick={() => !editTemplateSaving && closeEditTemplate()}
        >
          <div
            className="modal-content glass reports-edit-template-modal"
            role="dialog"
            aria-labelledby="reports-edit-template-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="reports-edit-template-title">{t('reports.template_edit_title')}</h2>
              <button
                type="button"
                className="reports-save-modal__close"
                onClick={() => !editTemplateSaving && closeEditTemplate()}
                aria-label={t('reports.template_edit_cancel')}
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-body reports-edit-template-modal__body">
              <p className="reports-edit-template-modal__hint">{t('reports.template_edit_hint')}</p>
              <label className="filter-group" htmlFor="report-template-edit-name">
                {t('reports.template_name_label')}
                <input
                  id="report-template-edit-name"
                  type="text"
                  className="glass"
                  value={editTemplateName}
                  onChange={(e) => setEditTemplateName(e.target.value)}
                  placeholder={t('reports.template_name_placeholder')}
                  maxLength={200}
                  autoFocus
                />
              </label>

              <div className="reports-edit-template-devices">
                <h4 className="reports-edit-template-devices__title">
                  {t('reports.template_edit_devices_section')}
                </h4>
                {editSortedTemplateDevices.length === 0 ? (
                  <p className="reports-muted">{t('reports.template_edit_no_devices')}</p>
                ) : (
                  <div className="reports-edit-template-devices__list">
                    {editSortedTemplateDevices.map((entry) => {
                      const props = editDevicePropertiesMap[entry.deviceId] || [];
                      const loadingDev = editLoadingPropsFor.has(entry.deviceId);
                      return (
                        <div key={entry.deviceId} className="reports-edit-template-device-row">
                          <div className="reports-edit-template-device-row__head">
                            <span className="reports-edit-template-device-row__name">{entry.deviceLabel}</span>
                            {loadingDev && <Loader size={14} className="spin" />}
                            <button
                              type="button"
                              className="reports-edit-template-device-row__remove"
                              onClick={() => removeDeviceFromEditTemplate(entry.deviceId)}
                              title={t('reports.template_edit_remove_device')}
                              aria-label={t('reports.template_edit_remove_device')}
                            >
                              <X size={14} />
                            </button>
                          </div>
                          <select
                            value={entry.variableKey || ''}
                            onChange={(e) => setEditDeviceVariable(entry.deviceId, e.target.value)}
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

              <div className="reports-edit-template-add">
                <h4 className="reports-edit-template-add__title">{t('reports.template_edit_add_device')}</h4>
                <label className="device-list-search-shimmer reports-edit-template-add__search">
                  <Search size={16} className="device-list-search-shimmer__icon" strokeWidth={2} aria-hidden />
                  <input
                    type="search"
                    className="device-list-search-shimmer__input"
                    placeholder={t('reports.device_search_placeholder')}
                    value={editDeviceSearchQuery}
                    onChange={(e) => setEditDeviceSearchQuery(e.target.value)}
                    aria-label={t('reports.device_search_aria')}
                    autoComplete="off"
                  />
                </label>
                <div className="reports-edit-template-add__list">
                  {editAvailableDevices.length === 0 ? (
                    <p className="reports-muted">{t('reports.template_edit_no_available')}</p>
                  ) : (
                    editAvailableDevices.map((d) => (
                      <button
                        key={String(d.deviceId)}
                        type="button"
                        className="reports-edit-template-add__item"
                        onClick={() => addDeviceToEditTemplate(d)}
                      >
                        <span className="reports-edit-template-add__item-name">{deviceLabel(d)}</span>
                        <span className="reports-edit-template-add__item-id">{deviceDevEuiDisplay(d)}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={editTemplateSaving}
                onClick={closeEditTemplate}
              >
                {t('reports.template_edit_cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary device-create-top-btn"
                disabled={editTemplateSaving}
                onClick={() => void handleSaveEditTemplate()}
              >
                {editTemplateSaving ? <Loader size={16} className="spin" /> : <Bookmark size={16} />}
                {t('reports.template_edit_save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showApplyTemplateModal && (
        <div
          className="modal-overlay reports-apply-template-overlay"
          role="presentation"
          onClick={closeApplyTemplateModal}
        >
          <div
            className="modal-content glass reports-apply-template-modal"
            role="alertdialog"
            aria-labelledby="reports-apply-template-title"
            aria-describedby="reports-apply-template-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reports-apply-template-modal__icon" aria-hidden>
              <Calendar size={28} />
            </div>
            <h2 id="reports-apply-template-title">{t('reports.template_apply_modal_title')}</h2>
            <p id="reports-apply-template-desc" className="reports-apply-template-modal__text">
              {t('reports.template_apply_modal_message')}
            </p>
            {pendingApplyTemplate?.name ? (
              <p className="reports-apply-template-modal__template-name">{pendingApplyTemplate.name}</p>
            ) : null}
            <div className="modal-footer reports-apply-template-modal__footer">
              <button
                type="button"
                className="btn btn-primary device-create-top-btn reports-apply-template-modal__ok"
                onClick={closeApplyTemplateModal}
              >
                {t('reports.template_apply_modal_ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryPage;
