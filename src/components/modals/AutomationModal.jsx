import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Mail, MessageSquare, Globe, Zap, Clock, Calendar } from 'lucide-react';
import { fetchDevices, fetchDeviceTsl, fetchDeviceProperties } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { getLatestDeviceData } from '../../services/localAuth';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../../utils/gatewayPayload';
import './AutomationModal.css';

const AutomationModal = ({ isOpen, onClose, onSave, rule }) => {
  const { credentials, token } = useAuth();
  
  const [name, setName] = useState(rule?.name || '');
  const [conditions, setConditions] = useState(rule?.conditions || [
    { deviceId: '', propKey: '', propName: '', operator: '==', value: '' }
  ]);
  const [actions, setActions] = useState(rule?.actions || [
    { type: 'email', target: '', targetDeviceId: '', commandKey: '', payload: '', delay: 0 }
  ]);

  // Scheduling
  const [activeDays, setActiveDays] = useState(rule?.activeDays || [0, 1, 2, 3, 4, 5, 6]); // 0-6 Sun-Sat
  const [scheduleStart, setScheduleStart] = useState(rule?.scheduleStart || '00:00');
  const [scheduleEnd, setScheduleEnd] = useState(rule?.scheduleEnd || '23:59');

  const [reactivation, setReactivation] = useState(rule?.reactivation || 60);
  const [allowReactivation, setAllowReactivation] = useState(rule?.allowReactivation || false);

  const [devices, setDevices] = useState([]);
  const [deviceProperties, setDeviceProperties] = useState({}); 
  const [deviceDownlinks, setDeviceDownlinks] = useState({});
  const [deviceServiceCommands, setDeviceServiceCommands] = useState({});

  useEffect(() => {
    const loadData = async () => {
      try {
        const resp = await fetchDevices(credentials, token);
        const list = resp.data?.data?.content || resp.data?.content || [];
        setDevices(list);
      } catch (err) { console.error('AutomationModal fetchDevices error:', err); }
    };
    loadData();
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
      const services = tslResp.data?.data?.services || tslResp.data?.services || tslResp.services || [];
      
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
      if (Array.isArray(services)) {
        const mappedServices = services
          .filter(s => s?.id)
          .map(s => ({ name: s.name || s.id, value: s.id, source: 'service' }));
        setDeviceServiceCommands(prev => ({ ...prev, [deviceId]: mappedServices }));
      }
    } catch (err) { console.error('fetchProps error:', err); }
  };

  const getSavedDownlinks = (deviceId) => {
    if (!deviceId) return [];
    if (deviceDownlinks[deviceId]) return deviceDownlinks[deviceId];
    const saved = localStorage.getItem('downlinks_' + deviceId);
    const list = saved ? JSON.parse(saved) : [];
    setDeviceDownlinks(prev => ({ ...prev, [deviceId]: list }));
    return list;
  };

  const getAvailableCommands = (deviceId) => {
    if (!deviceId) return [];
    const saved = getSavedDownlinks(deviceId).map(cmd => ({
      name: cmd.name || cmd.hex,
      value: cmd.hex,
      source: 'saved'
    }));
    const services = deviceServiceCommands[deviceId] || [];
    const seen = new Set();
    return [...saved, ...services].filter(cmd => {
      const key = `${cmd.value}`.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const addCondition = () => {
    setConditions([...conditions, { deviceId: '', propKey: '', propName: '', operator: '==', value: '' }]);
  };

  const removeCondition = (index) => {
    setConditions(conditions.filter((_, i) => i !== index));
  };

  const updateCondition = (index, field, value) => {
    const newConditions = [...conditions];
    newConditions[index][field] = value;
    if (field === 'deviceId') { fetchProps(value); newConditions[index].propKey = ''; }
    if (field === 'propKey' && deviceProperties[newConditions[index].deviceId]) {
      const p = deviceProperties[newConditions[index].deviceId].find(x => x.propertyKey === value);
      newConditions[index].propName = p ? p.name : value;
    }
    setConditions(newConditions);
  };

  const addAction = () => {
    setActions([...actions, { type: 'email', target: '', targetDeviceId: '', commandKey: '', payload: '', delay: 0 }]);
  };

  const removeAction = (index) => {
    setActions(actions.filter((_, i) => i !== index));
  };

  const updateAction = (index, field, value) => {
    const newActions = [...actions];
    newActions[index][field] = value;
    if (field === 'targetDeviceId') {
      getSavedDownlinks(value);
      fetchProps(value);
      newActions[index].commandKey = '';
    }
    if (field === 'commandKey') {
      const commands = getAvailableCommands(newActions[index].targetDeviceId);
      const cmd = commands.find(c => c.value === value);
      newActions[index].target = cmd ? cmd.name : value;
    }
    setActions(newActions);
  };

  const toggleDay = (day) => {
    if (activeDays.includes(day)) {
      setActiveDays(activeDays.filter(d => d !== day));
    } else {
      setActiveDays([...activeDays, day]);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name) return alert('Por favor, introduce un nombre.');
    onSave({ 
      name, 
      conditions, 
      actions, 
      activeDays, 
      scheduleStart, 
      scheduleEnd, 
      reactivation, 
      allowReactivation 
    });
  };

  const daysLabels = [
    { id: 1, label: 'L' }, { id: 2, label: 'M' }, { id: 3, label: 'X' }, 
    { id: 4, label: 'J' }, { id: 5, label: 'V' }, { id: 6, label: 'S' }, { id: 0, label: 'D' }
  ];

  const actionTypes = [
    { id: 'email', label: 'Enviar email', icon: <Mail size={14} /> },
    { id: 'webhook', label: 'Llamar a un webhook', icon: <Globe size={14} /> },
    { id: 'downlink', label: 'Enviar downlink', icon: <Zap size={14} /> }
  ];

  const operators = [
    { id: '<', label: 'menor a' }, { id: '<=', label: 'menor o igual a' },
    { id: '==', label: 'igual a' }, { id: '!=', label: 'distinto a' },
    { id: '>=', label: 'mayor o igual a' }, { id: '>', label: 'mayor a' }
  ];

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content rule-modal">
        <header className="modal-header">
          <h2>{rule ? 'Editar regla' : 'Nueva regla'}</h2>
          <button className="btn-icon" onClick={onClose}><X size={20} /></button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="modal-body scrollable">
            <div className="form-group">
              <label>Nombre</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Introduce un nombre" className={!name ? 'error' : ''} />
              {!name && <span className="error-text">Introduce un nombre</span>}
            </div>

            <div className="rule-config-section">
              <label className="section-label">Horario de funcionamiento</label>
              <div className="schedule-config glass">
                <div className="days-selector">
                  {daysLabels.map(day => (
                    <button 
                      key={day.id} 
                      type="button" 
                      className={`day-btn ${activeDays.includes(day.id) ? 'active' : ''}`}
                      onClick={() => toggleDay(day.id)}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
                <div className="time-range-selector">
                  <div className="time-input">
                    <Clock size={14} />
                    <input type="time" value={scheduleStart} onChange={e => setScheduleStart(e.target.value)} />
                  </div>
                  <span className="joiner">hasta</span>
                  <div className="time-input">
                    <Clock size={14} />
                    <input type="time" value={scheduleEnd} onChange={e => setScheduleEnd(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>

            <div className="rule-config-section">
              <label className="section-label">Condiciones</label>
              <div className="conditions-container">
                {conditions.map((cond, index) => (
                  <div key={index} className="row-item glass border">
                    <span className="row-label">{index === 0 ? 'Si' : 'And'}</span>
                    <div className="row-fields">
                      <select value={cond.deviceId} onChange={e => updateCondition(index, 'deviceId', e.target.value)} className="field-device">
                        <option value="">Elegir dispositivo</option>
                        {devices.map(d => (<option key={d.deviceId} value={d.deviceId}>{d.name || d.sn}</option>))}
                      </select>
                      <select value={cond.propKey} onChange={e => updateCondition(index, 'propKey', e.target.value)} className="field-prop" disabled={!cond.deviceId}>
                        <option value="">Valor</option>
                        {(deviceProperties[cond.deviceId] || []).map(p => (<option key={p.id} value={p.propertyKey}>{p.name}</option>))}
                      </select>
                      <span className="joiner">es</span>
                      <select value={cond.operator} onChange={e => updateCondition(index, 'operator', e.target.value)} className="field-operator">
                        {operators.map(op => (<option key={op.id} value={op.id}>{op.label}</option>))}
                      </select>
                      <input type="text" value={cond.value} onChange={e => updateCondition(index, 'value', e.target.value)} placeholder="Valor" className="field-value" />
                    </div>
                    <button type="button" className="btn-icon delete" onClick={() => removeCondition(index)}><Trash2 size={16} /></button>
                  </div>
                ))}
                <button type="button" className="add-row-btn" onClick={addCondition}>
                  <Plus size={16} /> Agregar condición
                </button>
              </div>
            </div>

            <div className="rule-config-section">
              <label className="section-label">Then (Acciones)</label>
              <div className="actions-container">
                {actions.map((action, index) => (
                  <div key={index} className="row-item glass border action-row-complex">
                    <div className="action-main-row">
                      <span className="row-label">Then</span>
                      <div className="row-fields">
                        <select value={action.type} onChange={e => updateAction(index, 'type', e.target.value)} className="field-action-type">
                          {actionTypes.map(t => (<option key={t.id} value={t.id}>{t.label}</option>))}
                        </select>
                        {action.type === 'downlink' ? (
                          <>
                            <select value={action.targetDeviceId} onChange={e => updateAction(index, 'targetDeviceId', e.target.value)} className="field-target-device">
                              <option value="">Dispositivo</option>
                              {devices.map(d => (<option key={d.deviceId} value={d.deviceId}>{d.name || d.sn}</option>))}
                            </select>
                            <select value={action.commandKey} onChange={e => updateAction(index, 'commandKey', e.target.value)} className="field-command" disabled={!action.targetDeviceId}>
                              <option value="">Comando</option>
                              {getAvailableCommands(action.targetDeviceId).map((cmd, i) => (
                                <option key={i} value={cmd.value}>
                                  {cmd.source === 'service' ? `${cmd.name} (Service)` : `${cmd.name} (Guardado)`}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <input type="text" value={action.target} onChange={e => updateAction(index, 'target', e.target.value)} placeholder={action.type === 'email' ? 'Email' : action.type === 'webhook' ? 'URL' : 'Destino'} className="field-target" />
                        )}
                      </div>
                      <button type="button" className="btn-icon delete" onClick={() => removeAction(index)}><Trash2 size={16} /></button>
                    </div>
                    <div className="action-delay-row">
                      <div className="delay-input-group">
                        <Clock size={12} />
                        <span>Delay:</span>
                        <input type="number" value={action.delay} onChange={e => updateAction(index, 'delay', e.target.value)} min="0" />
                        <span className="unit">segundos</span>
                      </div>
                    </div>
                  </div>
                ))}
                <button type="button" className="add-row-btn" onClick={addAction}>
                  <Plus size={16} /> Agregar acción
                </button>
              </div>
            </div>

            <div className="options-section">
              <div className="reactivation-row">
                <label className="checkbox-label">
                  <input type="checkbox" checked={allowReactivation} onChange={e => setAllowReactivation(e.target.checked)} />
                  Permitir la reactivación después de
                </label>
                <input type="number" value={reactivation} onChange={e => setReactivation(e.target.value)} className="reactivation-input" />
                <span className="unit">segundos.</span>
              </div>
            </div>
          </div>

          <footer className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary">{rule ? 'Guardar cambios' : 'Crear regla'}</button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default AutomationModal;
