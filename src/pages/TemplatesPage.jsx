import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation, matchPath } from 'react-router-dom';
import './DeviceList.css';
import { Plus, Pencil, Trash2, X, Layers, Wand2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  getDeviceTemplates,
  saveDeviceTemplate,
  deleteDeviceTemplate,
  getDefaultTemplateId,
  setDefaultTemplateId,
  mergeDeviceTemplatesFromImport,
  buildDeviceTemplatesExportDocument,
  normalizeTemplateLorawanClass,
} from '../services/deviceTemplates';
import { adaptDecoderScriptForSyscom } from '../utils/adaptDecoderScript';
import './TemplatesPage.css';
import { ROUTES } from '../constants/routes';

const emptyForm = () => ({
  id: null,
  modelo: '',
  marca: '',
  channel: '1',
  lorawanClass: 'A',
  decoderScript: '',
  downlinks: [{ name: '', hex: '' }],
  lnsDevAddr: '',
  lnsNwkSKey: '',
  lnsAppSKey: '',
});

function mapTemplateToForm(t) {
  return {
    id: t.id,
    modelo: t.modelo || '',
    marca: t.marca || '',
    channel: t.channel != null && String(t.channel).trim() !== '' ? String(t.channel) : '1',
    lorawanClass: normalizeTemplateLorawanClass(t.lorawanClass),
    decoderScript: t.decoderScript || '',
    downlinks:
      t.downlinks?.length > 0
        ? t.downlinks.map((d) => ({ name: d.name || '', hex: d.hex || '' }))
        : [{ name: '', hex: '' }],
    lnsDevAddr: t.lnsDevAddr || '',
    lnsNwkSKey: t.lnsNwkSKey || '',
    lnsAppSKey: t.lnsAppSKey || '',
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

function TemplatesEditorPanel({ initialForm, onClose, onSave }) {
  const [form, setForm] = useState(initialForm);
  const [baselineSnapshot, setBaselineSnapshot] = useState(() => initialForm.decoderScript || '');
  const [approvedDecoder, setApprovedDecoder] = useState(() => initialForm.decoderScript || '');

  useEffect(() => {
    const d = initialForm.decoderScript || '';
    setForm(initialForm);
    setBaselineSnapshot(d);
    setApprovedDecoder(d);
  }, [initialForm]);

  const decoderSaveBlocked =
    form.decoderScript.trim() !== '' && form.decoderScript !== approvedDecoder;

  const handleAdjustDecoder = () => {
    const { script, messages } = adaptDecoderScriptForSyscom(form.decoderScript);
    setForm((f) => ({ ...f, decoderScript: script }));
    setApprovedDecoder(script);
    window.alert(messages.length ? messages.join('\n') : 'Sin cambios.');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.modelo.trim() || !form.marca.trim()) {
      window.alert('Modelo y marca son obligatorios.');
      return;
    }
    if (decoderSaveBlocked) {
      window.alert(
        'El decoder ha cambiado respecto al último estado aprobado. Pulse «Ajustar» para normalizarlo a Syscom o restaure el texto original antes de guardar.'
      );
      return;
    }
    onSave(form);
  };

  return (
    <div className="modal-overlay" role="presentation">
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
              <span className="device-modal-label-text">Canal plantilla (FPort aplicación / downlink)</span>
              <input
                className="glass device-modal-input device-modal-input--lg"
                type="text"
                inputMode="numeric"
                value={form.channel}
                onChange={(e) => setForm({ ...form, channel: e.target.value })}
                placeholder="85 (Milesight típ.) o 1"
                autoComplete="off"
              />
              <p className="templates-fport-disclaimer">
                No es la frecuencia RF del gateway; la banda LoRaWAN (902–928 MHz) se elige al registrar el gateway.
              </p>
            </label>
            <label className="device-modal-field templates-editor-label">
              <span className="device-modal-label-text">Clase LoRaWAN (LNS)</span>
              <select
                className="glass device-modal-input device-modal-input--lg"
                value={form.lorawanClass}
                onChange={(e) => setForm({ ...form, lorawanClass: e.target.value })}
                aria-label="Clase de dispositivo para downlinks y sesión LNS"
              >
                <option value="A">A — ventanas RX1/RX2 tras uplink</option>
                <option value="B">B — ping slots / beacon</option>
                <option value="C">C — recepción casi continua (imme)</option>
              </select>
            </label>
            <div className="device-modal-field templates-editor-label device-create-span2">
              <div className="templates-decoder-label-row">
                <span className="device-modal-label-text">Payload decoder</span>
                <button
                  type="button"
                  className="templates-decoder-adjust-btn"
                  onClick={handleAdjustDecoder}
                  title="Normalizar codec pegado (Milesight / ChirpStack) al contrato Syscom"
                >
                  <Wand2 size={16} aria-hidden />
                  Ajustar
                </button>
              </div>
              <textarea
                className="glass device-modal-textarea templates-decoder-textarea"
                rows={12}
                value={form.decoderScript}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, decoderScript: v });
                  if (v === baselineSnapshot) {
                    setApprovedDecoder(baselineSnapshot);
                  }
                }}
                placeholder="// function decodeUplink(input) { return { data: { ... } }; }"
                spellCheck={false}
              />
            </div>
            <label className="device-modal-field templates-editor-label device-create-span2">
              <span className="device-modal-label-text">LNS DevAddr (hex, opcional)</span>
              <input
                className="glass device-modal-input device-modal-input--lg mono"
                value={form.lnsDevAddr}
                onChange={(e) => setForm({ ...form, lnsDevAddr: e.target.value })}
                placeholder="8 hex (4 B) si usa triple LNS en plantilla"
                spellCheck={false}
              />
            </label>
            <label className="device-modal-field templates-editor-label">
              <span className="device-modal-label-text">LNS NwkSKey (hex, opcional)</span>
              <input
                className="glass device-modal-input device-modal-input--lg mono"
                value={form.lnsNwkSKey}
                onChange={(e) => setForm({ ...form, lnsNwkSKey: e.target.value })}
                placeholder="32 hex"
                spellCheck={false}
              />
            </label>
            <label className="device-modal-field templates-editor-label">
              <span className="device-modal-label-text">LNS AppSKey (hex, opcional)</span>
              <input
                className="glass device-modal-input device-modal-input--lg mono"
                value={form.lnsAppSKey}
                onChange={(e) => setForm({ ...form, lnsAppSKey: e.target.value })}
                placeholder="32 hex"
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
            <button
              type="submit"
              className="btn btn-primary"
              disabled={decoderSaveBlocked}
              title={
                decoderSaveBlocked
                  ? 'Pulse «Ajustar» para aprobar el decoder Syscom, o deje el campo vacío / restaure el snapshot inicial.'
                  : undefined
              }
            >
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
  const importInputRef = useRef(null);

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

  const editorInitialForm = useMemo(() => buildInitialFormForPath(location.pathname), [location.pathname]);

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

  const openEdit = (tpl) => {
    navigate(ROUTES.plantillaEditar(tpl.id));
  };

  const persistTemplate = useCallback(
    (form) => {
      saveDeviceTemplate({
        id: form.id,
        modelo: form.modelo,
        marca: form.marca,
        channel: form.channel,
        lorawanClass: form.lorawanClass,
        decoderScript: form.decoderScript,
        downlinks: form.downlinks,
        lnsDevAddr: form.lnsDevAddr,
        lnsNwkSKey: form.lnsNwkSKey,
        lnsAppSKey: form.lnsAppSKey,
      });
      refresh();
      navigate(ROUTES.plantillas);
    },
    [navigate, refresh]
  );

  const handleDelete = (tpl) => {
    if (!window.confirm(`¿Eliminar la plantilla "${tpl.modelo}" (${tpl.marca})?`)) return;
    deleteDeviceTemplate(tpl.id);
    refresh();
  };

  const handleImportFile = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const r = mergeDeviceTemplatesFromImport(parsed);
        refresh();
        const parts = [
          `Añadidas: ${r.added}`,
          `Reemplazadas: ${r.replaced}`,
          `Omitidas: ${r.skipped}`,
        ];
        if (r.warnings?.length) parts.push('', ...r.warnings);
        window.alert(parts.join('\n'));
      } catch (err) {
        window.alert(`Error al importar: ${err?.message || String(err)}`);
      }
    },
    [refresh]
  );

  const handleExport = useCallback(() => {
    const doc = buildDeviceTemplatesExportDocument();
    const day = new Date().toISOString().slice(0, 10);
    const name = `syscom-plantillas-dispositivo-${day}.json`;
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

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
            Modelo, clase LoRaWAN (A/B/C), decoder y downlinks por plantilla; la <strong>predeterminada</strong> se hereda al crear dispositivos (o elige otra en el alta).
            Use <strong>Importar</strong>/<strong>Exportar</strong> para copias JSON (formato Syscom).
          </p>
        </div>
        <div className="templates-page-header-actions">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="templates-import-input"
            aria-label="Importar plantillas JSON"
            onChange={handleImportFile}
          />
          <button type="button" className="btn btn-secondary" onClick={() => importInputRef.current?.click()}>
            Importar
          </button>
          <button type="button" className="btn btn-secondary" onClick={handleExport}>
            Exportar
          </button>
          <button type="button" className="btn btn-primary" onClick={openNew}>
            <Plus size={18} /> Nueva plantilla
          </button>
        </div>
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
                <th>Canal plantilla (FPort)</th>
                <th>Clase</th>
                <th>Decoder</th>
                <th>Downlinks</th>
                <th>Altas</th>
                <th className="templates-actions-col">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((tpl) => (
                <tr key={tpl.id}>
                  <td>{tpl.marca || '—'}</td>
                  <td>
                    <strong>{tpl.modelo || '—'}</strong>
                  </td>
                  <td>{tpl.channel || '—'}</td>
                  <td>{normalizeTemplateLorawanClass(tpl.lorawanClass)}</td>
                  <td className="templates-cell-mono">
                    {tpl.decoderScript?.trim() ? `${tpl.decoderScript.trim().slice(0, 48)}…` : '—'}
                  </td>
                  <td>{tpl.downlinks?.length || 0}</td>
                  <td className="templates-default-col">
                    {defaultTemplateId === tpl.id ? (
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
                        title="Cada nuevo dispositivo heredará clase LoRaWAN, decoder y downlinks de esta plantilla"
                        onClick={() => {
                          setDefaultTemplateId(tpl.id);
                          refresh();
                        }}
                      >
                        Heredar en altas
                      </button>
                    )}
                  </td>
                  <td className="templates-actions-col">
                    <button type="button" className="btn-icon btn-icon--edit" title="Editar" onClick={() => openEdit(tpl)}>
                      <Pencil size={16} />
                    </button>
                    <button type="button" className="btn-icon btn-icon--danger" title="Eliminar" onClick={() => handleDelete(tpl)}>
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
