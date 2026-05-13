import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import {
  Calendar,
  Clock,
  Search,
  Download,
  Database,
  Settings,
  Loader,
  AlertTriangle,
  History,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { fetchDevices, fetchDeviceHistory, fetchDeviceTsl } from '../services/api';
import { queryTelemetry, getLatestDeviceData } from '../services/localAuth';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../utils/gatewayPayload';
import { getTelemetryPropertyValue } from '../utils/telemetryPropertyPath';
import {
  dailyIncrementalTotals,
  lastCumulativeInRows,
  perSampleIncrementalSeries,
} from '../utils/incrementalTelemetry';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import html2canvas from 'html2canvas';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './History.css';

/** Texto para tabla / tooltip / eje categórico. */
function historyValueDisplay(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Número finito solo si es número real o cadena estrictamente numérica (p. ej. "23.5").
 * Booleanos → 0/1 para poder trazarlos como serie numérica.
 */
function coerceToFiniteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (!/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recharts solo traza números en `Line`. Convierte filas a `valueNum` + metadatos para eje Y categórico.
 * @returns {{ mode: 'numeric'|'categorical', categories: string[], rows: object[] }}
 */
function buildHistoryChartSeries(formattedRows) {
  if (!formattedRows.length) {
    return { mode: 'numeric', categories: [], rows: [] };
  }

  const nums = formattedRows.map((r) => coerceToFiniteNumber(r.value));
  const allNumeric =
    nums.every((n) => n !== null) &&
    formattedRows.every((r) => r.value === null || r.value === undefined || typeof r.value !== 'object');

  if (allNumeric) {
    return {
      mode: 'numeric',
      categories: [],
      rows: formattedRows.map((r, i) => ({
        ...r,
        valueNum: nums[i],
        valueDisplay: historyValueDisplay(r.value),
      })),
    };
  }

  const categories = [];
  const map = new Map();
  for (const r of formattedRows) {
    const lab = historyValueDisplay(r.value);
    if (!map.has(lab)) {
      map.set(lab, categories.length);
      categories.push(lab);
    }
  }

  return {
    mode: 'categorical',
    categories,
    rows: formattedRows.map((r) => {
      const lab = historyValueDisplay(r.value);
      return {
        ...r,
        valueNum: map.get(lab) ?? 0,
        valueDisplay: lab,
      };
    }),
  };
}

const HistoryPage = () => {
  const { credentials, token, reAuthenticate } = useAuth();
  const { t } = useLanguage();
  const { isDarkMode } = useTheme();
  
  // State for filters
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [properties, setProperties] = useState([]);
  const [selectedPropKey, setSelectedPropKey] = useState('');
  
  // State for date range (Default 24h)
  const [startTime, setStartTime] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return d.toISOString().slice(0, 16);
  });
  const [endTime, setEndTime] = useState(new Date().toISOString().slice(0, 16));

  /** Contadores / medidores acumulativos: muestra incrementos en el periodo (no el total desde instalación). */
  const [incrementalMode, setIncrementalMode] = useState(false);
  /** En modo incremental: una fila por muestra o una fila por día (suma de incrementos del día). */
  const [incrementalGranularity, setIncrementalGranularity] = useState('sample');

  // Data state
  const [historyData, setHistoryData] = useState([]);
  /** Recharts exige Y numérico; en cadenas usamos índices y etiquetas en el eje. */
  const [historyChartMode, setHistoryChartMode] = useState('numeric');
  const [historyCategoryLabels, setHistoryCategoryLabels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingProps, setLoadingProps] = useState(false);
  const [error, setError] = useState(null);
  const chartRef = useRef(null);
  /** Evita que una respuesta lenta sobrescriba el desplegable VALOR tras cambiar de dispositivo. */
  const propertiesLoadSeqRef = useRef(0);

  const chartChrome = useMemo(
    () =>
      isDarkMode
        ? {
            gridStroke: 'rgba(255,255,255,0.12)',
            axisStroke: 'rgba(255,255,255,0.55)',
            tooltipBg: '#1a1a2e',
            tooltipBorder: '#3f3f46',
            tooltipLabel: '#e4e4e7',
            pdfCanvasBg: '#0f172a',
          }
        : {
            gridStroke: 'rgba(15,23,42,0.12)',
            axisStroke: 'rgba(15,23,42,0.55)',
            tooltipBg: '#ffffff',
            tooltipBorder: '#e4e4e7',
            tooltipLabel: '#0f172a',
            pdfCanvasBg: '#f8fafc',
          },
    [isDarkMode]
  );

  // Load initial devices
  useEffect(() => {
    const loadDevices = async () => {
      try {
        const resp = await fetchDevices(credentials, token);
        const list = resp.data?.data?.content || resp.data?.content || [];
        setDevices(list);
        if (list.length > 0) setSelectedDeviceId(list[0].deviceId.toString());
      } catch (err) {
        console.error('Failed to load devices', err);
      }
    };
    if (token) loadDevices();
  }, [token, credentials]);

  // Load properties when device changes
  useEffect(() => {
    if (!selectedDeviceId || !token) return;

    const loadId = ++propertiesLoadSeqRef.current;

    const loadProperties = async () => {
      setLoadingProps(true);
      try {
        const [tslResp, propsResp, localResp] = await Promise.all([
          fetchDeviceTsl(selectedDeviceId, credentials, token),
          import('../services/api').then(m => m.fetchDeviceProperties(selectedDeviceId, credentials, token)),
          getLatestDeviceData()
        ]);

        if (loadId !== propertiesLoadSeqRef.current) return;

        const liveFromAPI = propsResp.data?.properties || propsResp.data?.data?.properties || {};
        const sel = selectedDeviceId.toString();
        const localEntry = (localResp || []).find(
          (d) => d && d.deviceId != null && d.deviceId.toString() === sel
        );
        const liveFromLocal = localEntry ? localEntry.properties || {} : {};
        const combinedLive = { ...liveFromAPI, ...liveFromLocal };
        const expandedLive = expandNestedGatewayTelemetry(combinedLive);

        let props = tslResp.data?.data?.properties || tslResp.data?.properties || tslResp.properties || [];
        const reLnsKeyMaterial = /^(nwk|app)[_]?s[_]?key(\.|$)|^appskey(\.|$)/i;
        if (props.length > 0) {
          props = props.filter(
            (p) => p && p.propertyKey != null && !reLnsKeyMaterial.test(String(p.propertyKey))
          );
        }

        // Fallback: If TSL is empty, infer from live properties
        if (props.length === 0) {
          const ignoreKeys = new Set(PROPERTY_INFER_IGNORE_KEYS);

          props = Object.keys(expandedLive)
            .filter(
              (key) =>
                !ignoreKeys.has(key) &&
                !String(key).endsWith('_alarm') &&
                expandedLive[key] != null &&
                typeof expandedLive[key] !== 'object' &&
                !Array.isArray(expandedLive[key])
            )
            .map(key => ({
              id: key,
              propertyKey: key,
              name: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
              unit: ''
            }));
        }

        if (loadId !== propertiesLoadSeqRef.current) return;
        setProperties(props);
        if (props.length > 0) setSelectedPropKey(props[0].propertyKey);
      } catch (err) {
        console.error('Failed to load properties', err);
      } finally {
        if (loadId === propertiesLoadSeqRef.current) setLoadingProps(false);
      }
    };
    loadProperties();
  }, [selectedDeviceId, token, credentials]);

  const handleSearch = async (retry = true) => {
    if (!selectedDeviceId) {
        alert("Por favor selecciona un dispositivo.");
        return;
    }
    if (!selectedPropKey) {
        alert("Por favor selecciona una variable (Propiedad) para consultar.");
        return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const startMs = new Date(startTime).getTime();
      const endMs = new Date(endTime).getTime();

      const fetchTelemetryRange = async (fromMs, toMs) => {
        let results = [];
        try {
          const localData = await queryTelemetry(selectedDeviceId, selectedPropKey, fromMs, toMs);
          if (localData && localData.length > 0) {
            results = localData
              .filter(
                (item) =>
                  item &&
                  (item.deviceId == null || item.deviceId.toString() === selectedDeviceId.toString())
              )
              .map((item) => ({
                ts: item.timestamp ?? item.ts,
                properties: item.properties || {},
              }));
          }
        } catch (e) {
          console.warn('Local telemetry query failed:', e.message);
        }
        if (results.length === 0) {
          const resp = await fetchDeviceHistory(
            selectedDeviceId,
            {
              startTime: fromMs,
              endTime: toMs,
            },
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
      };

      const results = await fetchTelemetryRange(startMs, endMs);

      const sortedRaw = results
        .map((item) => {
          const rawTs = Number(item.ts);
          return { rawTs, properties: item.properties || {} };
        })
        .filter((row) => Number.isFinite(row.rawTs))
        .sort((a, b) => a.rawTs - b.rawTs);

      let formatted;

      if (incrementalMode) {
        if (sortedRaw.length === 0) {
          formatted = [];
        } else {
          const beforeRows =
            startMs > 0 ? await fetchTelemetryRange(0, Math.max(0, startMs - 1)) : [];
          const baselineNum = lastCumulativeInRows(
            beforeRows.map((item) => ({
              ts: item.ts,
              properties: item.properties || {},
            })),
            selectedPropKey
          );

          if (incrementalGranularity === 'day') {
            const daily = dailyIncrementalTotals(sortedRaw, selectedPropKey, baselineNum);
            formatted = daily.map((d) => ({
              timestamp: d.dayLabel,
              value: d.totalIncremental,
              rawTs: d.rawTsEnd,
            }));
          } else {
            const inc = perSampleIncrementalSeries(sortedRaw, selectedPropKey, baselineNum);
            formatted = inc.map((r) => ({
              timestamp: r.timestamp,
              value: r.value,
              rawTs: r.rawTs,
            }));
          }
        }
      } else {
        formatted = sortedRaw.map((item) => {
          const rawTs = item.rawTs;
          return {
            timestamp: Number.isFinite(rawTs) ? new Date(rawTs).toLocaleString() : '',
            value: item.properties
              ? getTelemetryPropertyValue(item.properties, selectedPropKey)
              : undefined,
            rawTs,
          };
        });
      }

      const chartBuilt = buildHistoryChartSeries(formatted);
      setHistoryData(chartBuilt.rows);
      setHistoryChartMode(chartBuilt.mode);
      setHistoryCategoryLabels(chartBuilt.categories);
      if (formatted.length === 0) {
        setError(t('history.empty') || 'No se encontraron registros para este rango.');
      }
    } catch (err) {
      const msg = err.response?.data?.errMsg || err.message || t('history.empty');
      if (retry && (msg.toLowerCase().includes('jwt') || msg.toLowerCase().includes('token'))) {
        try {
          await reAuthenticate();
          return handleSearch(false);
        } catch (reAuthErr) { console.error(reAuthErr); }
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const exportToCSV = () => {
    if (historyData.length === 0) return;
    
    const selectedPropName = properties.find(p => p.propertyKey === selectedPropKey)?.name || selectedPropKey;
    const headers = [t('history.timestamp'), selectedPropName];
    // Quote fields to handle commas in timestamps
    const rows = historyData.map((item) => [
      `"${item.timestamp}"`,
      `"${historyValueDisplay(item.value).replace(/"/g, '""')}"`,
    ]);
    
    const csvContent = [
      headers.map(h => `"${h}"`).join(','),
      ...rows.map(r => r.join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `history_${selectedDeviceId}_${selectedPropKey}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportToPDF = async () => {
    if (historyData.length === 0) return;

    setLoading(true); // show loading state while capturing
    try {
      const doc = new jsPDF();
      const selectedDevice = devices.find(d => d.deviceId.toString() === selectedDeviceId);
      const selectedPropName = properties.find(p => p.propertyKey === selectedPropKey)?.name || selectedPropKey;

      // Header
      doc.setFontSize(22);
      doc.setTextColor(59, 130, 246); // Accent blue
      doc.text('Reporte de Telemetría e Historial', 14, 22);
      
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`Dispositivo: ${selectedDevice?.name || selectedDevice?.sn || selectedDeviceId}`, 14, 32);
      doc.text(`Variable: ${selectedPropName}`, 14, 38);
      doc.text(`Rango: ${new Date(startTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`, 14, 44);
      doc.text(`Fecha de Emisión: ${new Date().toLocaleString()}`, 14, 50);

      // CAPTURE GRAPH
      if (chartRef.current) {
        const canvas = await html2canvas(chartRef.current, {
          backgroundColor: chartChrome.pdfCanvasBg,
          scale: 2,
        });
        const imgData = canvas.toDataURL('image/png');
        doc.addImage(imgData, 'PNG', 14, 55, 180, 75);
      }

      // Table
      const tableHeaders = [['Fecha y Hora', 'Valor', 'Unidad']];
      const unit = properties.find(p => p.propertyKey === selectedPropKey)?.unit || '';
      const tableData = historyData.map(item => [
        item.timestamp,
        item.value,
        unit
      ]);

      doc.autoTable({
        startY: 135, // After the graph
        head: tableHeaders,
        body: tableData,
        theme: 'striped',
        headStyles: { fillColor: [59, 130, 246] },
        styles: { fontSize: 9 }
      });

      doc.save(`reporte_${selectedDeviceId}_${selectedPropKey}.pdf`);
    } catch (err) {
      console.error('PDF export error:', err);
      alert('Error al generar el PDF: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="history-page device-list-page device-list-page--premium premium-shell">
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <History size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">{t('history.title')}</span>
          </h1>
        </div>
        <div className="premium-header-actions header-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={exportToCSV}
            disabled={historyData.length === 0}
            title="Descargar CSV"
          >
            <Download size={18} /> CSV
          </button>
          <button
            type="button"
            className="btn btn-primary device-create-top-btn"
            onClick={exportToPDF}
            disabled={historyData.length === 0}
            title="Descargar PDF"
          >
            <Download size={18} /> PDF
          </button>
        </div>
      </div>

      <div className="filters-bar glass card">
        <div className="filter-group">
          <label><Database size={14} /> {t('history.device_filter')}</label>
          <select 
            value={selectedDeviceId} 
            onChange={e => setSelectedDeviceId(e.target.value)}
            className="glass"
          >
            {devices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.name || d.sn}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label><Settings size={14} /> {t('history.value_filter')}</label>
          <select 
            value={selectedPropKey} 
            onChange={e => setSelectedPropKey(e.target.value)}
            className="glass"
            disabled={loadingProps}
          >
            {properties.map(p => (
              <option key={p.id} value={p.propertyKey}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label><Calendar size={14} /> {t('history.start_filter')}</label>
          <input 
            type="datetime-local" 
            value={startTime} 
            onChange={e => setStartTime(e.target.value)}
            className="glass"
          />
        </div>

        <div className="filter-group">
          <label><Clock size={14} /> {t('history.end_filter')}</label>
          <input 
            type="datetime-local" 
            value={endTime} 
            onChange={e => setEndTime(e.target.value)}
            className="glass"
          />
        </div>

        <div className="filter-group history-incremental-group">
          <label className="history-incremental-label">
            <input
              type="checkbox"
              checked={incrementalMode}
              onChange={(e) => setIncrementalMode(e.target.checked)}
            />
            <span>Incremental (contadores / acumulados)</span>
          </label>
          {incrementalMode && (
            <select
              className="glass history-incremental-select"
              value={incrementalGranularity}
              onChange={(e) => setIncrementalGranularity(e.target.value)}
              title="Por muestra: delta entre lecturas con marca de tiempo. Por día: suma de incrementos de cada día civil."
            >
              <option value="sample">Por muestra (fecha y hora)</option>
              <option value="day">Por día (total diario)</option>
            </select>
          )}
        </div>

        <button className="btn btn-accent search-btn" onClick={() => handleSearch()} disabled={loading}>
          {loading ? <Loader className="spin" size={18} /> : <Search size={18} />}
          {t('history.search_btn')}
        </button>
      </div>

      {error && (
        <div className="error-message glass">
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      <div className="history-content">
        <div className="chart-container glass card">
          <h3>
            {properties.find(p => p.propertyKey === selectedPropKey)?.name || t('history.value')}
          </h3>
          <div className="chart-wrapper" ref={chartRef}>
            {historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={400}>
                <LineChart data={historyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartChrome.gridStroke} />
                  <XAxis dataKey="timestamp" hide />
                  <YAxis
                    stroke={chartChrome.axisStroke}
                    domain={
                      historyChartMode === 'categorical' && historyCategoryLabels.length > 0
                        ? [0, Math.max(historyCategoryLabels.length - 1, 0)]
                        : undefined
                    }
                    ticks={
                      historyChartMode === 'categorical' && historyCategoryLabels.length > 0
                        ? historyCategoryLabels.map((_, i) => i)
                        : undefined
                    }
                    tickFormatter={(v) =>
                      historyChartMode === 'categorical' && Number.isInteger(v) && historyCategoryLabels[v] != null
                        ? historyCategoryLabels[v]
                        : String(v)
                    }
                    width={
                      historyChartMode === 'categorical' && historyCategoryLabels.length > 0
                        ? Math.min(
                            220,
                            28 +
                              Math.max(
                                3,
                                ...historyCategoryLabels.map((s) => String(s).length)
                              ) *
                                7
                          )
                        : 56
                    }
                  />
                  <Tooltip
                    contentStyle={{
                      background: chartChrome.tooltipBg,
                      border: `1px solid ${chartChrome.tooltipBorder}`,
                      borderRadius: '8px',
                    }}
                    labelStyle={{ color: chartChrome.tooltipLabel }}
                    itemStyle={{ color: 'var(--accent-blue)' }}
                    formatter={(value, name, item) => {
                      const pl = item && item.payload != null ? item.payload : item;
                      const d = pl?.valueDisplay ?? historyValueDisplay(pl?.value);
                      return [d, name];
                    }}
                  />
                  <Legend wrapperStyle={{ color: chartChrome.tooltipLabel }} />
                  <Line
                    type={historyChartMode === 'categorical' ? 'stepAfter' : 'monotone'}
                    dataKey="valueNum"
                    name={properties.find((p) => p.propertyKey === selectedPropKey)?.name}
                    stroke="var(--accent-blue)"
                    strokeWidth={2}
                    dot={{ r: 4, fill: 'var(--accent-blue)' }}
                    activeDot={{ r: 6 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state">
                {loading ? t('history.loading') : t('history.empty')}
              </div>
            )}
          </div>
        </div>

        <div className="logs-container glass card">
          <h3>{t('history.logs_title')}</h3>
          <div className="table-wrapper">
            <table className="log-table">
              <thead>
                <tr>
                  <th>{t('history.timestamp')}</th>
                  <th>{t('history.value')}</th>
                </tr>
              </thead>
              <tbody>
                {historyData.map((row, i) => (
                  <tr key={i}>
                    <td>{row.timestamp}</td>
                    <td>{historyValueDisplay(row.value)}</td>
                  </tr>
                )).reverse()}
                {historyData.length === 0 && (
                  <tr><td colSpan="2" className="text-center">{t('common.empty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HistoryPage;
