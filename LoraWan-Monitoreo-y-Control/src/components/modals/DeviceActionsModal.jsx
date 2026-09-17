import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './DeviceActionsModal.css';
import { X, Send, Save, Trash2, Plus } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  fetchDeviceDownlinkPresets,
  putDeviceDownlinkPresets,
  fetchDeviceAccountDownlinks,
  putDeviceAccountDownlinks,
} from '../../services/api';
import {
  resolveDownlinksForDevice,
  readDownlinksFromLocalStorage,
  downlinksLocalStorageKey,
  getStoredTemplateIdForDevice,
  getDeviceTemplateById,
  normalizeTelemetryLabelHints,
  primeDeviceSharedPresetsFromDeviceRows,
  isTimewaveBrandDevice,
  cacheTimewaveAccountDownlinks,
  findTemplateForDevice,
} from '../../services/deviceTemplates';

const EMPTY_ROW = { name: '', hex: '' };

function usefulDownlinks(list) {
  return (Array.isArray(list) ? list : []).filter(
    (d) => String(d?.name || '').trim() && String(d?.hex || '').trim()
  );
}

const DeviceActionsModal = ({ type, device, onClose, onSave, onSend }) => {
  const { user } = useAuth();
  const downlinkServerTimerRef = useRef(null);
  const timewave = useMemo(
    () =>
      Boolean(
        device?.deviceId &&
          isTimewaveBrandDevice(device.deviceId, device.model || device.productModel || '')
      ),
    [device?.deviceId, device?.model, device?.productModel]
  );

  const persistDownlinksToServer = useCallback(
    async (deviceId) => {
      if (!deviceId || timewave) return;
      try {
        const raw = readDownlinksFromLocalStorage(deviceId, {
          deviceModel: device?.model || device?.productModel || '',
          preferTemplate: false,
        });
        const useful = usefulDownlinks(raw);
        const tid = getStoredTemplateIdForDevice(deviceId);
        const tpl = tid ? getDeviceTemplateById(tid) : null;
        const telemetryLabels = tpl ? normalizeTelemetryLabelHints(tpl.telemetryLabels) : {};
        await putDeviceDownlinkPresets(deviceId, {
          downlinks: useful,
          catalogTemplateId: tid || null,
          telemetryLabels,
        });
        primeDeviceSharedPresetsFromDeviceRows([
          {
            deviceId,
            deviceSharedPresets: {
              downlinks: useful,
              catalogTemplateId: tid || null,
              telemetryLabels,
            },
          },
        ]);
      } catch (e) {
        console.warn('[DeviceActionsModal] presets servidor:', e?.message || e);
      }
    },
    [timewave, device?.model, device?.productModel]
  );

  const scheduleDownlinksServerSave = useCallback(
    (deviceId) => {
      if (!deviceId || timewave) return;
      if (downlinkServerTimerRef.current) clearTimeout(downlinkServerTimerRef.current);
      downlinkServerTimerRef.current = setTimeout(() => {
        downlinkServerTimerRef.current = null;
        persistDownlinksToServer(deviceId);
      }, 650);
    },
    [persistDownlinksToServer, timewave]
  );
  const [name, setName] = useState(device?.name || '');
  const [tag, setTag] = useState(device?.tag != null ? String(device.tag) : '');
  const [downlinks, setDownlinks] = useState(() => [{ ...EMPTY_ROW }]);
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    setName(device?.name || '');
    setTag(device?.tag != null ? String(device.tag) : '');
  }, [device?.deviceId, device?.name, device?.tag]);

  useEffect(() => {
    const loadFromTemplate = async () => {
      if (!device?.deviceId || type !== 'downlink') return;
      const model = device.model || device.productModel || '';
      if (timewave) {
        const fromTemplate = usefulDownlinks(findTemplateForDevice(device.deviceId, model)?.downlinks);
        const fallback = fromTemplate.length > 0 ? fromTemplate.map((d) => ({ name: d.name || '', hex: d.hex || '' })) : [{ ...EMPTY_ROW }];
        try {
          const resp = await fetchDeviceAccountDownlinks(device.deviceId);
          const list = Array.isArray(resp?.downlinks) ? resp.downlinks : [];
          cacheTimewaveAccountDownlinks(device.deviceId, list);
          setDownlinks(list.length > 0 ? list.map((d) => ({ name: d.name || '', hex: d.hex || '' })) : fallback);
        } catch (e) {
          console.warn('[DeviceActionsModal] account-downlinks:', e?.message || e);
          const local = resolveDownlinksForDevice(device.deviceId, model);
          setDownlinks(local.length > 0 ? local : fallback);
        }
        setSaveState('idle');
        setSaveError('');
        return;
      }
      try {
        const resp = await fetchDeviceDownlinkPresets(device.deviceId);
        const presets = resp?.presets;
        if (presets && typeof presets === 'object') {
          primeDeviceSharedPresetsFromDeviceRows([
            {
              deviceId: device.deviceId,
              deviceSharedPresets: presets,
            },
          ]);
        }
      } catch (e) {
        console.warn('[DeviceActionsModal] downlink-presets:', e?.message || e);
      }
      const fromTpl = resolveDownlinksForDevice(device.deviceId, model);
      const normalized = fromTpl.length > 0 ? fromTpl : [{ ...EMPTY_ROW }];
      localStorage.setItem(downlinksLocalStorageKey(device.deviceId), JSON.stringify(normalized));
      setDownlinks(normalized);
    };

    loadFromTemplate();
  }, [type, device?.deviceId, device?.model, device?.productModel, timewave, user?.id]);

  const handleEdit = (e) => {
    e.preventDefault();
    if (name.trim()) {
      onSave(device.deviceId, name.trim(), tag.trim());
    }
  };

  const addDownlinkRow = () => {
    const next = [...downlinks, { ...EMPTY_ROW }];
    setDownlinks(next);
    if (!timewave) {
      localStorage.setItem(downlinksLocalStorageKey(device?.deviceId), JSON.stringify(next));
      scheduleDownlinksServerSave(device?.deviceId);
    } else {
      setSaveState('idle');
    }
  };

  const updateDownlinkRow = (index, field, value) => {
    const newDownlinks = [...downlinks];
    newDownlinks[index][field] = value;
    setDownlinks(newDownlinks);
    if (!timewave) {
      localStorage.setItem(downlinksLocalStorageKey(device?.deviceId), JSON.stringify(newDownlinks));
      scheduleDownlinksServerSave(device?.deviceId);
    } else {
      setSaveState('idle');
    }
  };

  const removeDownlinkRow = (index) => {
    const newDownlinks = downlinks.filter((_, i) => i !== index);
    const next = newDownlinks.length ? newDownlinks : [{ ...EMPTY_ROW }];
    setDownlinks(next);
    if (!timewave) {
      localStorage.setItem(downlinksLocalStorageKey(device?.deviceId), JSON.stringify(next));
      scheduleDownlinksServerSave(device?.deviceId);
    } else {
      setSaveState('idle');
    }
  };

  const handleSaveTimewaveDownlinks = async () => {
    if (!device?.deviceId || !timewave) return;
    const useful = usefulDownlinks(downlinks);
    setSaveState('saving');
    setSaveError('');
    try {
      const resp = await putDeviceAccountDownlinks(device.deviceId, { downlinks: useful });
      const saved = Array.isArray(resp?.downlinks) ? resp.downlinks : useful;
      cacheTimewaveAccountDownlinks(device.deviceId, saved);
      primeDeviceSharedPresetsFromDeviceRows([
        {
          deviceId: device.deviceId,
          productModel: device.model || device.productModel || '',
          accountDownlinks: saved,
          deviceSharedPresets: { downlinks: [] },
        },
      ]);
      setDownlinks(saved.length > 0 ? saved.map((d) => ({ name: d.name || '', hex: d.hex || '' })) : [{ ...EMPTY_ROW }]);
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      setSaveError(e?.response?.data?.error || e?.message || 'No se pudieron guardar los comandos.');
    }
  };

  const [sendingRow, setSendingRow] = useState(null);
  const [sentFlashRow, setSentFlashRow] = useState(null);

  const handleSendRow = async (index, hex, name) => {
    const payload = String(hex || '').trim();
    if (!payload || sendingRow !== null || !onSend) return;
    setSendingRow(index);
    try {
      await Promise.resolve(onSend(device.deviceId, payload, name));
      setSentFlashRow(index);
      window.setTimeout(() => {
        setSentFlashRow((cur) => (cur === index ? null : cur));
      }, 520);
    } finally {
      setSendingRow(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-content glass card${type === 'downlink' ? ' device-actions-modal--downlink' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{type === 'edit' ? 'Editar Dispositivo' : `Downlink: ${device.name || device.sn}`}</h2>
          <button className="btn-icon" onClick={onClose}><X size={20} /></button>
        </div>

        {type === 'edit' ? (
          <form onSubmit={handleEdit} className="modal-body">
            <div className="form-group">
              <label htmlFor="device-edit-name">Nombre del dispositivo</label>
              <input
                id="device-edit-name"
                name="device-edit-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="glass"
                placeholder="Ingresa el nombre…"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="device-edit-tag">Etiqueta (identificación)</label>
              <input
                id="device-edit-tag"
                name="device-edit-tag"
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                className="glass"
                placeholder="Opcional: referencia interna, ubicación, etc."
                maxLength={128}
              />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
              <button type="submit" className="btn btn-primary"><Save size={18} /> Guardar Cambios</button>
            </div>
          </form>
        ) : (
          <div className="modal-body">
            {timewave ? (
              <p className="downlink-timewave-hint">
                Si aún no hay comandos en esta cuenta, se muestran los HEX de la plantilla. Al guardar quedan
                solo en su cuenta y no cambian el catálogo ni otros equipos.
              </p>
            ) : null}
            <div className="downlink-list">
              {downlinks.map((dl, index) => (
                <div key={index} className="downlink-row glass">
                  <div className="row-inputs">
                    <input 
                      type="text" 
                      placeholder="Nombre (ej. Cerrar válvula)" 
                      value={dl.name}
                      onChange={e => updateDownlinkRow(index, 'name', e.target.value)}
                    />
                    <input 
                      type="text" 
                      placeholder="Hex (ej. FEFEFEFE68…16)" 
                      value={dl.hex}
                      onChange={e => updateDownlinkRow(index, 'hex', e.target.value)}
                    />
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className={[
                        'downlink-action-btn',
                        'downlink-action-btn--send',
                        sendingRow === index ? 'is-sending' : '',
                        sentFlashRow === index ? 'is-sent' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => handleSendRow(index, dl.hex, dl.name)}
                      title={sendingRow === index ? 'Enviando…' : 'Enviar downlink'}
                      aria-label={sendingRow === index ? 'Enviando downlink' : `Enviar ${dl.name || 'comando'}`}
                      disabled={!String(dl.hex || '').trim() || sendingRow !== null}
                    >
                      <span className="downlink-action-btn__icon" aria-hidden>
                        <Send size={17} strokeWidth={2.25} />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="downlink-action-btn downlink-action-btn--delete"
                      onClick={() => removeDownlinkRow(index)}
                      title="Eliminar comando"
                      aria-label={`Eliminar ${dl.name || 'comando'}`}
                      disabled={sendingRow !== null}
                    >
                      <span className="downlink-action-btn__icon" aria-hidden>
                        <Trash2 size={17} strokeWidth={2.25} />
                      </span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            
            <button className="btn btn-secondary add-btn" onClick={addDownlinkRow}>
              <Plus size={16} /> Añadir Downlink
            </button>
            {timewave && saveError ? <p className="downlink-timewave-error">{saveError}</p> : null}
            
            <div className="modal-footer">
              {timewave ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveTimewaveDownlinks}
                  disabled={saveState === 'saving'}
                >
                  <Save size={18} /> {saveState === 'saving' ? 'Guardando…' : saveState === 'saved' ? 'Guardado' : 'Guardar'}
                </button>
              ) : null}
              <button className="btn btn-secondary" onClick={onClose}>Cerrar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeviceActionsModal;
