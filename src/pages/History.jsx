import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import { 
  Calendar, Clock, Search, Download, Database, Settings, Loader, AlertTriangle 
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { fetchDevices, fetchDeviceHistory, fetchDeviceTsl } from '../services/api';
import { queryTelemetry, getLatestDeviceData } from '../services/localAuth';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../utils/gatewayPayload';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import html2canvas from 'html2canvas';
import './History.css';

const HistoryPage = () => {
  const { deviceId: deviceIdFromRoute } = useParams();
  const { credentials, token, reAuthenticate } = useAuth();
  const { t } = useLanguage();
  
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

  // Data state
  const [historyData, setHistoryData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingProps, setLoadingProps] = useState(false);
  const [error, setError] = useState(null);
  const chartRef = useRef(null);

  // Load initial devices
  useEffect(() => {
    const loadDevices = async () => {
      try {
        const resp = await fetchDevices(credentials, token);
        const list = resp.data?.data?.content || resp.data?.content || [];
        setDevices(list);
        if (deviceIdFromRoute) {
          setSelectedDeviceId(String(deviceIdFromRoute));
        } else if (list.length > 0) {
          setSelectedDeviceId(list[0].deviceId.toString());
        }
      } catch (err) {
        console.error('Failed to load devices', err);
      }
    };
    if (token) loadDevices();
  }, [token, credentials, deviceIdFromRoute]);

  // Load properties when device changes
  useEffect(() => {
    if (!selectedDeviceId || !token) return;
    
    const loadProperties = async () => {
      setLoadingProps(true);
      try {
        const [tslResp, propsResp, localResp] = await Promise.all([
          fetchDeviceTsl(selectedDeviceId, credentials, token),
          import('../services/api').then(m => m.fetchDeviceProperties(selectedDeviceId, credentials, token)),
          getLatestDeviceData()
        ]);

        const liveFromAPI = propsResp.data?.properties || propsResp.data?.data?.properties || {};
        const localEntry = (localResp || []).find(d => 
          d.deviceId.toString() === selectedDeviceId.toString() ||
          (d.properties && (d.properties.devEUI === selectedDeviceId || d.properties.sn === selectedDeviceId))
        );
        const liveFromLocal = localEntry ? localEntry.properties || {} : {};
        const combinedLive = { ...liveFromAPI, ...liveFromLocal };
        const expandedLive = expandNestedGatewayTelemetry(combinedLive);

        let props = tslResp.data?.data?.properties || tslResp.data?.properties || tslResp.properties || [];
        
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

        setProperties(props);
        if (props.length > 0) setSelectedPropKey(props[0].propertyKey);
      } catch (err) {
        console.error('Failed to load properties', err);
      } finally {
        setLoadingProps(false);
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
      
      let results = [];

      // 1. Try local server first (persistent telemetry saved on change)
      try {
        const localData = await queryTelemetry(selectedDeviceId, selectedPropKey, startMs, endMs);
        if (localData && localData.length > 0) {
          results = localData.map(item => ({
            ts: item.timestamp,
            properties: item.properties
          }));
        }
      } catch (e) {
        console.warn('Local telemetry query failed:', e.message);
      }

      // 2. Si no hay datos locales, historial desde el servidor (ingesta almacenada)
      if (results.length === 0) {
        const resp = await fetchDeviceHistory(selectedDeviceId, {
          startTime: startMs,
          endTime: endMs
        }, credentials, token);
        const list = resp.list || resp.data?.list || [];
        results = list.map(item => ({
          ts: item.ts,
          properties: item.properties
        }));
      }
      
      const formatted = results.map(item => ({
        timestamp: new Date(item.ts).toLocaleString(),
        value: item.properties[selectedPropKey],
        rawTs: item.ts
      })).sort((a, b) => a.rawTs - b.rawTs);
      
      setHistoryData(formatted);
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
    const rows = historyData.map(item => [
      `"${item.timestamp}"`, 
      `"${item.value}"`
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
           backgroundColor: '#0f172a', // Dark theme matching the UI
           scale: 2 // High resolution
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
    <div className="history-page">
      <div className="page-header">
        <h1>{t('history.title')}</h1>
        <div className="header-actions">
          <button 
            className="btn btn-secondary" 
            onClick={exportToCSV}
            disabled={historyData.length === 0}
            title="Descargar CSV"
          >
            <Download size={18} /> CSV
          </button>
          <button 
            className="btn btn-primary" 
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
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis 
                    dataKey="timestamp" 
                    hide 
                  />
                  <YAxis stroke="rgba(255,255,255,0.5)" />
                  <Tooltip 
                    contentStyle={{ background: '#1a1a2e', border: '1px solid #333', borderRadius: '8px' }}
                    itemStyle={{ color: 'var(--accent-blue)' }}
                  />
                  <Legend />
                  <Line 
                    type="monotone" 
                    dataKey="value" 
                    name={properties.find(p => p.propertyKey === selectedPropKey)?.name}
                    stroke="var(--accent-blue)" 
                    strokeWidth={2}
                    dot={{ r: 4, fill: 'var(--accent-blue)' }}
                    activeDot={{ r: 6 }}
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
                    <td>{row.value}</td>
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
