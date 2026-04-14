import React, { useState, useEffect } from 'react';
import { Zap, Plus, Trash2, Edit2, AlertCircle, Calendar, Clock } from 'lucide-react';
import AutomationModal from '../components/modals/AutomationModal';
import { useLanguage } from '../context/LanguageContext';
import { fetchAutomationRules, saveAutomationRules } from '../services/api';
import { invalidateAutomationRulesCache } from '../services/automationService';
import './Automations.css';

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
        String(r.id) === String(editingRule.id) ? { ...ruleData, id: r.id } : r
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
      String(r.id) === String(id) ? { ...r, active: !r.active } : r
    );
    setRules(next);
    try {
      await persistRules(next);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="automations-page">
      {loadError && (
        <p className="subtitle" style={{ color: 'var(--danger, #c0392b)', marginBottom: '1rem' }}>
          {loadError}
        </p>
      )}
      {loading && <p className="subtitle">Cargando reglas…</p>}
      <div className="page-header">
        <div>
          <h1>{t('automations.title')}</h1>
          <p className="subtitle">{t('automations.subtitle') || 'Configura reglas inteligentes.'}</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditingRule(null); setIsModalOpen(true); }}>
          <Plus size={18} /> {t('automations.add_rule')}
        </button>
      </div>

      <div className="rules-grid">
        {rules.map((rule) => (
          <div key={String(rule.id)} className={`rule-card glass card ${rule.active ? '' : 'inactive'}`}>
            <div className="rule-header">
              <div className="rule-title">
                <div className={`status-dot ${rule.active ? 'online' : 'offline'}`}></div>
                <h3>{rule.name}</h3>
              </div>
              <div className="rule-actions">
                <button className="btn-icon btn-icon--edit" onClick={() => { setEditingRule(rule); setIsModalOpen(true); }}>
                  <Edit2 size={16} />
                </button>
                <button className="btn-icon btn-icon--danger" onClick={() => handleDelete(String(rule.id))}>
                  <Trash2 size={16} />
                </button>
                <label className="switch">
                  <input type="checkbox" checked={rule.active} onChange={() => toggleActive(String(rule.id))} />
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
                  {(rule.conditions || []).map((c, i) => (
                    <div key={i} className="condition-summary">
                      {i > 0 && <span className="join">AND</span>}
                      <span className="prop">{c.propName || 'Prop'}</span> {c.operatorLabel || c.operator || '=='} <span className="val">{c.value || '0'}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rule-section">
                <span className="badge-then">THEN</span>
                <div className="actions-list">
                  {(rule.actions || []).map((a, i) => (
                    <div key={i} className="action-summary-container">
                      <div className="action-summary">
                        <Zap size={12} /> {a.typeLabel || a.type || 'Action'}: {a.target || a.commandKey || 'Default'}
                      </div>
                      {(a.delay > 0) && (
                        <div className="delay-badge">
                          <Clock size={10} /> {a.delay}s delay
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}

        {rules.length === 0 && (
          <div className="empty-rules glass card">
            <AlertCircle size={48} />
            <h2>{t('automations.no_rules')}</h2>
            <p>{t('automations.subtitle')}</p>
            <button className="btn btn-accent" onClick={() => setIsModalOpen(true)}>
              {t('automations.add_rule')}
            </button>
          </div>
        )}
      </div>

      {isModalOpen && (
        <AutomationModal 
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSave={handleSaveRule}
          rule={editingRule}
        />
      )}
    </div>
  );
};

export default AutomationsPage;
