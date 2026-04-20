import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, X, Trash2, RefreshCw, Loader } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { fetchLorawanGateways, createLorawanGateway, deleteLorawanGateway } from '../services/api';
import FormToast from '../components/FormToast';
import { LORAWAN_GATEWAY_BAND_OPTIONS, LORAWAN_GATEWAY_BAND_VALUES } from '../constants/lorawanGatewayBands';
import '../components/modals/DeviceActionsModal.css';
import './GatewaysPage.css';

const EMPTY_FORM = {
  name: '',
  gatewayEui: '',
  /** US915 subbanda FSB2 (canales 125 kHz 8–15 + 500 kHz 65–70). */
  frequencyBand: 'US902-928-FSB2',
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
    const bandOk = LORAWAN_GATEWAY_BAND_VALUES.has(String(form.frequencyBand || '').trim());
    return nameOk && euiOk && bandOk;
  }, [form.name, form.frequencyBand, euiHex.length]);

  const openModal = () => {
    setForm(EMPTY_FORM);
    setSaveError(null);
    setNotify(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
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
    if (!LORAWAN_GATEWAY_BAND_VALUES.has(String(form.frequencyBand || '').trim())) {
      setSaveError('Seleccione una banda de frecuencia válida.');
      return;
    }
    if (!gatewayFormOk) return;
    setSaving(true);
    try {
      await createLorawanGateway({
        name: form.name.trim(),
        gatewayEui: euiHex,
        frequencyBand: form.frequencyBand,
      });
      setNotify({ type: 'success', message: 'Gateway registrado correctamente.' });
      setModalOpen(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.error || err?.message || t('common.error');
      if (code === 'GATEWAY_EXISTS') {
        setNotify({
          type: 'error',
          message: 'Ya existe un gateway con este EUI. No se puede completar el registro.',
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
    <div className="gateways-page">
      <div className="gateways-toolbar">
        <p className="gateways-intro">
          Añade gateways LoRaWAN a tu cuenta para llevar un inventario y ver si hay actividad reciente en la ingesta
          (Online / Offline según telemetría asociada al EUI).
        </p>
        <div className="gateways-toolbar-actions">
          <button type="button" className="btn-secondary glass" onClick={() => load()} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
            {t('common.refresh')}
          </button>
          <button type="button" className="btn-primary" onClick={openModal}>
            <Plus size={18} />
            Añadir gateway
          </button>
        </div>
      </div>

      {error && <div className="gateways-banner error">{error}</div>}

      {loading && list.length === 0 ? (
        <div className="gateways-loading">
          <Loader className="spin" size={28} />
        </div>
      ) : list.length === 0 ? (
        <div className="gateways-empty glass card">
          <p>No hay gateways registrados. Pulsa «Añadir gateway» para dar de alta el primero.</p>
        </div>
      ) : (
        <div className="gateways-table-wrap glass card">
          <table className="gateways-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Gateway EUI</th>
                <th>Frecuencia</th>
                <th>Estado</th>
                <th>Última actividad</th>
                <th>{t('common.actions')}</th>
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
                  <td>
                    <button
                      type="button"
                      className="gw-delete"
                      title={t('common.delete')}
                      onClick={() => handleDelete(g.id, g.name)}
                    >
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notify && !modalOpen && (
        <div className="gateways-page-toast-host">
          <FormToast
            type={notify.type}
            message={notify.message}
            onDismiss={() => setNotify(null)}
          />
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay" role="presentation">
          <div
            className="modal-content gateways-modal"
            role="dialog"
            aria-labelledby="gw-modal-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="gw-modal-title">Añadir gateway LoRaWAN</h2>
              <button type="button" className="icon-btn-close" onClick={closeModal} aria-label={t('common.close')}>
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body">
                <p className="gw-modal-hint">
                  Registra el EUI del gateway en tu cuenta. El estado Online/Offline se infiere de la telemetría que
                  referencie ese EUI en la ingesta.
                </p>
                {notify?.type === 'error' && (
                  <FormToast type="error" message={notify.message} onDismiss={() => setNotify(null)} durationMs={8000} />
                )}
                {saveError && <div className="gateways-banner error">{saveError}</div>}
                <div className="form-group">
                  <label htmlFor="gw-name">Nombre</label>
                  <input
                    id="gw-name"
                    className="glass"
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
                    className="glass gw-eui-input"
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
                  <label htmlFor="gw-freq">Banda LoRaWAN (plan de frecuencias)</label>
                  <select
                    id="gw-freq"
                    className="glass"
                    value={form.frequencyBand}
                    onChange={(e) => setForm((f) => ({ ...f, frequencyBand: e.target.value }))}
                  >
                    {LORAWAN_GATEWAY_BAND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    FSB2 = plan RF US915 con canales 125 kHz 8–15 (y 500 kHz 65–70). No confundir con «Canal plantilla» (FPort)
                    del decoder en dispositivos.
                  </p>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={closeModal} disabled={saving}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn-primary" disabled={saving || !gatewayFormOk}>
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
