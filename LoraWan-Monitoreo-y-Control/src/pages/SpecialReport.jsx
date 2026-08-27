import React, { useState, useEffect, useRef } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer 
} from 'recharts';
import { Calculator, Plus, Trash2, Download, FileText, Calendar, Clock, RefreshCw } from 'lucide-react';
import { fetchDevices, fetchDeviceTsl, fetchDeviceProperties, fetchDeviceHistory } from '../services/api';
import { queryTelemetry, getLatestDeviceData } from '../services/localAuth';
import { lastCumulativeInRows, periodIncrementalTotal } from '../utils/incrementalTelemetry';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../utils/gatewayPayload';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import html2canvas from 'html2canvas';
import './SpecialReport.css';

const SpecialReport = () => {
  const { credentials, token } = useAuth();
  const { t } = useLanguage();

  const [devices, setDevices] = useState([]);
  const [deviceProperties, setDeviceProperties] = useState({});
  const [operands, setOperands] = useState([
    { id: 1, deviceId: '', propKey: '', propName: '', value: null }
  ]);
  const [operator, setOperator] = useState('+');
  
  const reportRef = useRef(null);
  
  const [startTime, setStartTime] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [endTime, setEndTime] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 16);
  });

  const [calculationResult, setCalculationResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const resp = await fetchDevices(credentials, token);
        const list = resp.data?.data?.content || resp.data?.content || [];
        setDevices(list);
      } catch (err) { console.error(err); }
    };
    loadDevices();
  }, []);

  const fetchProps = async (deviceId) => {
    if (!deviceId || deviceProperties[deviceId]) return;
    try {
      const [tslResp, propsResp, localResp] = await Promise.all([
        fetchDeviceTsl(deviceId, credentials, token),
        fetchDeviceProperties(deviceId, credentials, token),
        getLatestDeviceData()
      ]);
      
      const liveFromAPI = propsResp.data?.properties || propsResp.data?.data?.properties || {};
      const localEntry = (localResp || []).find(d => d.deviceId.toString() === deviceId.toString());
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

      setDeviceProperties(prev => ({ ...prev, [deviceId]: props }));
    } catch (err) { console.error(err); }
  };

  const addOperand = () => {
    setOperands([...operands, { id: Date.now(), deviceId: '', propKey: '', propName: '', value: null }]);
  };

  const removeOperand = (id) => {
    if (operands.length > 1) {
      setOperands(operands.filter(op => op.id !== id));
    }
  };

  const updateOperand = (id, field, value) => {
    const newOps = operands.map(op => {
      if (op.id === id) {
        if (field === 'deviceId') fetchProps(value);
        return { ...op, [field]: value };
      }
      return op;
    });
    setOperands(newOps);
  };

  const fetchTelemetrySamples = async (deviceId, propKey, fromMs, toMs) => {
    let hist = await queryTelemetry(deviceId, propKey, fromMs, toMs);
    if (!hist || hist.length === 0) {
      const resp = await fetchDeviceHistory(
        deviceId,
        { startTime: fromMs, endTime: toMs },
        credentials,
        token
      );
      const list = resp.list || resp.data?.list || [];
      hist = list.map((item) => ({
        timestamp: item.timestamp ?? item.ts,
        properties: item.properties || {},
      }));
    } else {
      hist = hist.map((item) => ({
        timestamp: item.timestamp ?? item.ts,
        properties: item.properties || {},
      }));
    }
    return hist;
  };

  const handleCalculate = async () => {
    setLoading(true);
    setCalculationResult(null);
    setError(null);
    try {
      const startMs = new Date(startTime).getTime();
      const endMs = new Date(endTime).getTime();

      const computedOperands = [];

      for (const op of operands) {
        if (!op.deviceId || !op.propKey) continue;

        const device = devices.find((d) => d.deviceId.toString() === op.deviceId.toString());
        const prop = (deviceProperties[op.deviceId] || []).find((p) => p.propertyKey === op.propKey);

        const windowRows = await fetchTelemetrySamples(op.deviceId, op.propKey, startMs, endMs);
        const beforeRows =
          startMs > 0 ? await fetchTelemetrySamples(op.deviceId, op.propKey, 0, Math.max(0, startMs - 1)) : [];

        const baseline = lastCumulativeInRows(beforeRows, op.propKey);
        const lastInWindow = lastCumulativeInRows(windowRows, op.propKey);
        const incr = periodIncrementalTotal(lastInWindow, baseline);

        if (incr === null || lastInWindow === null) {
          computedOperands.push({
            ...op,
            value: 0,
            status: 'No data',
            deviceName: device?.name || device?.sn || op.deviceId,
            propName: prop?.name || op.propKey,
            unit: prop?.unit || '',
          });
          continue;
        }

        computedOperands.push({
          ...op,
          value: incr,
          status: undefined,
          deviceName: device?.name || device?.sn || op.deviceId,
          propName: prop?.name || op.propKey,
          unit: prop?.unit || '',
        });
      }

      if (computedOperands.length === 0) throw new Error('Selecciona al menos un dispositivo y variable.');

      const okOps = computedOperands.filter((c) => c.status !== 'No data');
      if (okOps.length === 0) {
        throw new Error(
          'No se encontraron datos numéricos en el rango para los dispositivos seleccionados (valores incrementales).'
        );
      }

      const fold = (values, op) => {
        let acc = values[0];
        for (let i = 1; i < values.length; i++) {
          const val = values[i];
          if (op === '+') acc += val;
          else if (op === '-') acc -= val;
          else if (op === '*') acc *= val;
          else if (op === '/') acc = val !== 0 ? acc / val : 0;
        }
        return acc;
      };

      const vals = okOps.map((p) => p.value);
      const result = fold(vals, operator);

      const opLabel =
        operator === '+' ? 'suma' : operator === '-' ? 'resta' : operator === '*' ? 'multiplicación' : 'división';
      const conclusion = `Total incremental en el periodo (${opLabel} entre filas): ${result.toFixed(4)}. Cada fila usa el consumo o incremento registrado entre el inicio y el fin del rango (sin arrastrar acumulados anteriores).`;

      setCalculationResult({
        operands: computedOperands,
        operator,
        finalValue: result,
        conclusion,
        timestamp: new Date().toLocaleString(),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const exportToCSV = () => {
    if (!calculationResult) return;
    const { operands, finalValue, operator } = calculationResult;
    
    let csv = 'Reporte Especial de Operaciones Matemáticas (valores incrementales en el periodo)\n';
    csv += `Rango:;${startTime};a;${endTime}\n\n`;
    csv += 'Operando;Dispositivo;Variable;Total incremental;Unidad\n';

    operands.forEach((op, i) => {
      const cell = op.status === 'No data' ? 'Sin datos' : op.value.toFixed(4);
      csv += `${i + 1};${op.deviceName};${op.propName};${cell};${op.unit}\n`;
    });

    csv += `\nOPERACIÓN:;${operator}\n`;
    csv += `RESULTADO FINAL:;${finalValue.toFixed(4)}\n`;
    csv += `\nCONCLUSIÓN:;${calculationResult.conclusion}\n`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `reporte_especial_${Date.now()}.csv`;
    link.click();
  };

  const exportToPDF = async () => {
    if (!calculationResult) return;
    const { operands, finalValue, operator } = calculationResult;

    const doc = new jsPDF();
    doc.setFontSize(22);
    doc.setTextColor(59, 130, 246);
    doc.text('Reporte Especial Matemático', 14, 22);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Rango de consulta: ${startTime} - ${endTime}`, 14, 32);
    doc.text(`Operación aplicada: ${operator === '+' ? 'Suma' : operator === '-' ? 'Resta' : operator === '*' ? 'Multiplicación' : 'División'}`, 14, 38);
    doc.text(`Fecha de generación: ${new Date().toLocaleString()}`, 14, 44);

    const tableData = operands.map((op, i) => [
      i + 1,
      op.deviceName,
      op.propName,
      (op.status === 'No data' ? 'Sin datos' : op.value.toFixed(4)) + ' ' + op.unit,
    ]);

    doc.autoTable({
      startY: 50,
      head: [['#', 'Dispositivo', 'Variable', 'Total incremental (periodo)']],
      body: tableData,
      theme: 'striped',
      headStyles: { fillColor: [59, 130, 246] },
    });

    const finalY = doc.lastAutoTable.finalY + 15;
    doc.setFontSize(14);
    doc.setTextColor(50);
    doc.text('Resultado y conclusión:', 14, finalY);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Resultado de la operación: ${finalValue.toFixed(4)}`, 14, finalY + 8);

    doc.setFontSize(11);
    doc.setTextColor(59, 130, 246);
    doc.text(doc.splitTextToSize(calculationResult.conclusion, 180), 14, finalY + 18);

    // ADD CHART TO PDF
    if (reportRef.current) {
        setLoading(true);
        const canvas = await html2canvas(reportRef.current, { backgroundColor: '#0f172a', scale: 2 });
        const imgData = canvas.toDataURL('image/png');
        doc.addPage();
        doc.setFontSize(16);
        doc.text('Análisis Visual Comparativo', 14, 20);
        doc.addImage(imgData, 'PNG', 14, 30, 180, 100);
        setLoading(false);
    }

    doc.save(`reporte_especial_${Date.now()}.pdf`);
  };

  return (
    <div className="special-report-page device-list-page device-list-page--premium premium-shell">
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <Calculator size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">{t('nav.special_report')}</span>
          </h1>
        </div>
      </div>

      <div className="report-container grid">
        <section className="config-section glass card">
          {error && (
            <div className="error-message glass">
              <RefreshCw size={16} />
              <span>{error}</span>
            </div>
          )}
          <div className="section-title">
            <Calculator size={20} />
            <h3>Configuración del Cálculo</h3>
          </div>

          <div className="date-range-picker glass">
            <div className="date-input">
              <label><Calendar size={14} /> Inicio</label>
              <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div className="date-input">
              <label><Clock size={14} /> Fin</label>
              <input type="datetime-local" value={endTime} onChange={e => setEndTime(e.target.value)} />
            </div>
          </div>

          <div className="operands-list">
            <label className="label-lite">Operandos (Variables a procesar)</label>
            {operands.map((op, index) => (
              <div key={op.id} className="operand-row glass border">
                <span className="op-index">{index + 1}</span>
                <select 
                  value={op.deviceId} 
                  onChange={e => updateOperand(op.id, 'deviceId', e.target.value)}
                >
                  <option value="">Dispositivo</option>
                  {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.name || d.sn}</option>)}
                </select>
                <select 
                  value={op.propKey} 
                  onChange={e => updateOperand(op.id, 'propKey', e.target.value)}
                  disabled={!op.deviceId}
                >
                  <option value="">Variable</option>
                  {(deviceProperties[op.deviceId] || []).map(p => <option key={p.id} value={p.propertyKey}>{p.name}</option>)}
                </select>
                <button className="btn-icon delete" onClick={() => removeOperand(op.id)} disabled={operands.length === 1}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button className="btn-add-op" onClick={addOperand}>
              <Plus size={16} /> Añadir otro dispositivo
            </button>
          </div>

          <div className="operator-selection">
            <label className="label-lite">Operación Matemática</label>
            <p className="operator-hint">
              Cada fila usa el <strong>total incremental</strong> de la variable en el rango (consumo o conteo del
              periodo, sin arrastrar acumulados previos). La operación se aplica en cadena entre filas:{' '}
              <code>(v1 op v2) op v3 …</code>
            </p>
            <div className="operator-btns">
              {['+', '-', '*', '/'].map(op => (
                <button 
                  key={op} 
                  className={`op-btn ${operator === op ? 'active' : ''}`}
                  onClick={() => setOperator(op)}
                >
                  {op === '+' ? 'Suma' : op === '-' ? 'Resta' : op === '*' ? 'Multiplicación' : 'División'}
                </button>
              ))}
            </div>
          </div>

          <button className="btn btn-primary calculate-btn" onClick={handleCalculate} disabled={loading}>
            {loading ? <RefreshCw size={20} className="spin" /> : 'Calcular Reporte'}
          </button>
        </section>

        <section className="result-section glass card">
          <div className="section-title">
            <FileText size={20} />
            <h3>Vista Previa del Resultado</h3>
          </div>

          {calculationResult ? (
            <div className="result-display">
              <div className="result-header">
                <div className="final-value">
                  <span className="label">Resultado (incrementales en el periodo)</span>
                  <span className="value">{calculationResult.finalValue.toFixed(4)}</span>
                </div>
                <div className="export-actions">
                  <button className="btn btn-secondary" onClick={exportToCSV}><Download size={16} /> CSV</button>
                  <button className="btn btn-primary" onClick={exportToPDF}><FileText size={16} /> PDF</button>
                </div>
              </div>

              <div className="conclusion-box glass border">
                <h4>Conclusión Automática</h4>
                <p>{calculationResult.conclusion}</p>
              </div>

              <div className="report-chart-container glass border" ref={reportRef}>
                <h4>Totales incrementales por operando</h4>
                {calculationResult.operands.some((o) => o.status !== 'No data') ? (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart
                      data={calculationResult.operands
                        .filter((o) => o.status !== 'No data')
                        .map((o) => ({
                          name: String(o.propName || o.deviceName || '').slice(0, 18),
                          value: o.value,
                        }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                      <XAxis dataKey="name" stroke="var(--text-secondary)" />
                      <YAxis stroke="var(--text-secondary)" />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--bg-card)',
                          borderColor: 'var(--border-color)',
                          color: '#fff',
                        }}
                        itemStyle={{ color: 'var(--accent-blue)' }}
                      />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={48} fill="var(--accent-blue)" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="special-report-chart-empty">Sin datos incrementales para graficar.</p>
                )}
              </div>

              <div className="result-table-wrapper">
                <table className="result-table">
                  <thead>
                    <tr>
                      <th>Dispositivo</th>
                      <th>Variable</th>
                      <th>Total incremental</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calculationResult.operands.map((op, i) => (
                      <tr key={i}>
                        <td>{op.deviceName}</td>
                        <td>{op.propName}</td>
                        <td>
                          {op.status === 'No data' ? '—' : `${op.value.toFixed(4)} ${op.unit || ''}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="empty-result">
              <Calculator size={48} />
              <p>Configura los parámetros y pulsa "Calcular Reporte" para ver los resultados aquí.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default SpecialReport;
