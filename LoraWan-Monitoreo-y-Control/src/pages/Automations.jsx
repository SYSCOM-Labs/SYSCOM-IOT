import React, { useState, useEffect } from 'react';
import { Zap, Plus, Trash2, Edit2, AlertCircle, Calendar, Clock, Bell, Globe, Mail } from 'lucide-react';
import AutomationModal from '../components/modals/AutomationModal';
import { useLanguage } from '../context/LanguageContext';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import { fetchAutomationRules, saveAutomationRules } from '../services/api';
import { invalidateAutomationRulesCache } from '../services/automationService';
import './Automations.css';

function effectiveAutomationConditions(conds) {
  return (conds || []).filter(
    (c) =>
      c &&
      c.deviceId != null &&
      String(c.deviceId).trim() &&
      c.propKey != null &&
      String(c.propKey).trim()
  );
}

const AutomationsPage = () => {
  const { t } = useLanguage();
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await fetchAutomationRules();
        if (cancelled) return;
        if (remote.length) {
          setRules(remote);
        } else {
          const local = localStorage.getItem('iot_automations');
          if (local) {
            const parsed = JSON.parse(local);
            setRules(parsed);
            await saveAutomationRules(parsed);
            localStorage.removeItem('iot_automations');
            invalidateAutomationRulesCache();
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(String(e?.message || e));
          const local = localStorage.getItem('iot_automations');
          if (local) setRules(JSON.parse(local));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistRules = async (next) => {
    await saveAutomationRules(next);
    invalidateAutomationRulesCache();
  };

  const handleSaveRule = async (ruleData) => {
    let next;
    if (editingRule) {
      next = rules.map((r) =>
        String(r.id) === String(editingRule.id) ? { ...r, ...ruleData, id: r.id } : r
      );
    } else {
      next = [...rules, { ...ruleData, id: Date.now(), active: true }];
    }
    setRules(next);
    try {
      await persistRules(next);
    } catch (e) {
      console.error(e);
      return;
    }
    setIsModalOpen(false);
    setEditingRule(null);
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('common.confirm') + '?')) return;
    const next = rules.filter((r) => String(r.id) !== String(id));
    setRules(next);
    try {
      await persistRules(next);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleActive = async (id) => {
    const next = rules.map((r) =>
      String(r.id) === String(id) ? { ...r, active: !(r.active !== false) } : r
    );
    setRules(next);
    try {
      await persistRules(next);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="automations-page device-list-page device-list-page--premium premium-shell">
      {loadError && (
        <p className="subtitle" style={{ color: 'var(--danger, #c0392b)', marginBottom: '1rem' }}>
          {loadError}
        </p>
      )}
      {loading && <p className="subtitle">Cargando reglas…</p>}
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <Zap size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">{t('automations.title')}</span>
          </h1>
        </div>
        <button
          type="button"
          className="btn btn-primary device-create-top-btn"
          onClick={() => {
            setEditingRule(null);
            setIsModalOpen(true);
          }}
        >
          <Plus size={18} /> {t('automations.add_rule')}
        </button>
      </div>

      <div className="rules-grid">
        {rules.map((rule) => {
          const scheduleOnlyCard = effectiveAutomationConditions(rule.conditions).length === 0;
          return (
          <div
            key={String(rule.id)}
            className={`rule-card glass card ${rule.active !== false ? '' : 'inactive'}`}
            aria-label={rule.name ? `Regla: ${rule.name}` : 'Regla de automatización'}
          >
            <div className="rule-header">
              <div className="rule-title">
                <div className={`status-dot ${rule.active !== false ? 'online' : 'offline'}`}></div>
                <h3 className="rule-card-title" title={rule.name?.trim() || undefined}>
                  {rule.name?.trim() || `Regla ${String(rule.id).slice(0, 8)}`}
                </h3>
              </div>
              <div className="rule-actions">
                <button className="btn-icon" onClick={() => { setEditingRule(rule); setIsModalOpen(true); }}>
                  <Edit2 size={16} />
                </button>
                <button className="btn-icon delete" onClick={() => handleDelete(String(rule.id))}>
                  <Trash2 size={16} />
                </button>
                <label className="switch">
                  <input type="checkbox" checked={rule.active !== false} onChange={() => toggleActive(String(rule.id))} />
                  <span className="slider round"></span>
                </label>
              </div>
            </div>
            
            <div className="rule-content">
              <div className="rule-info-row">
                <div className="info-item">
                  <Calendar size={12} />
                  <span>{(rule.activeDays?.length === 7) ? 'Todos los días' : (rule.activeDays || []).map(d => ['D','L','M','X','J','V','S'][d]).join(', ') || 'Sin días'}</span>
                </div>
                <div className="info-item">
                  <Clock size={12} />
                  <span>{(rule.scheduleStart || '00:00')} - {(rule.scheduleEnd || '23:59')}</span>
                </div>
              </div>

              <div className="rule-section">
                <span className="badge-if">IF</span>
                <div className="conditions-list">
                  {(rule.conditions || []).filter(
                    (c) =>
                      c &&
                      c.deviceId != null &&
                      String(c.deviceId).trim() &&
                      c.propKey != null &&
                      String(c.propKey).trim()
                  ).length === 0 ? (
                    <div className="condition-summary condition-summary--schedule-only">
                      Solo ventana horaria (sin condiciones IF)
                    </div>
                  ) : (
                    (rule.conditions || [])
                      .filter(
                        (c) =>
                          c &&
                          c.deviceId != null &&
                          String(c.deviceId).trim() &&
                          c.propKey != null &&
                          String(c.propKey).trim()
                      )
                      .map((c, i) => (
                        <div key={i} className="condition-summary">
                          {i > 0 && <span className="join">AND</span>}
                          <span className="prop">{c.propName || c.propKey || 'Prop'}</span>{' '}
                          {c.operatorLabel || c.operator || '=='}{' '}
                          <span className="val">{c.value ?? '0'}</span>
                        </div>
                      ))
                  )}
                </div>
              </div>

              <div className="rule-section">
                <span className="badge-then">THEN</span>
                <div className="actions-list">
                  {(rule.actions || []).map((a, i) => {
                    const type = a.type || '';
                    const isToast = type === 'toast';
                    const isWebhook = type === 'webhook';
                    const isEmail = type === 'email';
                    const endPhase = scheduleOnlyCard && String(a.scheduleRunAt || '').toLowerCase() === 'end';
                    const toastBit = (() => {
                      const t = String(a.toastTitle || '').trim();
                      if (t) return t;
                      const m = String(a.toastMessage || '').trim();
                      if (!m) return '—';
                      return m.length > 44 ? `${m.slice(0, 44)}…` : m;
                    })();
                    const line = isToast
                      ? `${endPhase ? '[Al cerrar horario] ' : ''}Notificación: ${toastBit}`
                      : isWebhook
                        ? `${endPhase ? '[Al cerrar horario] ' : ''}webhook`
                        : `${endPhase ? '[Al cerrar horario] ' : ''}${a.typeLabel || type || 'Action'}: ${a.target || a.commandKey || 'Default'}`;
                    const ActionIcon = isToast ? Bell : isWebhook ? Globe : isEmail ? Mail : Zap;
                    return (
                    <div key={i} className="action-summary-container">
                      <div className="action-summary">
                        <ActionIcon size={12} className="action-summary-icon" aria-hidden />
                        <span className="action-summary-text" title={isWebhook ? String(a.target || '').trim() || undefined : line}>
                          {line}
                        </span>
                      </div>
                      {(a.delay > 0) && (
                        <div className="delay-badge">
                          <Clock size={10} /> {a.delay}s delay
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          );
        })}

        {rules.length === 0 && (
          <div className="empty-rules glass card">
            <AlertCircle size={48} />
            <h2>{t('automations.no_rules')}</h2>
            <p>{t('automations.subtitle')}</p>
            <button className="btn btn-accent" onClick={() => { setEditingRule(null); setIsModalOpen(true); }}>
              {t('automations.add_rule')}
            </button>
          </div>
        )}
      </div>

      {isModalOpen && (
        <AutomationModal 
          isOpen={isModalOpen}
          onClose={() => {
            setIsModalOpen(false);
            setEditingRule(null);
          }}
          onSave={handleSaveRule}
          rule={editingRule}
        />
      )}
    </div>
  );
};

export default AutomationsPage;
