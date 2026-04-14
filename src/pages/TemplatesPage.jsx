import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useNavigate, useLocation, matchPath } from 'react-router-dom';
import './DeviceList.css';
import { Plus, Pencil, Trash2, X, Layers } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  getDeviceTemplates,
  saveDeviceTemplate,
  deleteDeviceTemplate,
  getDefaultTemplateId,
  setDefaultTemplateId,
} from '../services/deviceTemplates';
import './TemplatesPage.css';
import { ROUTES } from '../constants/routes';

const emptyForm = () => ({
  id: null,
  modelo: '',
  marca: '',
  channel: '1',
  decoderScript: '',
  downlinks: [{ name: '', hex: '' }],
});

function mapTemplateToForm(t) {
  return {
    id: t.id,
    modelo: t.modelo || '',
    marca: t.marca || '',
    channel: t.channel != null && String(t.channel).trim() !== '' ? String(t.channel) : '1',
    decoderScript: t.decoderScript || '',
    downlinks:
      t.downlinks?.length > 0
        ? t.downlinks.map((d) => ({ name: d.name || '', hex: d.hex || '' }))
        : [{ name: '', hex: '' }],
  };
}

function buildInitialFormForPath(pathname) {
  if (pathname === ROUTES.plantillaNueva) return emptyForm();
  const m = matchPath({ path: '/plantillas/:templateId/editar', end: true }, pathname);
  if (m?.params?.templateId) {
    const t = getDeviceTemplates().find((x) => x.id === m.params.templateId);
    if (t) return mapTemplateToForm(t);
  }
  return emptyForm();
}

/** Estado del formulario local; `key={pathname}` en el padre reinicia al cambiar la ruta. */
function TemplatesEditorPanel({ initialForm, onClose, onSave }) {
  const [form, setForm] = useState(initialForm);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.modelo.trim() || !form.marca.trim()) {
      alert('Modelo y marca son obligatorios.');
      return;
    }
    onSave(form);
  };

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div className="modal-content glass templates-editor-modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{form.id ? 'Editar plantilla' : 'Nueva plantilla'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="templates-editor-form">
          <div className="device-create-grid">
            <label className="device-modal-field templates-editor-label">
              <span className="device-modal-label-text">
                Modelo <span className="req" aria-hidden="true">*</span>
              </span>
              <input
                className="glass device-modal-input device-modal-input--lg"
                value={form.modelo}
                onChange={(e) => setForm({ ...form, modelo: e.target.value })}
                placeholder="Ej. UC512-DI"
                required
              />
            </label>
            <label className="device-modal-field templates-editor-label">
              <span className="device-modal-label-text">
                Marca <span className="req" aria-hidden="true">*</span>
              </span>
              <input
                className="glass device-modal-input device-modal-input--lg"
                value={form.marca}
                onChange={(e) => setForm({ ...form, marca: e.target.value })}
                placeholder="Ej. Milesight"
                required
              />
            </label>
            <label className="device-modal-field templates-editor-label device-create-span2">
              <span className="device-modal-label-text">Canal</span>
              <input
                className="glass device-modal-input device-modal-input--lg"
                type="text"
                inputMode="numeric"
                value={form.channel}
                onChange={(e) => setForm({ ...form, channel: e.target.value })}
                placeholder="1"
                autoComplete="off"
              />
            </label>
            <label className="device-modal-field templates-editor-label device-create-span2">
              <span className="device-modal-label-text">Payload decoder</span>
              <textarea
                className="glass device-modal-textarea templates-decoder-textarea"
                rows={12}
                value={form.decoderScript}
                onChange={(e) => setForm({ ...form, decoderScript: e.target.value })}
                placeholder="// function Decoder(bytes, port) { return { data: { ... } }; }"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="templates-downlinks-block">
            <div className="templates-downlinks-head">
              <span className="device-modal-label-text">Downlinks (múltiples)</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setForm({ ...form, downlinks: [...form.downlinks, { name: '', hex: '' }] })}
              >
                <Plus size={16} /> Añadir comando
              </button>
            </div>
            {form.downlinks.map((row, idx) => (
              <div key={idx} className="templates-downlink-row glass">
                <input
                  className="glass device-modal-input device-modal-input--lg templates-downlink-input"
                  placeholder="Nombre (ej. Abrir válvula)"
                  value={row.name}
                  onChange={(e) => {
                    const next = [...form.downlinks];
                    next[idx] = { ...next[idx], name: e.target.value };
                    setForm({ ...form, downlinks: next });
                  }}
                />
                <input
                  className="glass mono device-modal-input device-modal-input--lg templates-downlink-input"
                  placeholder="Hex (ej. ff01a0)"
                  value={row.hex}
                  onChange={(e) => {
                    const next = [...form.downlinks];
                    next[idx] = { ...next[idx], hex: e.target.value };
                    setForm({ ...form, downlinks: next });
                  }}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon--danger"
                  aria-label="Quitar fila"
                  disabled={form.downlinks.length <= 1}
                  onClick={() =>
                    setForm({
                      ...form,
                      downlinks: form.downlinks.filter((_, i) => i !== idx),
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary">
              Guardar plantilla
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const TemplatesPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isSuperAdmin } = useAuth();
  const { t } = useLanguage();
  const [templates, setTemplates] = useState(() => getDeviceTemplates());
  const [defaultTemplateId, setDefaultTemplateIdState] = useState(() => getDefaultTemplateId());

  const refresh = useCallback(() => {
    setTemplates(getDeviceTemplates());
    setDefaultTemplateIdState(getDefaultTemplateId());
  }, []);

  const closeEditor = useCallback(() => {
    navigate(ROUTES.plantillas);
  }, [navigate]);

  const showEditor = useMemo(() => {
    const p = location.pathname;
    if (p === ROUTES.plantillaNueva) return true;
    return Boolean(matchPath({ path: '/plantillas/:templateId/editar', end: true }, p));
  }, [location.pathname]);

  const editorInitialForm = useMemo(
    () => buildInitialFormForPath(location.pathname),
    [location.pathname]
  );

  useEffect(() => {
    const m = matchPath({ path: '/plantillas/:templateId/editar', end: true }, location.pathname);
    if (m?.params?.templateId) {
      const exists = getDeviceTemplates().some((x) => x.id === m.params.templateId);
      if (!exists) navigate(ROUTES.plantillas, { replace: true });
    }
  }, [location.pathname, navigate]);

  const openNew = () => {
    navigate(ROUTES.plantillaNueva);
  };

  const openEdit = (t) => {
    navigate(ROUTES.plantillaEditar(t.id));
  };

  const persistTemplate = useCallback(
    (form) => {
      saveDeviceTemplate({
        id: form.id,
        modelo: form.modelo,
        marca: form.marca,
        channel: form.channel,
        decoderScript: form.decoderScript,
        downlinks: form.downlinks,
      });
      refresh();
      navigate(ROUTES.plantillas);
    },
    [navigate, refresh]
  );

  const handleDelete = (t) => {
    if (!window.confirm(`¿Eliminar la plantilla "${t.modelo}" (${t.marca})?`)) return;
    deleteDeviceTemplate(t.id);
    refresh();
  };

  const sorted = useMemo(
    () =>
      [...templates].sort((a, b) =>
        `${a.marca} ${a.modelo}`.localeCompare(`${b.marca} ${b.modelo}`, 'es')
      ),
    [templates]
  );

  if (!isSuperAdmin) {
    return (
      <div className="templates-page templates-page--denied">
        <p>Solo el super administrador puede gestionar plantillas.</p>
      </div>
    );
  }

  return (
    <div className="templates-page">
      <div className="templates-page-header">
        <div>
          <h1 className="templates-page-title">
            <Layers size={28} className="templates-page-title-icon" aria-hidden />
            Plantillas de dispositivo
          </h1>
          <p className="templates-page-subtitle">
            Modelo, decoder y downlinks por plantilla; la <strong>predeterminada</strong> se hereda al crear dispositivos (o elige otra en el alta).
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openNew}>
          <Plus size={18} /> Nueva plantilla
        </button>
      </div>

      <div className="templates-table-wrap glass card">
        {sorted.length === 0 ? (
          <div className="templates-empty">No hay plantillas. Crea la primera con el botón superior.</div>
        ) : (
          <table className="templates-table">
            <thead>
              <tr>
                <th>Marca</th>
                <th>Modelo</th>
                <th>Canal</th>
                <th>Decoder</th>
                <th>Downlinks</th>
                <th>Altas</th>
                <th className="templates-actions-col">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id}>
                  <td>{t.marca || '—'}</td>
                  <td>
                    <strong>{t.modelo || '—'}</strong>
                  </td>
                  <td>{t.channel || '—'}</td>
                  <td className="templates-cell-mono">
                    {t.decoderScript?.trim() ? `${t.decoderScript.trim().slice(0, 48)}…` : '—'}
                  </td>
                  <td>{t.downlinks?.length || 0}</td>
                  <td className="templates-default-col">
                    {defaultTemplateId === t.id ? (
                      <div className="templates-default-wrap">
                        <span className="templates-default-badge">Predeterminada</span>
                        <button
                          type="button"
                          className="btn btn-secondary templates-default-btn"
                          onClick={() => {
                            setDefaultTemplateId(null);
                            refresh();
                          }}
                        >
                          Quitar
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary templates-default-btn"
                        title="Cada nuevo dispositivo heredará decoder y downlinks de esta plantilla"
                        onClick={() => {
                          setDefaultTemplateId(t.id);
                          refresh();
                        }}
                      >
                        Heredar en altas
                      </button>
                    )}
                  </td>
                  <td className="templates-actions-col">
                    <button type="button" className="btn-icon btn-icon--edit" title="Editar" onClick={() => openEdit(t)}>
                      <Pencil size={16} />
                    </button>
                    <button type="button" className="btn-icon btn-icon--danger" title="Eliminar" onClick={() => handleDelete(t)}>
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showEditor && (
        <TemplatesEditorPanel
          key={location.pathname}
          initialForm={editorInitialForm}
          onClose={closeEditor}
          onSave={persistTemplate}
        />
      )}
    </div>
  );
};

export default TemplatesPage;
