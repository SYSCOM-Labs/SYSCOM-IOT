import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, X, Trash2, RefreshCw, Loader, RadioTower, Edit2 } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { fetchLorawanGateways, createLorawanGateway, updateLorawanGateway, deleteLorawanGateway } from '../services/api';
import FormToast from '../components/FormToast';
import { getDuplicateEntityNotice } from '../utils/duplicateEntityNotice';
import { LORAWAN_GATEWAY_BAND_OPTIONS, LORAWAN_GATEWAY_BAND_VALUES } from '../constants/lorawanGatewayBands';
import { hexDigitsBorderClass, requiredTrimBorderClass } from '../utils/formFieldBorderClasses';
import '../components/modals/DeviceActionsModal.css';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './GatewaysPage.css';

const EMPTY_FORM = {
  name: '',
  gatewayEui: '',
  frequencyBand: LORAWAN_GATEWAY_BAND_OPTIONS[0].value,
};

function formatEuiDisplay(hex) {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!h) return '—';
  return h.match(/.{1,2}/g)?.join(' ') ?? h;
}

function euiHexBytes(hex) {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  if (!h) return 0;
  if (h.length % 2 !== 0) return Math.floor(h.length / 2);
  return h.length / 2;
}

function labelForBand(stored) {
  const o = LORAWAN_GATEWAY_BAND_OPTIONS.find((x) => x.value === stored);
  return o ? o.label : stored || '—';
}

const GatewaysPage = () => {
  const { t } = useLanguage();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notify, setNotify] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchLorawanGateways();
      setList(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const euiHex = useMemo(() => form.gatewayEui.replace(/[^0-9a-fA-F]/g, ''), [form.gatewayEui]);
  const euiBytes = euiHexBytes(form.gatewayEui);

  const gatewayFormOk = useMemo(() => {
    const nameOk = form.name.trim().length >= 1;
    const euiOk = euiHex.length === 16;
    const bandTrim = String(form.frequencyBand || '').trim();
    const bandOk = LORAWAN_GATEWAY_BAND_VALUES.has(bandTrim) || (Boolean(editingId) && bandTrim.length > 0);
    return nameOk && euiOk && bandOk;
  }, [form.name, form.frequencyBand, euiHex.length, editingId]);

  const bandOptions = useMemo(() => {
    const opts = [...LORAWAN_GATEWAY_BAND_OPTIONS];
    const v = String(form.frequencyBand || '').trim();
    if (v && !LORAWAN_GATEWAY_BAND_VALUES.has(v)) {
      opts.push({ value: v, label: labelForBand(v) });
    }
    return opts;
  }, [form.frequencyBand]);

  const openModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setNotify(null);
    setModalOpen(true);
  };

  const openEdit = (g) => {
    const storedBand = String(g.frequencyBand || '').trim();
    setEditingId(g.id);
    setForm({
      name: g.name || '',
      gatewayEui: String(g.gatewayEui || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase(),
      frequencyBand: storedBand || EMPTY_FORM.frequencyBand,
    });
    setSaveError(null);
    setNotify(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setEditingId(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setNotify(null);
    if (!form.name.trim()) {
      setSaveError('Indica un nombre para el gateway.');
      return;
    }
    if (euiHex.length !== 16) {
      setSaveError('Gateway EUI: debe tener exactamente 16 caracteres hexadecimales (8 bytes).');
      return;
    }
    const bandTrim = String(form.frequencyBand || '').trim();
    if (!LORAWAN_GATEWAY_BAND_VALUES.has(bandTrim) && !editingId) {
      setSaveError('Seleccione una banda de frecuencia válida.');
      return;
    }
    if (!gatewayFormOk) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        gatewayEui: euiHex,
        frequencyBand: bandTrim,
      };
      if (editingId) {
        await updateLorawanGateway(editingId, payload);
        setNotify({ type: 'success', message: 'Gateway actualizado correctamente.' });
      } else {
        await createLorawanGateway(payload);
        setNotify({ type: 'success', message: 'Gateway registrado correctamente.' });
      }
      setModalOpen(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.error || err?.message || t('common.error');
      if (code === 'GATEWAY_EXISTS') {
        const dup = getDuplicateEntityNotice('GATEWAY_EXISTS');
        setNotify({
          type: 'warning',
          title: dup.title,
          message: dup.body,
        });
        setSaveError(null);
      } else {
        setSaveError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`¿Eliminar el gateway «${name}»?`)) return;
    try {
      await deleteLorawanGateway(id);
      await load();
    } catch (err) {
      window.alert(err?.response?.data?.error || err?.message || t('common.error'));
    }
  };

  return (
    <div className="device-list-page device-list-page--premium premium-shell gateways-page">
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <RadioTower size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">
              {t('nav.gateway')} ({list.length})
            </span>
          </h1>
        </div>
        <div className="premium-header-actions">
          <button type="button" className="btn btn-secondary" onClick={() => load()} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
            {t('common.refresh')}
          </button>
          <button type="button" className="btn btn-primary device-create-top-btn" onClick={openModal}>
            <Plus size={18} />
            Añadir gateway
          </button>
        </div>
      </div>

      {error && <div className="gateways-banner error">{error}</div>}

      {loading && list.length === 0 ? (
        <div className="table-container glass card">
          <div className="gateways-loading premium-loading-in-card">
            <Loader className="spin" size={28} />
          </div>
        </div>
      ) : list.length === 0 ? (
        <div className="table-container glass card">
          <div className="gateways-empty premium-empty-in-card">
            <p>No hay gateways registrados. Pulsa «Añadir gateway» para dar de alta el primero.</p>
            <p className="gateways-empty-hint">
              Compatible con UG65/UG63 (Semtech UDP) y EG71. Configure la API del EG71 en Ajustes si administra el gateway por REST/CGI.
            </p>
          </div>
        </div>
      ) : (
        <div className="table-container glass card">
          <div className="device-table-scroll">
            <table className="premium-data-table gateways-table">
              <thead>
                <tr>
                  <th scope="col">Nombre</th>
                  <th scope="col">Gateway EUI</th>
                  <th scope="col">Frecuencia</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Última actividad</th>
                  <th className="device-actions-col" scope="col">
                    <div className="device-actions-head">
                      <span className="device-actions-head-label">Acciones</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((g) => (
                  <tr key={g.id}>
                    <td className="gw-name">{g.name}</td>
                    <td>
                      <code className="gw-eui">{formatEuiDisplay(g.gatewayEui)}</code>
                    </td>
                    <td className="gw-band">{labelForBand(g.frequencyBand)}</td>
                    <td>
                      <span className={`gw-pill ${g.online ? 'online' : 'offline'}`}>
                        {g.online ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td className="gw-seen">
                      {g.lastSeenAt
                        ? new Date(g.lastSeenAt).toLocaleString(undefined, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </td>
                    <td className="device-actions-col">
                      <div className="actions">
                        <div className="device-row-actions-icons" role="group" aria-label="Acciones del gateway">
                          <button
                            type="button"
                            className="device-action-pill"
                            title={t('devices.perm_edit')}
                            aria-label={t('devices.perm_edit')}
                            onClick={() => openEdit(g)}
                          >
                            <Edit2 size={18} strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            className="device-action-pill device-action-pill--danger"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                            onClick={() => handleDelete(g.id, g.name)}
                          >
                            <Trash2 size={18} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {notify && !modalOpen && (
        <div className="gateways-page-toast-host">
          <FormToast
            type={notify.type}
            title={notify.title}
            message={notify.message}
            onDismiss={() => setNotify(null)}
            durationMs={notify.type === 'warning' ? 10000 : 5000}
          />
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay um-modal-overlay" role="presentation" onClick={closeModal}>
          <div
            className="modal-content glass um-modal-shell gateways-modal"
            role="dialog"
            aria-labelledby="gw-modal-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="gw-modal-title">{editingId ? 'Editar gateway LoRaWAN' : 'Añadir gateway LoRaWAN'}</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={closeModal} aria-label={t('common.close')}>
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body">
                <p className="gw-modal-hint">
                  {editingId
                    ? 'Corrige el nombre o un carácter del Gateway EUI. El estado Online/Offline se infiere de la telemetría que referencie ese EUI.'
                    : 'Registra el EUI del gateway en tu cuenta. El estado Online/Offline se infiere de la telemetría que referencie ese EUI en la ingesta.'}
                </p>
                {notify?.type === 'warning' && (
                  <FormToast
                    type="warning"
                    title={notify.title}
                    message={notify.message}
                    onDismiss={() => setNotify(null)}
                    durationMs={12000}
                  />
                )}
                {saveError && <div className="gateways-banner error">{saveError}</div>}
                <div className="form-group">
                  <label htmlFor="gw-name">Nombre</label>
                  <input
                    id="gw-name"
                    className={['glass', requiredTrimBorderClass(form.name)].filter(Boolean).join(' ')}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Ej. Gateway almacén norte"
                    maxLength={128}
                    autoComplete="off"
                  />
                </div>
                <div className="form-group">
                  <div className="gw-eui-row">
                    <label htmlFor="gw-eui">Gateway EUI</label>
                    <span className="gw-byte-badge">{euiBytes} bytes</span>
                  </div>
                  <input
                    id="gw-eui"
                    className={['glass', 'gw-eui-input', hexDigitsBorderClass(form.gatewayEui, 16)].filter(Boolean).join(' ')}
                    value={form.gatewayEui}
                    onChange={(e) => setForm((f) => ({ ...f, gatewayEui: e.target.value }))}
                    placeholder="16 caracteres hex (8 bytes)"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="field-hint">
                    El EUI del gateway lo proporciona el fabricante o viene impreso en el equipo.
                  </p>
                </div>
                <div className="form-group">
                  <label htmlFor="gw-freq">Frecuencia</label>
                  <select
                    id="gw-freq"
                    className="glass"
                    value={form.frequencyBand}
                    onChange={(e) => setForm((f) => ({ ...f, frequencyBand: e.target.value }))}
                  >
                    {bandOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal} disabled={saving}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving || !gatewayFormOk}>
                  {saving ? <Loader className="spin" size={18} /> : null}
                  {t('common.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default GatewaysPage;
