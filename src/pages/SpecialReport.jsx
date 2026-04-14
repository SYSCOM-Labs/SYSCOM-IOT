import React, { useState, useEffect, useRef } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell 
} from 'recharts';
import { Calculator, Plus, Trash2, Download, FileText, Calendar, Clock, RefreshCw } from 'lucide-react';
import { fetchDevices, fetchDeviceTsl, fetchDeviceProperties } from '../services/api';
import { queryTelemetry, getLatestDeviceData } from '../services/localAuth';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../utils/gatewayPayload';
import { useAuth } from '../context/AuthContext';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import html2canvas from 'html2canvas';
import './SpecialReport.css';

const SpecialReport = () => {
  const { credentials, token } = useAuth();

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

  const handleCalculate = async () => {
    setLoading(true);
    setCalculationResult(null);
    setError(null);
    try {
      const startMs = new Date(startTime).getTime();
      const endMs = new Date(endTime).getTime();
      const duration = endMs - startMs;
      const prevStartMs = startMs - duration;
      const prevEndMs = startMs;
      
      const computedOperands = [];
      const prevOperands = [];
      
      for (const op of operands) {
        if (!op.deviceId || !op.propKey) continue;
        
        // Query history for this specific operand (Current and Previous)
        const historyCurrent = await queryTelemetry(op.deviceId, op.propKey, startMs, endMs);
        const historyPrev    = await queryTelemetry(op.deviceId, op.propKey, prevStartMs, prevEndMs);
        
        const device = devices.find(d => d.deviceId.toString() === op.deviceId.toString());
        const prop = (deviceProperties[op.deviceId] || []).find(p => p.propertyKey === op.propKey);

        const buildOp = (hist) => {
            if (hist.length === 0) return { ...op, value: 0, status: 'No data' };
            const sum = hist.reduce((acc, curr) => acc + parseFloat(curr.properties[op.propKey] || 0), 0);
            return { 
                ...op, 
                value: sum / hist.length, 
                deviceName: device?.name || device?.sn || op.deviceId,
                propName: prop?.name || op.propKey,
                unit: prop?.unit || ''
            };
        };

        computedOperands.push(buildOp(historyCurrent));
        prevOperands.push(buildOp(historyPrev));
      }

      if (computedOperands.length === 0) throw new Error("Selecciona al menos un dispositivo y variable.");

      const validOps = computedOperands.filter(op => op.status !== 'No data');
      if (validOps.length === 0) {
        throw new Error("No se encontraron datos históricos para los dispositivos seleccionados en este rango de tiempo.");
      }

      // Math for Current
      let result = validOps[0].value;
      for (let i = 1; i < validOps.length; i++) {
          const val = computedOperands[i].value;
          if (operator === '+') result += val;
          else if (operator === '-') result -= val;
          else if (operator === '*') result *= val;
          else if (operator === '/') result = val !== 0 ? result / val : 0;
      }

      // Math for Previous
      let prevResult = prevOperands[0]?.value || 0;
      for (let i = 1; i < prevOperands.length; i++) {
          const val = prevOperands[i].value;
          if (operator === '+') prevResult += val;
          else if (operator === '-') prevResult -= val;
          else if (operator === '*') prevResult *= val;
          else if (operator === '/') prevResult = val !== 0 ? prevResult / val : 0;
      }

      const diff = result - prevResult;
      const pct = prevResult !== 0 ? (diff / Math.abs(prevResult)) * 100 : 0;
      
      // Automatic Conclusion
      let conclusion = '';
      if (prevResult === 0) {
        conclusion = `El resultado del cálculo actual es ${result.toFixed(2)}. No hay datos históricos suficientes para una comparativa directa.`;
      } else {
        const trend = diff >= 0 ? 'aumento' : 'disminución';
        conclusion = `Se observa un ${trend} del ${Math.abs(pct).toFixed(1)}% respecto al periodo anterior. El valor previo era de ${prevResult.toFixed(2)}, mientras que el actual es ${result.toFixed(2)}.`;
      }

      setCalculationResult({
          operands: computedOperands,
          prevValue: prevResult,
          operator,
          finalValue: result,
          difference: diff,
          percentChange: pct,
          conclusion,
          timestamp: new Date().toLocaleString()
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
    
    let csv = "Reporte Especial de Operaciones Matemáticas\n";
    csv += `Rango:;${startTime};a;${endTime}\n\n`;
    csv += "Operando;Dispositivo;Variable;Valor Promedio;Unidad\n";
    
    operands.forEach((op, i) => {
        csv += `${i+1};${op.deviceName};${op.propName};${op.value.toFixed(2)};${op.unit}\n`;
    });
    
    csv += `\nOPERACIÓN:;${operator}\n`;
    csv += `RESULTADO FINAL:;${finalValue.toFixed(2)}\n`;
    csv += `RESULTADO PREVIO:;${calculationResult.prevValue.toFixed(2)}\n`;
    csv += `DIFERENCIA:;${calculationResult.difference.toFixed(2)} (${calculationResult.percentChange.toFixed(1)}%)\n`;
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
        op.value.toFixed(2) + ' ' + op.unit
    ]);

    doc.autoTable({
        startY: 50,
        head: [['#', 'Dispositivo', 'Variable', 'Promedio en Periodo']],
        body: tableData,
        theme: 'striped',
        headStyles: { fillColor: [59, 130, 246] }
    });

    const finalY = doc.lastAutoTable.finalY + 15;
    doc.setFontSize(14);
    doc.setTextColor(50);
    doc.text('Comparativa y Conclusión:', 14, finalY);
    
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Valor actual: ${finalValue.toFixed(2)}`, 14, finalY + 8);
    doc.text(`Valor en periodo previo: ${calculationResult.prevValue.toFixed(2)}`, 14, finalY + 14);
    doc.text(`Cambio: ${calculationResult.percentChange.toFixed(1)}%`, 14, finalY + 20);

    doc.setFontSize(11);
    doc.setTextColor(59, 130, 246);
    doc.text(doc.splitTextToSize(calculationResult.conclusion, 180), 14, finalY + 30);

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
    <div className="special-report-page">
      <div className="page-header">
        <h1>Reporte Especial</h1>
        <p className="subtitle">Realiza operaciones matemáticas entre múltiples dispositivos.</p>
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
            <div className="operator-btns">
              {['+', '-', '*', '/'].map(op => (
                <button 
                  key={op} 
                  className={`op-btn ${operator === op ? 'active' : ''}`}
                  onClick={() => setOperator(op)}
                >
                  {op === '+' ? 'Suma' : op === '-' ? 'Resta' : op === '*' ? 'Mult.' : 'Div.'}
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
                  <span className="label">Resultado Final</span>
                  <span className="value">{calculationResult.finalValue.toFixed(4)}</span>
                  <div className={`comparison-badge ${calculationResult.percentChange >= 0 ? 'positive' : 'negative'}`}>
                    {calculationResult.percentChange >= 0 ? '▲' : '▼'} {Math.abs(calculationResult.percentChange).toFixed(1)}%
                    <span className="prev-val"> vs prev: {calculationResult.prevValue.toFixed(2)}</span>
                  </div>
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
                <h4>Comparativa Visual (Promedios)</h4>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={[
                    { name: 'Previo', value: calculationResult.prevValue },
                    { name: 'Actual', value: calculationResult.finalValue }
                  ]}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                    <XAxis dataKey="name" stroke="var(--text-secondary)" />
                    <YAxis stroke="var(--text-secondary)" />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)', color: '#fff' }}
                      itemStyle={{ color: 'var(--accent-blue)' }}
                    />
                    <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={60}>
                      <Cell fill="rgba(255,255,255,0.2)" />
                      <Cell fill="var(--accent-blue)" />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="result-table-wrapper">
                <table className="result-table">
                  <thead>
                    <tr>
                      <th>Dispositivo</th>
                      <th>Variable</th>
                      <th>Promedio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calculationResult.operands.map((op, i) => (
                      <tr key={i}>
                        <td>{op.deviceName}</td>
                        <td>{op.propName}</td>
                        <td>{op.value.toFixed(2)} {op.unit}</td>
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
