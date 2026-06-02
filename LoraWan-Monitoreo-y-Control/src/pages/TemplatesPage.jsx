import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import { Plus, Pencil, Trash2, X, Layers, Wand2, Upload, Download } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  getDeviceTemplates,
  saveDeviceTemplate,
  deleteDeviceTemplate,
  getDefaultTemplateId,
  setDefaultTemplateId,
  buildDeviceTemplatesExportDocument,
  mergeDeviceTemplatesFromImport,
  lorawanClassOptionLabel,
  normalizeTemplateLorawanClass,
  pushTemplateToAssignedDevices,
  templateSyncPlan,
  getDeviceTemplateById,
  normalizeTelemetryLabelHints,
  hydrateDeviceTemplatesCatalogFromServer,
  publishLocalCustomTemplatesIfServerEmpty,
  flushDeviceTemplatesCatalogToServer,
} from '../services/deviceTemplates';
import { saveDeviceDecodeConfig } from '../services/api';
import { adaptDecoderScriptForSyscom } from '../utils/adaptDecoderScript';
import { inferTelemetryLabelsFromDecoderScript } from '../utils/inferDecoderTelemetryLabels';
import { getDuplicateEntityNotice } from '../utils/duplicateEntityNotice';
import CenteredAlertModal from '../components/CenteredAlertModal';
import './TemplatesPage.css';

function initialTemplatesNotice() {
  return {
    open: false,
    title: 'Aviso',
    message: '',
    variant: 'info',
    wide: false,
    confirmLabel: 'Aceptar',
  };
}

const emptyForm = () => ({
  id: null,
  modelo: '',
  marca: '',
  channel: '1',
  lorawanClass: 'A',
  decoderScript: '',
  downlinks: [{ name: '', hex: '' }],
  /** Mapa campo → { trueText, falseText }; se rellena al pulsar «Ajustar» (inferencia desde el decoder). */
  telemetryLabels: {},
});

const TemplatesPage = () => {
  const { isSuperAdmin } = useAuth();
  const importInputRef = useRef(null);
  const [templates, setTemplates] = useState(() => getDeviceTemplates());
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  /** Contenido decoder “congelado” al abrir o tras «Ajustar»; si el textarea difiere, hay que ajustar antes de guardar. */
  const [decoderSnapshot, setDecoderSnapshot] = useState('');
  const [decoderAdjustAck, setDecoderAdjustAck] = useState(true);
  const [defaultTemplateId, setDefaultTemplateIdState] = useState(() => getDefaultTemplateId());
  /** Propaga plantilla a dispositivos vinculados (decoder, puerto, clase en API; downlinks en local). */
  const [templateSyncBusy, setTemplateSyncBusy] = useState(false);
  const [templateSyncLabel, setTemplateSyncLabel] = useState('');
  /** Avisos de la página (guardar, importar, «Ajustar»): modal Syscom, sin `alert` nativo. */
  const [templatesNoticeModal, setTemplatesNoticeModal] = useState(() => initialTemplatesNotice());
  const closeTemplatesNotice = () => setTemplatesNoticeModal(initialTemplatesNotice());

  const refresh = useCallback(() => {
    setTemplates(getDeviceTemplates());
    setDefaultTemplateIdState(getDefaultTemplateId());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await hydrateDeviceTemplatesCatalogFromServer({ syncLocalExtrasToServer: isSuperAdmin });
        if (!cancelled) await publishLocalCustomTemplatesIfServerEmpty(isSuperAdmin);
      } catch (e) {
        if (!cancelled) console.warn('[TemplatesPage] catálogo servidor:', e?.message || e);
      }
      if (!cancelled) refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, isSuperAdmin]);

  const openNew = () => {
    setDecoderSnapshot('');
    setForm(emptyForm());
    setDecoderAdjustAck(true);
    setEditorOpen(true);
  };

  const openEdit = (t) => {
    const dec = t.decoderScript || '';
    setDecoderSnapshot(dec);
    setForm({
      id: t.id,
      modelo: t.modelo || '',
      marca: t.marca || '',
      channel: t.channel != null && String(t.channel).trim() !== '' ? String(t.channel) : '1',
      lorawanClass: normalizeTemplateLorawanClass(t.lorawanClass),
      decoderScript: dec,
      downlinks:
        t.downlinks?.length > 0
          ? t.downlinks.map((d) => ({ name: d.name || '', hex: d.hex || '' }))
          : [{ name: '', hex: '' }],
      telemetryLabels: normalizeTelemetryLabelHints(t.telemetryLabels),
    });
    setDecoderAdjustAck(true);
    setEditorOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.modelo.trim() || !form.marca.trim()) {
      setTemplatesNoticeModal({
        open: true,
        title: 'Datos incompletos',
        message: 'Modelo y marca son obligatorios.',
        variant: 'error',
        wide: false,
        confirmLabel: 'Aceptar',
      });
      return;
    }
    const dec = form.decoderScript || '';
    if (String(dec).trim() && dec !== decoderSnapshot && !decoderAdjustAck) {
      setTemplatesNoticeModal({
        open: true,
        title: 'Payload decoder',
        message: 'El payload decoder ha cambiado. Pulse «Ajustar» para validarlo y adaptarlo antes de guardar.',
        variant: 'error',
        wide: false,
        confirmLabel: 'Aceptar',
      });
      return;
    }
    const previousTemplate = form.id ? getDeviceTemplateById(form.id) : null;
    let entry;
    try {
      entry = saveDeviceTemplate({
        id: form.id,
        modelo: form.modelo,
        marca: form.marca,
        channel: form.channel,
        lorawanClass: form.lorawanClass,
        decoderScript: form.decoderScript,
        downlinks: form.downlinks,
        telemetryLabels: form.telemetryLabels,
      });
    } catch (err) {
      if (err.code === 'TEMPLATE_MODEL_EXISTS') {
        const dup = getDuplicateEntityNotice('TEMPLATE_MODEL_EXISTS', {
          conflictModelo: err.conflictModelo,
          conflictMarca: err.conflictMarca,
        });
        setTemplatesNoticeModal({
          open: true,
          title: dup.title,
          message: dup.body,
          variant: 'warning',
          wide: false,
          confirmLabel: 'Entendido',
        });
        return;
      }
      setTemplatesNoticeModal({
        open: true,
        title: 'No se pudo guardar',
        message: err.message || 'No se pudo guardar la plantilla.',
        variant: 'error',
        wide: false,
        confirmLabel: 'Aceptar',
      });
      return;
    }
    refresh();

    const syncPlan = templateSyncPlan(entry, previousTemplate);

    setTemplateSyncBusy(true);
    setTemplateSyncLabel('Publicando catálogo en servidor…');
    let catalogPublished = false;
    try {
      await flushDeviceTemplatesCatalogToServer();
      catalogPublished = true;
    } catch (fe) {
      const code = fe?.response?.data?.code;
      if (code === 'TEMPLATE_MODEL_EXISTS') {
        const dup = getDuplicateEntityNotice('TEMPLATE_MODEL_EXISTS');
        setTemplatesNoticeModal({
          open: true,
          title: dup.title,
          message: dup.body,
          variant: 'warning',
          wide: true,
          confirmLabel: 'Aceptar',
        });
        setTemplateSyncBusy(false);
        setTemplateSyncLabel('');
        return;
      }
      console.warn('[TemplatesPage] publicar catálogo:', fe?.message || fe);
    }

    try {
      setTemplateSyncLabel(
        syncPlan.downlinksOnly
          ? 'Sincronizando downlinks en dispositivos…'
          : 'Buscando dispositivos vinculados…'
      );
      const r = await pushTemplateToAssignedDevices(entry, saveDeviceDecodeConfig, {
        perDeviceTimeoutMs: syncPlan.downlinksOnly ? 45000 : 120000,
        concurrency: 3,
        syncPlan,
        previousTemplate,
        onProgress: (p) => {
          if (!p || p.phase === 'list') {
            setTemplateSyncLabel(
              syncPlan.downlinksOnly
                ? 'Listando dispositivos vinculados…'
                : 'Buscando dispositivos vinculados…'
            );
            return;
          }
          const total = Number(p.total) || 0;
          const current = Number(p.current) || 0;
          if (total <= 0) {
            setTemplateSyncLabel('Sin dispositivos vinculados.');
            return;
          }
          const did = String(p.deviceId || '');
          const short = did.length > 12 ? `…${did.slice(-10)}` : did;
          const mode = syncPlan.downlinksOnly ? 'downlinks' : 'config';
          setTemplateSyncLabel(`Dispositivo ${current}/${total} (${short}, ${mode})…`);
        },
      });
      const parts = [];
      if (catalogPublished) {
        parts.push(
          'Plantilla guardada en el catálogo del servidor (visible para todos los usuarios con acceso a dispositivos).'
        );
      } else {
        parts.push('Plantilla guardada en local; no se pudo publicar el catálogo en el servidor (revise red o sesión superadmin).');
      }
      if (syncPlan.downlinksOnly) {
        parts.push(
          'Solo se actualizaron downlinks y presets (el decoder de ~19 KB no se reenvió porque no cambió).'
        );
      }
      if (r.synced > 0) {
        parts.push(
          `Actualizado en servidor y en downlinks locales: ${r.synced} dispositivo(s) vinculados (puerto, clase LoRaWAN, decoder, downlinks). Las claves OTAA de cada equipo no se alteran desde aquí.`
        );
      } else {
        parts.push(
          'Ningún dispositivo de esta sesión está vinculado a esta plantilla; los cambios aplicarán en altas nuevas o use «Sincronizar plantilla vinculada» en Dispositivos.'
        );
      }
      if (r.errors.length) {
        parts.push(`Incidencias: ${r.errors.slice(0, 5).join(' · ')}`);
      }
      setTemplatesNoticeModal({
        open: true,
        title: 'Plantilla guardada',
        message: parts.join('\n\n'),
        variant: 'info',
        wide: true,
        confirmLabel: 'Aceptar',
      });
      setEditorOpen(false);
      setForm(emptyForm());
      setDecoderAdjustAck(true);
    } catch (err) {
      setTemplatesNoticeModal({
        open: true,
        title: 'Sincronización',
        message: `Plantilla guardada en local, pero falló la sincronización con dispositivos: ${err?.message || err}\n\nCompruebe sesión de super administrador y red. Puede cerrar el editor o reintentar guardando de nuevo.`,
        variant: 'error',
        wide: true,
        confirmLabel: 'Aceptar',
      });
    } finally {
      refresh();
      setTemplateSyncBusy(false);
      setTemplateSyncLabel('');
    }
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`¿Eliminar la plantilla "${t.modelo}" (${t.marca})?`)) return;
    deleteDeviceTemplate(t.id);
    refresh();
    try {
      await flushDeviceTemplatesCatalogToServer();
    } catch (e) {
      console.warn('[TemplatesPage] publicar catálogo tras borrar:', e?.message || e);
    }
  };

  const handleAdaptDecoder = () => {
    const { script, messages } = adaptDecoderScriptForSyscom(form.decoderScript);
    const { labelsByField, messages: labelMessages } = inferTelemetryLabelsFromDecoderScript(script);
    const mergedLabels = {
      ...normalizeTelemetryLabelHints(form.telemetryLabels),
      ...labelsByField,
    };
    setDecoderSnapshot(script);
    setForm((prev) => ({ ...prev, decoderScript: script, telemetryLabels: mergedLabels }));
    setDecoderAdjustAck(true);
    setTemplatesNoticeModal({
      open: true,
      title: 'Payload decoder ajustado',
      message: [...messages, ...labelMessages].join('\n\n'),
      variant: 'info',
      wide: true,
      confirmLabel: 'Entendido',
    });
  };

  const handleExportTemplates = () => {
    const doc = buildDeviceTemplatesExportDocument();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `syscom-plantillas-dispositivo-${new Date().toISOString().slice(0, 10)}.json`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportTemplatesPick = () => {
    importInputRef.current?.click();
  };

  const handleImportTemplatesFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      (async () => {
        try {
          const text = String(reader.result || '');
          const parsed = JSON.parse(text);
          const { added, replaced, skipped, affectedTemplateIds } = mergeDeviceTemplatesFromImport(parsed);
          refresh();
          let catalogSaved = false;
          let catalogSaveError = '';
          try {
            await flushDeviceTemplatesCatalogToServer();
            catalogSaved = true;
          } catch (fe) {
            catalogSaveError =
              fe?.response?.data?.error || fe?.message || 'No se pudo guardar el catálogo en el servidor.';
            console.warn('[TemplatesPage] publicar tras importar:', catalogSaveError);
          }
          let syncedDevices = 0;
          const syncErrors = [];
          if (Array.isArray(affectedTemplateIds) && affectedTemplateIds.length > 0) {
            setTemplateSyncBusy(true);
            try {
              for (const tid of affectedTemplateIds) {
                const tpl = getDeviceTemplateById(tid);
                if (!tpl) continue;
                const r = await pushTemplateToAssignedDevices(tpl, saveDeviceDecodeConfig);
                syncedDevices += r.synced;
                if (r.errors.length) syncErrors.push(...r.errors);
              }
            } finally {
              setTemplateSyncBusy(false);
              refresh();
            }
          }
          const lines = [
            catalogSaved
              ? `Importación guardada permanentemente: ${added} nuevas, ${replaced} actualizadas por id.`
              : `Importación aplicada en este navegador (${added} nuevas, ${replaced} actualizadas), pero no se guardó en el servidor: ${catalogSaveError}`,
            ...(syncedDevices > 0
              ? [`Dispositivos vinculados actualizados en servidor / downlinks locales: ${syncedDevices}.`]
              : []),
            ...(syncErrors.length ? [`Incidencias al sincronizar: ${syncErrors.slice(0, 4).join(' · ')}`] : []),
            ...(skipped.length ? ['Avisos:', ...skipped] : []),
          ];
          setTemplatesNoticeModal({
            open: true,
            title: 'Importación de plantillas',
            message: lines.join('\n'),
            variant: catalogSaved ? 'info' : 'warning',
            wide: true,
            confirmLabel: 'Aceptar',
          });
        } catch (err) {
          setTemplatesNoticeModal({
            open: true,
            title: 'Importación',
            message: err.message || 'No se pudo importar el archivo.',
            variant: 'error',
            wide: false,
            confirmLabel: 'Aceptar',
          });
        }
      })();
    };
    reader.onerror = () =>
      setTemplatesNoticeModal({
        open: true,
        title: 'Lectura de archivo',
        message: 'No se pudo leer el archivo.',
        variant: 'error',
        wide: false,
        confirmLabel: 'Aceptar',
      });
    reader.readAsText(file, 'utf-8');
  };

  const sorted = useMemo(
    () =>
      [...templates].sort((a, b) =>
        `${a.marca} ${a.modelo}`.localeCompare(`${b.marca} ${b.modelo}`, 'es')
      ),
    [templates]
  );

  const saveBlockedByDecoder =
    Boolean(String(form.decoderScript || '').trim()) &&
    form.decoderScript !== decoderSnapshot &&
    !decoderAdjustAck;

  if (!isSuperAdmin) {
    return (
      <div className="device-list-page device-list-page--premium premium-shell templates-page">
        <div className="table-container glass card premium-access-denied-card templates-page--denied">
          <p>Solo el super administrador puede gestionar plantillas.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="device-list-page device-list-page--premium premium-shell templates-page">
      <CenteredAlertModal
        open={templatesNoticeModal.open}
        title={templatesNoticeModal.title}
        message={templatesNoticeModal.message}
        variant={templatesNoticeModal.variant}
        wide={templatesNoticeModal.wide}
        confirmLabel={templatesNoticeModal.confirmLabel}
        onClose={closeTemplatesNotice}
      />
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <Layers size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">Plantillas de dispositivo ({sorted.length})</span>
          </h1>
        </div>
        <div className="premium-header-actions">
          <input
            id="templates-import-json"
            name="templates-import-json"
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="templates-import-input"
            aria-hidden
            tabIndex={-1}
            onChange={handleImportTemplatesFile}
          />
          <button
            type="button"
            className="btn templates-hero-io-btn"
            onClick={handleImportTemplatesPick}
            disabled={templateSyncBusy}
          >
            <Upload size={18} /> Importar
          </button>
          <button type="button" className="btn templates-hero-io-btn" onClick={handleExportTemplates}>
            <Download size={18} /> Exportar
          </button>
          <button type="button" className="btn btn-primary device-create-top-btn" onClick={openNew}>
            <Plus size={18} /> Nueva plantilla
          </button>
        </div>
      </div>

      <div className="table-container glass card">
        <div className="device-table-scroll">
        {sorted.length === 0 ? (
          <div className="templates-empty premium-empty-in-card">No hay plantillas. Crea la primera con el botón superior.</div>
        ) : (
          <table className="premium-data-table templates-table">
            <thead>
              <tr>
                <th scope="col">Marca</th>
                <th scope="col">Modelo</th>
                <th scope="col">Puerto</th>
                <th scope="col">Clase</th>
                <th scope="col">Decoder</th>
                <th scope="col">Downlinks</th>
                <th scope="col">Altas</th>
                <th className="templates-actions-col device-actions-col" scope="col">
                  <div className="device-actions-head">
                    <span className="device-actions-head-label">Acciones</span>
                  </div>
                </th>
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
                  <td>{lorawanClassOptionLabel(t.lorawanClass)}</td>
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
                          onClick={async () => {
                            setDefaultTemplateId(null);
                            refresh();
                            try {
                              await flushDeviceTemplatesCatalogToServer();
                            } catch (e) {
                              console.warn('[TemplatesPage] publicar catálogo:', e?.message || e);
                            }
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
                        onClick={async () => {
                          setDefaultTemplateId(t.id);
                          refresh();
                          try {
                            await flushDeviceTemplatesCatalogToServer();
                          } catch (e) {
                            console.warn('[TemplatesPage] publicar catálogo:', e?.message || e);
                          }
                        }}
                      >
                        Heredar en altas
                      </button>
                    )}
                  </td>
                  <td className="templates-actions-col device-actions-col">
                    <div className="actions">
                      <div className="device-row-actions-icons" role="group" aria-label="Acciones de plantilla">
                        <button type="button" className="device-action-pill" title="Editar" onClick={() => openEdit(t)}>
                          <Pencil size={18} strokeWidth={2} />
                        </button>
                        <button type="button" className="device-action-pill device-action-pill--danger" title="Eliminar" onClick={() => handleDelete(t)}>
                          <Trash2 size={18} strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </div>
      </div>

      {editorOpen && (
        <div className="modal-overlay um-modal-overlay" role="presentation" onClick={() => setEditorOpen(false)}>
          <div className="modal-content glass um-modal-shell templates-editor-modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{form.id ? 'Editar plantilla' : 'Nueva plantilla'}</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={() => setEditorOpen(false)} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSave} className="templates-editor-form">
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
                  <span className="device-modal-label-text">Puerto</span>
                  <input
                    className="glass device-modal-input device-modal-input--lg"
                    type="text"
                    inputMode="numeric"
                    value={form.channel}
                    onChange={(e) => setForm({ ...form, channel: e.target.value })}
                    placeholder="Ej. 85 (FPort / puerto de aplicación LoRaWAN)"
                    autoComplete="off"
                  />
                </label>

                <label className="device-modal-field templates-editor-label device-create-span2">
                  <span className="device-modal-label-text">Clase</span>
                  <select
                    className="glass device-modal-input device-modal-input--lg"
                    value={normalizeTemplateLorawanClass(form.lorawanClass)}
                    onChange={(e) => setForm({ ...form, lorawanClass: e.target.value })}
                    aria-label="Clase LoRaWAN del dispositivo"
                  >
                    <option value="A">{lorawanClassOptionLabel('A')}</option>
                    <option value="B">{lorawanClassOptionLabel('B')}</option>
                    <option value="C">{lorawanClassOptionLabel('C')}</option>
                  </select>
                </label>

                <label className="device-modal-field templates-editor-label device-create-span2">
                  <div className="templates-decoder-label-row">
                    <span className="device-modal-label-text">Payload decoder</span>
                    <button
                      type="button"
                      className="btn templates-decoder-adjust-btn"
                      title="Adapta el script pegado al contrato del servidor (decodeUplink, limpiezas Milesight/ChirpStack)"
                      onClick={handleAdaptDecoder}
                    >
                      <Wand2 size={16} aria-hidden /> Ajustar
                    </button>
                  </div>
                  <textarea
                    className="glass device-modal-textarea templates-decoder-textarea"
                    rows={12}
                    value={form.decoderScript}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm({ ...form, decoderScript: v });
                      if (v === decoderSnapshot) setDecoderAdjustAck(true);
                      else setDecoderAdjustAck(false);
                    }}
                    placeholder="// function Decoder(bytes, port) { return { data: { ... } }; }"
                    spellCheck={false}
                  />
                  {Object.keys(normalizeTelemetryLabelHints(form.telemetryLabels)).length > 0 ? (
                    <div className="templates-telemetry-labels-preview glass" role="region" aria-label="Etiquetas de telemetría">
                      <div className="templates-telemetry-labels-preview__title">Etiquetas sugeridas (tras «Ajustar»)</div>
                      <ul className="templates-telemetry-labels-preview__list">
                        {Object.entries(normalizeTelemetryLabelHints(form.telemetryLabels)).map(([k, h]) => (
                          <li key={k}>
                            <code>{k}</code>
                            {h.valueLabels && Object.keys(h.valueLabels).length > 0 ? (
                              <>
                                :{' '}
                                {Object.entries(h.valueLabels)
                                  .filter(([rk]) => /^[0-9]+$/.test(rk))
                                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                                  .map(([rk, lab]) => `${rk}→${lab}`)
                                  .join(', ')}
                              </>
                            ) : (
                              <>
                                : {h.trueText || '—'} / {h.falseText || '—'}
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
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
                      className="device-action-pill device-action-pill--danger templates-downlink-remove"
                      aria-label="Quitar fila"
                      disabled={form.downlinks.length <= 1}
                      onClick={() =>
                        setForm({
                          ...form,
                          downlinks: form.downlinks.filter((_, i) => i !== idx),
                        })
                      }
                    >
                      <Trash2 size={16} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setEditorOpen(false)}>
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saveBlockedByDecoder || templateSyncBusy}
                  title={
                    saveBlockedByDecoder
                      ? 'Pulse «Ajustar» para validar el payload decoder antes de guardar.'
                      : templateSyncBusy
                        ? 'Sincronizando con dispositivos…'
                        : undefined
                  }
                >
                  {templateSyncBusy
                    ? templateSyncLabel || 'Sincronizando…'
                    : 'Guardar plantilla'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplatesPage;
