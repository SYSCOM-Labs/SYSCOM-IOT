import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Mail, MessageSquare, Globe, Zap, Clock, Calendar, Bell } from 'lucide-react';
import { fetchDevices, fetchDeviceTsl, fetchDeviceProperties } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { getLatestDeviceData } from '../../services/localAuth';
import { PROPERTY_INFER_IGNORE_KEYS, expandNestedGatewayTelemetry } from '../../utils/gatewayPayload';
import {
  inferTslPropsFromLive,
  normalizeAutomationPropertyList,
} from '../../utils/telemetryPropertyPicker';
import { readDownlinksFromLocalStorage } from '../../services/deviceTemplates';
import {
  effectiveAutomationConditions,
  resolveAutomationRuleMode,
} from '../../utils/automationRuleMode';
import { isTimeOperator, automationOperatorLabel, TIME_OPERATOR_LT, normalizeHoldOp } from '../../utils/automationDuration';
import './AutomationModal.css';

const CONDITION_OPERATORS = [
  { id: '<', label: 'menor a' },
  { id: '<=', label: 'menor o igual a' },
  { id: '==', label: 'igual a' },
  { id: '!=', label: 'distinto a' },
  { id: '>=', label: 'mayor o igual a' },
  { id: '>', label: 'mayor a' },
];

const HOLD_OPERATORS = [
  { id: '', label: '(sin tiempo)' },
  { id: 'gt', label: 'tiempo mayor a' },
  { id: 'lt', label: 'tiempo menor a' },
];

function normalizeConditionRow(c) {
  const base = c && typeof c === 'object' ? c : {};
  const propKey = String(
    base.propKey ?? base.propertyKey ?? base.fieldKey ?? base.field ?? base.metric ?? ''
  ).trim();
  const propName = String(
    base.propName ?? base.propertyName ?? base.fieldName ?? base.metricName ?? ''
  ).trim();
  let operator = base.operator != null ? String(base.operator) : '==';
  let value = base.value != null ? String(base.value) : '';
  let holdTime =
    base.holdTime != null && String(base.holdTime).trim()
      ? String(base.holdTime).trim()
      : base.time != null && String(base.time).trim()
        ? String(base.time).trim()
        : '';
  let holdOp = normalizeHoldOp(base.holdOp ?? base.holdOperator);
  if (isTimeOperator(operator)) {
    holdOp = operator === TIME_OPERATOR_LT ? 'lt' : 'gt';
    if (!holdTime) holdTime = value;
    value = '';
    operator = '==';
  }
  if (!holdOp && holdTime) holdOp = 'gt';
  return {
    deviceId: base.deviceId != null ? String(base.deviceId) : '',
    propKey,
    propName: propName || propKey,
    operator,
    operatorLabel: automationOperatorLabel(operator),
    value,
    holdOp,
    holdTime,
    useWidgetValue: Boolean(base.useWidgetValue),
  };
}

function findPropertyMeta(list, propKey) {
  const pk = String(propKey || '').trim();
  if (!pk || !Array.isArray(list)) return null;
  return (
    list.find((x) => String(x.propertyKey || x.id || '').trim() === pk) ||
    list.find((x) => String(x.id || '').trim() === pk) ||
    null
  );
}

function collectDeviceIdsFromRule(conds, acts) {
  const ids = new Set();
  for (const c of conds || []) {
    const id = c?.deviceId != null ? String(c.deviceId).trim() : '';
    if (id) ids.add(id);
  }
  for (const a of acts || []) {
    const id = a?.targetDeviceId != null ? String(a.targetDeviceId).trim() : '';
    if (id) ids.add(id);
  }
  return [...ids];
}

function defaultConditionRow() {
  return {
    deviceId: '',
    propKey: '',
    propName: '',
    operator: '==',
    operatorLabel: automationOperatorLabel('=='),
    value: '',
    holdOp: '',
    holdTime: '',
    useWidgetValue: false,
  };
}

function buildConditionsFromRule(rule) {
  const list = Array.isArray(rule?.conditions) ? rule.conditions : [];
  if (!list.length) return [defaultConditionRow()];
  return list.map(normalizeConditionRow);
}

/** URL de ejemplo / documentación de GitHub, no es el endpoint de PushMore. */
function isLikelyGithubDocUrlInsteadOfWebhook(target) {
  const t = String(target || '').toLowerCase();
  if (!t) return false;
  return t.includes('gist.github') || (t.includes('github.com') && !t.includes('pushmore'));
}

function normalizeDevicesListResponse(resp) {
  const body = resp && typeof resp === 'object' && 'data' in resp ? resp.data : resp;
  if (!body || typeof body !== 'object') return [];
  const c = body.data?.content ?? body.content;
  if (Array.isArray(c)) return c;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

const AutomationModal = ({ isOpen, onClose, onSave, rule, isDuplicate = false }) => {
  const { credentials, token, loading } = useAuth();
  
  const [name, setName] = useState(rule?.name || '');
  const [conditions, setConditions] = useState(() => buildConditionsFromRule(rule));
  const [actions, setActions] = useState(rule?.actions || [
    {
      type: 'email',
      target: '',
      emailSubject: '',
      emailBody: '',
      webhookBody: '',
      targetDeviceId: '',
      commandKey: '',
      payload: '',
      delay: 0,
      scheduleRunAt: 'start',
      toastTitle: '',
      toastMessage: '',
      toastVariant: 'indigo',
    },
  ]);

  // Scheduling
  const [activeDays, setActiveDays] = useState(rule?.activeDays || [0, 1, 2, 3, 4, 5, 6]); // 0-6 Sun-Sat
  const [scheduleStart, setScheduleStart] = useState(rule?.scheduleStart || '00:00');
  const [scheduleEnd, setScheduleEnd] = useState(rule?.scheduleEnd || '23:59');
  const [ruleBySchedule, setRuleBySchedule] = useState(
    () => resolveAutomationRuleMode(rule) === 'schedule'
  );

  const [reactivation, setReactivation] = useState(rule?.reactivation || 60);
  const [allowReactivation, setAllowReactivation] = useState(rule?.allowReactivation || false);

  const [devices, setDevices] = useState([]);
  const [devicesLoadError, setDevicesLoadError] = useState(null);
  const [deviceProperties, setDeviceProperties] = useState({}); 
  const [deviceDownlinks, setDeviceDownlinks] = useState({});
  const [deviceServiceCommands, setDeviceServiceCommands] = useState({});

  useEffect(() => {
    if (!isOpen) return;
    setName(rule?.name || '');
    const builtConditions = buildConditionsFromRule(rule);
    const builtActions =
      Array.isArray(rule?.actions) && rule.actions.length
        ? rule.actions.filter((a) => a && String(a.type) !== 'telegram').map((a) => ({ ...a }))
        : [
            {
              type: 'email',
              target: '',
              emailSubject: '',
              emailBody: '',
              webhookBody: '',
              targetDeviceId: '',
              commandKey: '',
              payload: '',
              delay: 0,
              scheduleRunAt: 'start',
              toastTitle: '',
              toastMessage: '',
              toastVariant: 'indigo',
            },
          ];
    setConditions(builtConditions);
    setActions(builtActions);
    setActiveDays(rule?.activeDays || [0, 1, 2, 3, 4, 5, 6]);
    setScheduleStart(rule?.scheduleStart || '00:00');
    setScheduleEnd(rule?.scheduleEnd || '23:59');
    setRuleBySchedule(resolveAutomationRuleMode(rule) === 'schedule');
    setReactivation(rule?.reactivation ?? 60);
    setAllowReactivation(Boolean(rule?.allowReactivation));
    for (const deviceId of collectDeviceIdsFromRule(builtConditions, builtActions)) {
      void fetchProps(deviceId);
    }
  }, [isOpen, rule]);

  useEffect(() => {
    if (!isOpen) return;
    setConditions((prev) =>
      prev.map((cond) => {
        if (!cond.deviceId || !cond.propKey) return cond;
        const list = deviceProperties[cond.deviceId];
        if (!list?.length) return cond;
        const p = findPropertyMeta(list, cond.propKey);
        if (!p) return cond;
        const name = p.name || cond.propName || cond.propKey;
        if (name === cond.propName) return cond;
        return { ...cond, propName: name };
      })
    );
  }, [deviceProperties, isOpen]);

  useEffect(() => {
    if (!isOpen || loading) return;

    let cancelled = false;
    const loadData = async () => {
      setDevicesLoadError(null);
      try {
        const resp = await fetchDevices(credentials, token);
        const list = normalizeDevicesListResponse(resp);
        if (!cancelled) setDevices(list);
      } catch (err) {
        console.error('AutomationModal fetchDevices error:', err);
        if (!cancelled) {
          setDevices([]);
          setDevicesLoadError(err?.response?.data?.error || err?.message || 'No se pudo cargar el listado de dispositivos');
        }
      }
    };
    void loadData();
    return () => {
      cancelled = true;
    };
  }, [isOpen, loading, token, credentials]);

  const fetchProps = async (deviceId) => {
    const did = deviceId != null ? String(deviceId).trim() : '';
    if (!did) return;
    try {
      const [tslResp, propsResp, localResp] = await Promise.all([
        fetchDeviceTsl(did, credentials, token),
        fetchDeviceProperties(did, credentials, token),
        getLatestDeviceData()
      ]);
      
      const liveFromAPI = propsResp.data?.properties || propsResp.data?.data?.properties || {};
      const localEntry = (localResp || []).find(d => d.deviceId.toString() === did.toString());
      const liveFromLocal = localEntry ? localEntry.properties || {} : {};
      const combinedLive = { ...liveFromAPI, ...liveFromLocal };
      const expandedLive = expandNestedGatewayTelemetry(combinedLive);

      let props = tslResp.data?.data?.properties || tslResp.data?.properties || tslResp.properties || [];
      const services = tslResp.data?.data?.services || tslResp.data?.services || tslResp.services || [];
      
      if (!Array.isArray(props) || props.length === 0) {
        props = inferTslPropsFromLive(expandedLive);
      }

      const normalized = normalizeAutomationPropertyList(props);
      setDeviceProperties((prev) => ({ ...prev, [did]: normalized }));
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
    const list = readDownlinksFromLocalStorage(deviceId);
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
    setConditions([...conditions, defaultConditionRow()]);
  };

  const removeCondition = (index) => {
    setConditions(conditions.filter((_, i) => i !== index));
  };

  const updateCondition = (index, field, value) => {
    const newConditions = [...conditions];
    newConditions[index][field] = value;
    if (field === 'deviceId') { fetchProps(value); newConditions[index].propKey = ''; }
    if (field === 'operator') {
      newConditions[index].operator = value;
      newConditions[index].operatorLabel = automationOperatorLabel(value);
    }
    if (field === 'propKey') {
      const pk = String(value || '').trim();
      newConditions[index].propKey = pk;
      const list = deviceProperties[newConditions[index].deviceId];
      const p = findPropertyMeta(list, pk);
      newConditions[index].propName = p ? p.name : pk;
    }
    setConditions(newConditions);
  };

  const addAction = () => {
    setActions([
      ...actions,
      {
        type: 'email',
        target: '',
        emailSubject: '',
        emailBody: '',
        webhookBody: '',
        targetDeviceId: '',
        commandKey: '',
        payload: '',
        delay: 0,
        scheduleRunAt: 'start',
        toastTitle: '',
        toastMessage: '',
        toastVariant: 'indigo',
      },
    ]);
  };

  const removeAction = (index) => {
    setActions(actions.filter((_, i) => i !== index));
  };

  const updateAction = (index, field, value) => {
    const newActions = [...actions];
    newActions[index][field] = value;
    if (field === 'type' && value === 'toast') {
      if (newActions[index].toastTitle == null) newActions[index].toastTitle = '';
      if (newActions[index].toastMessage == null) newActions[index].toastMessage = '';
      if (!newActions[index].toastVariant) newActions[index].toastVariant = 'indigo';
    }
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

    const ruleMode = ruleBySchedule ? 'schedule' : 'conditions';

    const persistedConditions = ruleBySchedule
      ? []
      : conditions.map((c) => {
          const row = normalizeConditionRow(c);
          row.operatorLabel = automationOperatorLabel(row.operator);
          if (row.deviceId && row.propKey) {
            const p = findPropertyMeta(deviceProperties[row.deviceId], row.propKey);
            if (p?.name) row.propName = p.name;
          }
          return row;
        });

    if (!ruleBySchedule && effectiveAutomationConditions(persistedConditions).length === 0) {
      return alert('Agrega al menos una condición (dispositivo, propiedad y valor).');
    }
    if (ruleBySchedule && (!activeDays || activeDays.length === 0)) {
      return alert('Selecciona al menos un día para la regla por horario.');
    }

    onSave({
      name,
      ruleMode,
      conditions: persistedConditions,
      actions,
      activeDays: ruleBySchedule ? activeDays : [],
      scheduleStart: ruleBySchedule ? scheduleStart : '00:00',
      scheduleEnd: ruleBySchedule ? scheduleEnd : '23:59',
      reactivation,
      allowReactivation,
    });
  };

  const daysLabels = [
    { id: 1, label: 'L' }, { id: 2, label: 'M' }, { id: 3, label: 'X' }, 
    { id: 4, label: 'J' }, { id: 5, label: 'V' }, { id: 6, label: 'S' }, { id: 0, label: 'D' }
  ];

  const actionTypes = [
    { id: 'email', label: 'Enviar email', icon: <Mail size={14} /> },
    { id: 'webhook', label: 'Llamar a un webhook', icon: <Globe size={14} /> },
    { id: 'downlink', label: 'Enviar downlink', icon: <Zap size={14} /> },
    { id: 'toast', label: 'Notificación emergente', icon: <Bell size={14} /> },
  ];

  const toastVariants = [
    { id: 'indigo', label: 'Índigo (elegante)' },
    { id: 'emerald', label: 'Esmeralda (éxito)' },
    { id: 'slate', label: 'Pizarra (neutro)' },
    { id: 'amber', label: 'Ámbar (aviso)' },
    { id: 'rose', label: 'Rosa (alerta suave)' },
  ];

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content rule-modal">
        <header className="modal-header">
          <h2>{isDuplicate ? 'Duplicar regla' : rule ? 'Editar regla' : 'Nueva regla'}</h2>
          <button className="btn-icon" onClick={onClose}><X size={20} /></button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="modal-body scrollable">
            <div className="form-group">
              <label>Nombre</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Introduce un nombre" className={!name ? 'error' : ''} />
              {isDuplicate ? (
                <span className="hint-text">Copia de una regla existente. Ajuste nombre, horario o acciones y pulse Crear copia. No se modifica la original.</span>
              ) : null}
              {!name && <span className="error-text">Introduce un nombre</span>}
            </div>

            <div className="rule-mode-section glass">
              <label className="rule-mode-toggle checkbox-label">
                <input
                  type="checkbox"
                  checked={ruleBySchedule}
                  onChange={(e) => setRuleBySchedule(e.target.checked)}
                />
                <span className="rule-mode-toggle-title">Regla por horario y días</span>
              </label>
              <p className="rule-mode-hint">
                {ruleBySchedule
                  ? 'La regla se activa solo dentro de los días y la franja horaria. No use condiciones IF en este modo.'
                  : 'La regla se evalúa cuando se cumplen las condiciones IF (24 h, todos los días). No aplica ventana horaria.'}
              </p>
            </div>

            {ruleBySchedule ? (
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
                  <div className="schedule-time-field">
                    <span className="schedule-time-label">Inicio</span>
                    <div className="time-input">
                      <Clock size={14} aria-hidden />
                      <input
                        type="time"
                        value={scheduleStart}
                        onChange={(e) => setScheduleStart(e.target.value)}
                        aria-label="Hora de inicio"
                      />
                    </div>
                  </div>
                  <div className="schedule-time-field">
                    <span className="schedule-time-label">Fin</span>
                    <div className="time-input">
                      <Clock size={14} aria-hidden />
                      <input
                        type="time"
                        value={scheduleEnd}
                        onChange={(e) => setScheduleEnd(e.target.value)}
                        aria-label="Hora de fin"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            ) : null}

            {!ruleBySchedule ? (
            <div className="rule-config-section">
              <label className="section-label">Condiciones</label>
              {devicesLoadError ? (
                <p className="automation-modal-devices-error" role="alert">
                  {devicesLoadError}
                </p>
              ) : null}
              <div className="conditions-container">
                {conditions.map((cond, index) => (
                  <div key={index} className="row-item glass border">
                    <div className="condition-main-row">
                    <span className="row-label">{index === 0 ? 'Si' : 'And'}</span>
                    <div className="row-fields">
                      <select value={cond.deviceId != null ? String(cond.deviceId) : ''} onChange={e => updateCondition(index, 'deviceId', e.target.value)} className="field-device">
                        <option value="">Elegir dispositivo</option>
                        {devices.map((d) => {
                          const id = d.deviceId != null ? String(d.deviceId) : '';
                          if (!id) return null;
                          return (
                            <option key={id} value={id}>
                              {String(d.name || d.sn || id).trim() || id}
                            </option>
                          );
                        })}
                      </select>
                      <select
                        value={cond.propKey != null ? String(cond.propKey) : ''}
                        onChange={(e) => updateCondition(index, 'propKey', e.target.value)}
                        className="field-prop"
                        disabled={!cond.deviceId}
                      >
                        <option value="">Elegir propiedad</option>
                        {(deviceProperties[cond.deviceId] || []).map((p) => {
                          const pk = String(p.propertyKey || p.id || '').trim();
                          if (!pk) return null;
                          return (
                            <option key={pk} value={pk}>
                              {p.name || pk}
                            </option>
                          );
                        })}
                        {cond.propKey &&
                        !(deviceProperties[cond.deviceId] || []).some(
                          (p) => String(p.propertyKey || p.id || '').trim() === String(cond.propKey).trim()
                        ) ? (
                          <option value={String(cond.propKey)}>
                            {cond.propName || cond.propKey} (guardado)
                          </option>
                        ) : null}
                      </select>
                      <span className="joiner">es</span>
                      <select
                        value={
                          CONDITION_OPERATORS.some((o) => o.id === cond.operator) ? cond.operator : '=='
                        }
                        onChange={(e) => updateCondition(index, 'operator', e.target.value)}
                        className="field-operator"
                        aria-label="Operador de comparación"
                      >
                        {CONDITION_OPERATORS.map((op) => (
                          <option key={op.id} value={op.id}>
                            {op.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={cond.value}
                        onChange={e => updateCondition(index, 'value', e.target.value)}
                        placeholder="Valor"
                        className="field-value"
                      />
                      <label className="condition-hold-inline">
                        <span className="condition-hold-label">Tiempo</span>
                        <select
                          value={cond.holdOp === 'lt' ? 'lt' : cond.holdOp === 'gt' ? 'gt' : ''}
                          onChange={(e) => updateCondition(index, 'holdOp', e.target.value)}
                          className="field-hold-op"
                          aria-label="Operador de tiempo"
                        >
                          {HOLD_OPERATORS.map((op) => (
                            <option key={op.id || 'none'} value={op.id}>
                              {op.label}
                            </option>
                          ))}
                        </select>
                        <input
                          id={`automation-hold-${index}`}
                          type="text"
                          value={cond.holdTime != null ? String(cond.holdTime) : ''}
                          onChange={(e) => updateCondition(index, 'holdTime', e.target.value)}
                          placeholder="10m"
                          className="field-hold"
                          disabled={!cond.holdOp}
                          aria-label="Duración del tiempo"
                        />
                      </label>
                    </div>
                    <button type="button" className="btn-icon delete" onClick={() => removeCondition(index)}><Trash2 size={16} /></button>
                    </div>
                    {cond.deviceId && cond.propKey ? (
                      <label className="automation-condition-widget-value">
                        <input
                          type="checkbox"
                          checked={Boolean(cond.useWidgetValue)}
                          onChange={(e) => updateCondition(index, 'useWidgetValue', e.target.checked)}
                        />
                        <span>
                          Usar valor del widget (fórmula, escala invertida, etc.). Si no está marcado, se usa la
                          lectura real de la base de datos.
                        </span>
                      </label>
                    ) : null}
                  </div>
                ))}
                <button type="button" className="add-row-btn" onClick={addCondition}>
                  <Plus size={16} /> Agregar condición
                </button>
                <p className="hint-text">
                  Ejemplo: PIR <strong>igual a</strong> ocupado (o el valor que envíe al detectar personas) y{' '}
                  <strong>tiempo mayor a</strong> <code>10m</code>: THEN se ejecuta si sigue detectando personas más
                  de 10 minutos. <strong>Tiempo menor a</strong> dispara al dejar de detectarlas si duró menos de ese
                  rato. <code>(sin tiempo)</code> = al instante. Duración: <code>10m</code>, <code>60s</code>,{' '}
                  <code>0.30</code>.
                </p>
              </div>
            </div>
            ) : null}

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
                              {devices.map((d) => {
                                const id = d.deviceId != null ? String(d.deviceId) : '';
                                if (!id) return null;
                                return (
                                  <option key={id} value={id}>
                                    {String(d.name || d.sn || id).trim() || id}
                                  </option>
                                );
                              })}
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
                        ) : action.type === 'toast' ? (
                          <span className="field-toast-inline-hint">
                            Panel grande en la app. Para avisos del sistema con otra pestaña al frente, active permisos en{' '}
                            <strong>Ajustes</strong> → «Avisos con otra pestaña…».
                          </span>
                        ) : (
                          <input
                            type="text"
                            value={action.target}
                            onChange={e => updateAction(index, 'target', e.target.value)}
                            placeholder={
                              action.type === 'email'
                                ? 'Correo del destinatario'
                                : action.type === 'webhook'
                                  ? 'https://pushmore.io/webhook/<TOKEN> (no pegue enlaces gist.github.com)'
                                  : 'Destino'
                            }
                            className="field-target"
                          />
                        )}
                      </div>
                      <button type="button" className="btn-icon delete" onClick={() => removeAction(index)}><Trash2 size={16} /></button>
                    </div>
                    {action.type === 'webhook' && isLikelyGithubDocUrlInsteadOfWebhook(action.target) && (
                      <p className="webhook-url-warning">
                        Esta URL apunta a GitHub (p. ej. un gist), no a PushMore. Use la URL que da el bot, del tipo{' '}
                        <code>https://pushmore.io/webhook/…</code>. Si el relay devuelve 502 con HTML de GitHub, la URL
                        guardada es incorrecta.
                      </p>
                    )}
                    {action.type === 'email' && (
                      <div className="action-email-extra glass border">
                        <input
                          type="text"
                          className="field-email-subject"
                          value={action.emailSubject || ''}
                          onChange={(e) => updateAction(index, 'emailSubject', e.target.value)}
                          placeholder="Asunto (opcional; por defecto: Alerta + nombre de la regla)"
                        />
                        <textarea
                          className="field-email-body"
                          rows={4}
                          value={action.emailBody || ''}
                          onChange={(e) => updateAction(index, 'emailBody', e.target.value)}
                          placeholder="Cuerpo del mensaje (opcional). Si lo deja vacío, se envía un resumen automático con el nombre de la regla, las condiciones y la fecha."
                        />
                      </div>
                    )}
                    {action.type === 'webhook' && (
                      <div className="action-webhook-extra glass border">
                        <textarea
                          className="field-webhook-body"
                          rows={4}
                          value={action.webhookBody || ''}
                          onChange={(e) => updateAction(index, 'webhookBody', e.target.value)}
                          placeholder={
                            'PushMore.io: texto del aviso (message/text). Vacío: resumen automático (nombre de regla, condiciones, fecha).'
                          }
                        />
                      </div>
                    )}
                    {action.type === 'toast' && (
                      <div className="action-toast-extra glass border">
                        <input
                          type="text"
                          className="field-email-subject"
                          value={action.toastTitle || ''}
                          onChange={(e) => updateAction(index, 'toastTitle', e.target.value)}
                          placeholder="Título (si está vacío: “Alerta:” + nombre de la regla)"
                        />
                        <textarea
                          className="field-email-body"
                          rows={3}
                          value={action.toastMessage || ''}
                          onChange={(e) => updateAction(index, 'toastMessage', e.target.value)}
                          placeholder="Mensaje secundario (opcional), como en una notificación de escritorio"
                        />
                        <label className="toast-variant-label">
                          <span>Estilo de color</span>
                          <select
                            className="field-toast-variant"
                            value={action.toastVariant || 'indigo'}
                            onChange={(e) => updateAction(index, 'toastVariant', e.target.value)}
                          >
                            {toastVariants.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                    <div className="action-delay-row">
                      <div className="delay-input-group">
                        <Clock size={12} />
                        <span>Delay:</span>
                        <input type="number" value={action.delay} onChange={e => updateAction(index, 'delay', e.target.value)} min="0" />
                        <span className="unit">segundos</span>
                      </div>
                      {ruleBySchedule && (
                        <label className="schedule-run-at-label">
                          <span>Momento (solo ventana horaria)</span>
                          <select
                            className="field-schedule-run-at"
                            value={action.scheduleRunAt === 'end' ? 'end' : 'start'}
                            onChange={(e) => updateAction(index, 'scheduleRunAt', e.target.value)}
                          >
                            <option value="start">Al entrar en el horario</option>
                            <option value="end">Al salir del horario</option>
                          </select>
                        </label>
                      )}
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
            <button type="submit" className="btn btn-primary">
              {isDuplicate ? 'Crear copia' : rule ? 'Guardar cambios' : 'Crear regla'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default AutomationModal;
