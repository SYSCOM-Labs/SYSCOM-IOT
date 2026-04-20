import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import './DeviceList.css';
import { Battery, ChevronLeft, ChevronRight, Loader, Plus, X, Settings, UserPlus, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import ActionMenu from '../components/ActionMenu';
import FormToast from '../components/FormToast';
import DeviceActionsModal from '../components/modals/DeviceActionsModal';
import DeviceDashboardModal from '../components/modals/DeviceDashboardModal';
import {
  fetchDevices,
  updateDevice,
  sendDownlink,
  registerUserDevice,
  purgeDeviceFromSystem,
  assignDeviceToUser,
  fetchDeviceDecodeConfig,
  saveDeviceDecodeConfig,
  renewDeviceLicense,
} from '../services/api';
import {
  filterDeviceTemplatesByQuery,
  getDefaultTemplateId,
  getDeviceTemplates,
  normalizeTemplateLorawanClass,
  persistTemplateForDeviceId,
} from '../services/deviceTemplates';
import { saveTelemetry, getLatestDeviceData, getUsers } from '../services/localAuth';
import { applyStaleOfflineConnectStatus, isDeviceVisuallyOnline } from '../utils/deviceConnectionStatus';
import { mergeDeviceFromLatestRow } from '../utils/mergeDeviceFromLatest';
import { SYSCOM_REALTIME_TELEMETRY } from '../constants/realtimeEvents';
import { ROUTES } from '../constants/routes';

/** Atajos para el campo «Canal plantilla» = FPort de aplicación (1–223); no son MHz ni banda del gateway. */
const CHANNEL_PRESETS = ['1', '2', '85'];

const DEVICE_LIST_PAGE_SIZES = [5, 10, 25, 50, 100];

const EMPTY_CREATE = { devEUI: '', appEUI: '', appKey: '', displayName: '', etiqueta: '' };

/** A partir del nombre de plantilla, fija el tag de producto permitido en listado (solo UC300 / WS101). */
function inferProductTagFromTemplate(tpl) {
  if (!tpl || !tpl.modelo) return '';
  const m = String(tpl.modelo).trim().toLowerCase();
  if (m.includes('ws101')) return 'ws101';
  if (m.includes('uc300')) return 'uc300';
  return '';
}

/** Validación OTAA completa para alta de sensor (longitudes hex exactas). El tag de producto sale solo de la plantilla. */
function computeSensorFormValidation(form, selectedDeviceTemplate) {
  const devHex = String(form.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const appEui = String(form.appEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const appKey = String(form.appKey || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const errors = [];
  if (devHex.length !== 16) {
    errors.push('DevEUI: deben ser exactamente 16 caracteres hexadecimales (8 bytes).');
  }
  if (appEui.length !== 16) {
    errors.push('AppEUI (JoinEUI): exactamente 16 caracteres hexadecimales (8 bytes).');
  }
  if (appKey.length !== 32) {
    errors.push('AppKey: exactamente 32 caracteres hexadecimales (16 bytes).');
  }
  if (!String(form.displayName || '').trim()) {
    errors.push('Indique el nombre del dispositivo.');
  }
  const inferred = inferProductTagFromTemplate(selectedDeviceTemplate);
  if (inferred !== 'uc300' && inferred !== 'ws101') {
    errors.push(
      'El modelo del producto debe obtenerse de una plantilla UC300 o WS101. Use «Atrás» y elija plantilla predeterminada u otra plantilla.'
    );
  }
  return { ok: errors.length === 0, errors, devHex, appEui, appKey, productTag: inferred };
}

/** Coincidencia por nombre, notas/etiqueta, modelo, DevEUI/sn/deviceId, tag (insensible a mayúsculas y hex). */
function deviceMatchesListSearch(device, query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return true;
  const parts = [
    device.deviceId,
    device.sn,
    device.name,
    device.model,
    device.devEUI,
    device.devEui,
    device.tag,
    device.notes,
  ]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).toLowerCase());
  const blob = parts.join(' | ');
  if (blob.includes(raw)) return true;
  const needleHex = raw.replace(/[^0-9a-f]/g, '');
  if (needleHex.length < 3) return false;
  const blobHex = parts.join('').replace(/[^0-9a-f]/g, '');
  return blobHex.includes(needleHex);
}

function licenseExpiryDisplay(device) {
  if (!device.licenseExpiresAt) return { text: '—', className: '' };
  const exp = new Date(device.licenseExpiresAt).getTime();
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const text = new Date(device.licenseExpiresAt).toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  if (device.licenseExpiredForUsers || exp <= now) {
    return { text, className: 'device-license-cell device-license-cell--expired' };
  }
  if (exp - now <= weekMs) {
    return { text, className: 'device-license-cell device-license-cell--soon' };
  }
  return { text, className: 'device-license-cell' };
}

const DeviceList = ({ listSearchQuery = '', onListSearchQueryChange }) => {
  const navigate = useNavigate();
  const { deviceId: deviceIdParam } = useParams();
  const { credentials, token, user, isAdmin, isSuperAdmin, canCreateDevices } = useAuth();
  const { t } = useLanguage();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalType, setModalType] = useState(null);
  const [activeDevice, setActiveDevice] = useState(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [showCreateDevice, setShowCreateDevice] = useState(false);
  /** choose | pickTemplate | form */
  const [createDeviceStep, setCreateDeviceStep] = useState('choose');
  const [selectedDeviceTemplate, setSelectedDeviceTemplate] = useState(null);
  const [templatePickQuery, setTemplatePickQuery] = useState('');
  const [assignForDevice, setAssignForDevice] = useState(null);
  const [assignSearch, setAssignSearch] = useState('');
  const [assignSelectedUser, setAssignSelectedUser] = useState(null);
  const [usersForAssign, setUsersForAssign] = useState([]);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [savingDevice, setSavingDevice] = useState(false);
  const [createNotify, setCreateNotify] = useState(null);
  const [configForDevice, setConfigForDevice] = useState(null);
  const [decoderForm, setDecoderForm] = useState({ decoderScript: '', channel: '' });
  const [loadingDecode, setLoadingDecode] = useState(false);
  const [renewingLicenseId, setRenewingLicenseId] = useState(null);
  const [deviceListPage, setDeviceListPage] = useState(1);
  const [deviceListPageSize, setDeviceListPageSize] = useState(10);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const response = await fetchDevices(credentials, token);
      const list = response.data?.data?.content || response.data?.content || [];
      setDevices(list.map((d) => applyStaleOfflineConnectStatus(d)));
      setError(null);
      if (user?.id && list.length > 0 && isAdmin) {
        list.forEach((dev) => {
          const { deviceId, name, sn, electricity, rssi, ...otherProps } = dev;
          saveTelemetry(deviceId, name || sn, { electricity, rssi, ...otherProps });
        });
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.errMsg || err.message || t('common.error');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    if (!deviceIdParam) {
      setShowDashboard(false);
      // En la lista no hay :deviceId en la URL; no vaciar activeDevice si hay modal (editar / downlink),
      // porque el refresco de `devices` (polling/SSE) re-ejecutaría este efecto y cerraría el modal.
      if (!modalType) {
        setActiveDevice(null);
      }
      return;
    }
    if (loading) return;
    const idNorm = String(deviceIdParam);
    const d = devices.find((x) => String(x.deviceId) === idNorm);
    if (d) {
      setActiveDevice(d);
      setShowDashboard(true);
    } else {
      navigate(ROUTES.dispositivos, { replace: true });
    }
  }, [deviceIdParam, devices, loading, navigate, modalType]);

  useEffect(() => {
    let interval;
    const pollLocalUpdates = async () => {
      if (devices.length === 0) return;
      try {
        const latestData = await getLatestDeviceData();
        if (latestData && latestData.length > 0) {
          setDevices((prevDevices) =>
            prevDevices.map((dev) => {
              const localUpdate = latestData.find((d) => d.deviceId.toString() === dev.deviceId.toString());
              if (localUpdate && localUpdate.properties) {
                return mergeDeviceFromLatestRow(dev, localUpdate);
              }
              return applyStaleOfflineConnectStatus(dev);
            })
          );
        } else {
          setDevices((prev) => prev.map((dev) => applyStaleOfflineConnectStatus(dev)));
        }
      } catch (err) {
        console.error('Error polling local DB:', err);
      }
    };

    interval = setInterval(pollLocalUpdates, 5000);
    return () => clearInterval(interval);
  }, [devices.length]);

  useEffect(() => {
    const onRealtimeTelemetry = () => {
      (async () => {
        try {
          const latestData = await getLatestDeviceData();
          if (!latestData?.length) return;
          setDevices((prevDevices) => {
            if (prevDevices.length === 0) return prevDevices;
            return prevDevices.map((dev) => {
              const localUpdate = latestData.find((d) => d.deviceId.toString() === dev.deviceId.toString());
              if (localUpdate && localUpdate.properties) {
                return mergeDeviceFromLatestRow(dev, localUpdate);
              }
              return applyStaleOfflineConnectStatus(dev);
            });
          });
        } catch (err) {
          console.error('Error merging SSE telemetry:', err);
        }
      })();
    };
    window.addEventListener(SYSCOM_REALTIME_TELEMETRY, onRealtimeTelemetry);
    return () => window.removeEventListener(SYSCOM_REALTIME_TELEMETRY, onRealtimeTelemetry);
  }, []);

  useEffect(() => {
    if (!assignForDevice || !isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await getUsers();
        if (!cancelled) setUsersForAssign(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setUsersForAssign([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignForDevice, isAdmin]);

  useEffect(() => {
    if (!configForDevice || !isAdmin) return;
    let cancelled = false;
    setLoadingDecode(true);
    (async () => {
      try {
        const data = await fetchDeviceDecodeConfig(configForDevice.deviceId);
        if (!cancelled) {
          setDecoderForm({
            decoderScript: data.decoderScript || '',
            channel: data.channel || '',
          });
        }
      } catch {
        if (!cancelled) setDecoderForm({ decoderScript: '', channel: '' });
      } finally {
        if (!cancelled) setLoadingDecode(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configForDevice, isAdmin]);

  const templatesForPicker = useMemo(
    () => filterDeviceTemplatesByQuery(templatePickQuery),
    [templatePickQuery]
  );

  const defaultTemplateForAlta = useMemo(() => {
    if (!showCreateDevice) return null;
    const id = getDefaultTemplateId();
    if (!id) return null;
    return getDeviceTemplates().find((t) => t.id === id) || null;
  }, [showCreateDevice]);

  const filteredDevices = useMemo(
    () => devices.filter((d) => deviceMatchesListSearch(d, listSearchQuery)),
    [devices, listSearchQuery]
  );

  const deviceListTotalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredDevices.length / deviceListPageSize)),
    [filteredDevices.length, deviceListPageSize]
  );

  useEffect(() => {
    setDeviceListPage(1);
  }, [listSearchQuery, deviceListPageSize]);

  useEffect(() => {
    setDeviceListPage((p) => Math.min(p, deviceListTotalPages));
  }, [deviceListTotalPages]);

  const paginatedDevices = useMemo(() => {
    const start = (deviceListPage - 1) * deviceListPageSize;
    return filteredDevices.slice(start, start + deviceListPageSize);
  }, [filteredDevices, deviceListPage, deviceListPageSize]);

  const sensorFormValid = useMemo(
    () => computeSensorFormValidation(createForm, selectedDeviceTemplate),
    [createForm, selectedDeviceTemplate]
  );

  const assignFiltered = useMemo(() => {
    const q = assignSearch.trim().toLowerCase();
    const base = usersForAssign.filter((u) => u.id !== user?.id);
    if (!q) return base;
    return base.filter(
      (u) =>
        (u.email || '').toLowerCase().includes(q) || (u.profileName || '').toLowerCase().includes(q)
    );
  }, [usersForAssign, assignSearch, user?.id]);

  const openAssignModal = (device) => {
    setAssignForDevice(device);
    setAssignSelectedUser(null);
    setAssignSearch('');
  };

  const handleSaveName = async (deviceId, newName) => {
    try {
      await updateDevice({ deviceId, name: newName }, credentials, token);
      setModalType(null);
      loadDevices();
    } catch (err) {
      alert(t('common.error') + ': ' + (err.response?.data?.errMsg || err.message));
    }
  };

  const handleSendDownlink = async (deviceId, hex, commandName) => {
    try {
      await sendDownlink(deviceId, hex, credentials, token);
      /* Toast global: LnsDownlinkToastBridge → "Downlink enviado" */
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.errMsg || err.response?.data?.error || err.message || '';
      let friendlyError = '';
      if (!navigator.onLine || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
        friendlyError = '❌ Error de conexión a internet. Verifica tu red e intenta de nuevo.';
      } else if (status === 401 || msg.toLowerCase().includes('token') || msg.toLowerCase().includes('unauthorized')) {
        friendlyError = '❌ Sesión expirada. Cierra sesión y vuelve a entrar.';
      } else if (status === 404 || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('does not exist')) {
        friendlyError = '❌ Dispositivo no encontrado o sin soporte para downlinks.';
      } else if (msg.toLowerCase().includes('offline') || msg.toLowerCase().includes('desconect')) {
        friendlyError = '❌ El dispositivo está fuera de línea. Verifica su conexión.';
      } else if (msg.toLowerCase().includes('hex') || msg.toLowerCase().includes('invalid data') || msg.toLowerCase().includes('format')) {
        friendlyError = '❌ Comando hexadecimal inválido. Verifica el formato (ej: ff1da00013c0000).';
      } else if (status === 501 || msg.toLowerCase().includes('ingest')) {
        friendlyError = '❌ Downlink no disponible en modo ingesta local. Configura comandos en el gateway o otra vía.';
      } else if (status >= 500) {
        friendlyError = '❌ Error en el servidor. Intenta más tarde.';
      } else {
        friendlyError = `❌ Error al enviar "${commandName}": ${msg || 'Error desconocido.'}`;
      }
      alert(friendlyError);
    }
  };

  const openDeviceDashboard = (d) => {
    navigate(ROUTES.dispositivo(d.deviceId));
  };

  /** Vista y widgets por dispositivo (local por deviceId); no redirige al Panel. */
  const onDeviceNameOrOpenClick = (d) => {
    openDeviceDashboard(d);
  };

  const handleCreateDevice = async (e) => {
    e.preventDefault();
    setCreateNotify(null);
    if (!sensorFormValid.ok) {
      setCreateNotify({
        type: 'error',
        message: sensorFormValid.errors.join(' '),
      });
      return;
    }
    const { devHex, appEui, appKey, productTag } = sensorFormValid;
    const name = createForm.displayName.trim();
    setSavingDevice(true);
    try {
      await registerUserDevice({
        deviceId: devHex,
        displayName: name,
        devEUI: devHex,
        appEUI: appEui,
        appKey: appKey,
        tag: String(productTag || '').trim().toLowerCase(),
        notes: String(createForm.etiqueta || '')
          .trim()
          .slice(0, 500),
        lorawanClass: selectedDeviceTemplate
          ? normalizeTemplateLorawanClass(selectedDeviceTemplate.lorawanClass)
          : 'A',
      });

      let templateApplyFailed = false;
      if (selectedDeviceTemplate) {
        try {
          await persistTemplateForDeviceId(devHex, selectedDeviceTemplate, saveDeviceDecodeConfig);
        } catch (applyErr) {
          console.warn('[DeviceList] apply template after create:', applyErr);
          templateApplyFailed = true;
          setCreateNotify({
            type: 'error',
            message:
              'Dispositivo creado, pero no se pudo guardar el decoder o los downlinks en el servidor. Configúralos con el engranaje o en Downlink.',
          });
        }
      }

      if (!templateApplyFailed) {
        setShowCreateDevice(false);
        setCreateDeviceStep('choose');
        setSelectedDeviceTemplate(null);
        setTemplatePickQuery('');
        setCreateForm(EMPTY_CREATE);
      }
      await loadDevices();
    } catch (err) {
      const code = err.response?.data?.code;
      const msg = err.response?.data?.error || err.message || t('common.error');
      if (code === 'DEVICE_EXISTS') {
        setCreateNotify({
          type: 'error',
          message:
            'Ya existe un dispositivo con este identificador o DevEUI. El registro no se puede completar.',
        });
      } else if (code === 'DEVICE_VALIDATION') {
        setCreateNotify({ type: 'error', message: msg });
      } else {
        setCreateNotify({ type: 'error', message: msg });
      }
    } finally {
      setSavingDevice(false);
    }
  };

  const handleAssignConfirm = async (e) => {
    e.preventDefault();
    if (!assignForDevice || !assignSelectedUser?.email) {
      alert('Busca y selecciona un usuario de la lista.');
      return;
    }
    setSavingDevice(true);
    try {
      await assignDeviceToUser(assignForDevice.deviceId, assignSelectedUser.email.trim().toLowerCase());
      setAssignForDevice(null);
      setAssignSelectedUser(null);
      setAssignSearch('');
      await loadDevices();
    } catch (err) {
      alert(err.response?.data?.error || err.message || t('common.error'));
    } finally {
      setSavingDevice(false);
    }
  };

  const handleSaveDecodeConfig = async (e) => {
    e.preventDefault();
    if (!configForDevice) return;
    setSavingDevice(true);
    try {
      await saveDeviceDecodeConfig(configForDevice.deviceId, {
        decoderScript: decoderForm.decoderScript,
        channel: decoderForm.channel,
      });
      setConfigForDevice(null);
    } catch (err) {
      alert(err.response?.data?.error || err.message || t('common.error'));
    } finally {
      setSavingDevice(false);
    }
  };

  const closeCreateDeviceModal = () => {
    if (savingDevice) return;
    setShowCreateDevice(false);
    setCreateDeviceStep('choose');
    setSelectedDeviceTemplate(null);
    setTemplatePickQuery('');
    setCreateNotify(null);
    setCreateForm(EMPTY_CREATE);
  };

  const handleRenewLicense = async (d) => {
    if (renewingLicenseId) return;
    setRenewingLicenseId(d.deviceId);
    try {
      await renewDeviceLicense(d.deviceId);
      setOpenMenuId(null);
      await loadDevices();
    } catch (err) {
      alert(err.response?.data?.error || err.message || t('common.error'));
    } finally {
      setRenewingLicenseId(null);
    }
  };

  const confirmPurgeDevice = async (d) => {
    if (
      !window.confirm(
        `¿ELIMINAR DEFINITIVAMENTE el dispositivo "${d.name || d.deviceId}" de la base de datos? Se borrarán telemetría, asignaciones y tableros. Esta acción no se puede deshacer.`
      )
    ) {
      return;
    }
    try {
      await purgeDeviceFromSystem(d.deviceId);
      setOpenMenuId(null);
      await loadDevices();
    } catch (err) {
      alert(err.response?.data?.error || err.message || t('common.error'));
    }
  };

  if (loading) return <div className="loading-state"><Loader className="spin" /> {t('common.loading')}</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div className="device-list-page device-list-page--premium">
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            {t('devices.title')} (
            {listSearchQuery.trim()
              ? `${filteredDevices.length} de ${devices.length}`
              : devices.length}
            )
          </h1>
          {typeof onListSearchQueryChange === 'function' && (
            <div className="device-list-filter-mobile">
              <input
                type="search"
                className="search-input glass"
                placeholder="Nombre, etiqueta, DevEUI…"
                value={listSearchQuery}
                onChange={(e) => onListSearchQueryChange(e.target.value)}
                aria-label="Filtrar dispositivos"
                autoComplete="off"
              />
            </div>
          )}
        </div>
        {canCreateDevices && (
          <button
            type="button"
            className="btn btn-primary device-create-top-btn"
            onClick={() => {
              setCreateForm(EMPTY_CREATE);
              setSelectedDeviceTemplate(null);
              setCreateDeviceStep('choose');
              setTemplatePickQuery('');
              setCreateNotify(null);
              setShowCreateDevice(true);
            }}
          >
            <Plus size={18} /> Crear nuevo dispositivo
          </button>
        )}
      </div>

      <div className="table-container glass card">
        <div className="device-table-scroll">
        <table className="device-table">
          <thead>
            <tr>
              <th>{t('devices.name')}</th>
              <th>{t('devices.model')}</th>
              <th>{t('devices.status')}</th>
              <th>{t('devices.battery')}</th>
              <th>{t('devices.last_seen')}</th>
              <th>Vencimiento</th>
              <th className="device-actions-col">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredDevices.length === 0 && devices.length > 0 && (
              <tr>
                <td colSpan={7} className="device-table-empty-filter">
                  No hay dispositivos que coincidan con «{listSearchQuery.trim()}». Prueba con nombre, etiqueta, DevEUI o modelo.
                </td>
              </tr>
            )}
            {paginatedDevices.map((device) => {
              const lic = licenseExpiryDisplay(device);
              const visuallyOnline = isDeviceVisuallyOnline(device);
              return (
              <tr key={device.deviceId} className={openMenuId === device.deviceId ? 'row-active' : ''}>
                <td>
                  <div className="device-name-cell clickable" onClick={() => onDeviceNameOrOpenClick(device)}>
                    <span className="name">{device.name || t('devices.unnamed')}</span>
                    <span className="sn">{device.sn}</span>
                  </div>
                </td>
                <td><span className="model-badge">{device.model}</span></td>
                <td>
                  <div className="status-cell">
                    <span className={`status-dot ${visuallyOnline ? 'online' : 'offline'}`}></span>
                    {visuallyOnline ? t('devices.online') : t('devices.offline')}
                  </div>
                </td>
                <td>
                  <div className="battery-cell">
                    <Battery size={14} />
                    {device.electricity ?? 0}%
                  </div>
                </td>
                <td>{device.lastUpdateTime ? new Date(device.lastUpdateTime).toLocaleString() : '—'}</td>
                <td className={lic.className}>
                  <div className="device-license-cell-inner">
                    <span>{lic.text}</span>
                    {isSuperAdmin && device.licenseInSuperadminGrace && (
                      <span className="device-license-grace-badge">Periodo de gracia</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className="actions">
                    {isSuperAdmin && (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary btn-compact super-license-renew"
                          title="Añade un año de vigencia desde la fecha de vencimiento actual (o desde hoy si ya venció)"
                          disabled={renewingLicenseId === device.deviceId}
                          onClick={() => handleRenewLicense(device)}
                        >
                          {renewingLicenseId === device.deviceId ? (
                            <Loader className="spin" size={16} />
                          ) : (
                            <RefreshCw size={16} />
                          )}
                          Renovación de licencia
                        </button>
                        <button
                          type="button"
                          className="btn-icon super-device-btn"
                          title="Asignar dispositivo"
                          aria-label="Asignar dispositivo"
                          onClick={() => openAssignModal(device)}
                        >
                          <UserPlus size={18} />
                        </button>
                      </>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        className="btn-icon super-device-btn"
                        title="Decoder y canal plantilla (FPort de aplicación); no es frecuencia del gateway"
                        aria-label="Configuración decoder"
                        onClick={() => setConfigForDevice(device)}
                      >
                        <Settings size={18} />
                      </button>
                    )}
                    {isAdmin && (
                      <ActionMenu
                        isOpen={openMenuId === device.deviceId}
                        onToggle={(val) =>
                          setOpenMenuId(val === null ? null : openMenuId === device.deviceId ? null : device.deviceId)
                        }
                        onEdit={() => {
                          setActiveDevice(device);
                          setModalType('edit');
                        }}
                        onDownlink={() => {
                          setActiveDevice(device);
                          setModalType('downlink');
                        }}
                        onAssign={isAdmin ? () => openAssignModal(device) : undefined}
                        onPurgeFromSystem={isSuperAdmin ? () => confirmPurgeDevice(device) : undefined}
                      />
                    )}
                  </div>
                </td>
              </tr>
            );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {filteredDevices.length > 0 && (
        <div className="device-list-pagination glass card" role="navigation" aria-label="Paginación del listado">
          <div className="device-list-pagination__sizes">
            <label htmlFor="device-list-page-size">Mostrar</label>
            <select
              id="device-list-page-size"
              className="glass device-list-pagination__select"
              value={deviceListPageSize}
              onChange={(e) => setDeviceListPageSize(Number(e.target.value))}
            >
              {DEVICE_LIST_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="device-list-pagination__per">por página</span>
          </div>
          <div className="device-list-pagination__range" aria-live="polite">
            {(deviceListPage - 1) * deviceListPageSize + 1}–
            {Math.min(deviceListPage * deviceListPageSize, filteredDevices.length)} de {filteredDevices.length}
          </div>
          <div className="device-list-pagination__pages">
            <button
              type="button"
              className="btn btn-secondary device-list-pagination__nav"
              disabled={deviceListPage <= 1}
              onClick={() => setDeviceListPage((p) => Math.max(1, p - 1))}
              aria-label="Página anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="device-list-pagination__current">
              Página <strong>{deviceListPage}</strong> de <strong>{deviceListTotalPages}</strong>
            </span>
            <button
              type="button"
              className="btn btn-secondary device-list-pagination__nav"
              disabled={deviceListPage >= deviceListTotalPages}
              onClick={() => setDeviceListPage((p) => Math.min(deviceListTotalPages, p + 1))}
              aria-label="Página siguiente"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}

      {modalType && activeDevice && (
        <DeviceActionsModal
          type={modalType}
          device={activeDevice}
          onClose={() => {
            setModalType(null);
            setActiveDevice(null);
          }}
          onSave={handleSaveName}
          onSend={handleSendDownlink}
        />
      )}

      {showDashboard && activeDevice && (
        <DeviceDashboardModal
          device={activeDevice}
          onClose={() => {
            setShowDashboard(false);
            setActiveDevice(null);
            navigate(ROUTES.dispositivos);
          }}
          onSendDownlink={handleSendDownlink}
        />
      )}

      {showCreateDevice && (
        <div className="modal-overlay" role="presentation">
          <div
            className={`modal-content glass device-create-modal ${createDeviceStep === 'form' ? 'device-create-modal--wide' : 'device-create-modal--chooser'}`}
            role="dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>
                {createDeviceStep === 'choose' && 'Nuevo dispositivo'}
                {createDeviceStep === 'pickTemplate' && 'Elegir plantilla'}
                {createDeviceStep === 'form' && 'Crear nuevo dispositivo'}
              </h2>
              <button type="button" className="btn-icon" onClick={closeCreateDeviceModal} aria-label="Cerrar" disabled={savingDevice}>
                <X size={20} />
              </button>
            </div>

            {createDeviceStep === 'choose' && (
              <div className="device-create-choose">
                <p className="device-create-hint device-create-hint--tight">
                  Al guardar se copian el <strong>decoder</strong> y los <strong>downlinks</strong> de la plantilla elegida. El modelo de
                  producto (UC300 / WS101) se deduce del nombre de la plantilla.
                </p>
                <p className="device-create-choose-question">¿Cómo quieres dar de alta el dispositivo?</p>
                <div
                  className={`device-create-choose-grid${defaultTemplateForAlta ? ' device-create-choose-grid--with-default' : ''}`}
                >
                  {defaultTemplateForAlta && (
                    <button
                      type="button"
                      className="device-create-choose-card glass device-create-choose-card--featured"
                      onClick={() => {
                        setSelectedDeviceTemplate(defaultTemplateForAlta);
                        setCreateDeviceStep('form');
                      }}
                    >
                      <span className="device-create-choose-title">Plantilla predeterminada</span>
                      <span className="device-create-choose-desc">
                        <strong>{defaultTemplateForAlta.modelo}</strong> · {defaultTemplateForAlta.marca} — se heredan el decoder y{' '}
                        {defaultTemplateForAlta.downlinks?.length || 0} downlink(s) en esta alta (igual que en las siguientes si eliges
                        esta opción).
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="device-create-choose-card glass"
                    onClick={() => {
                      setSelectedDeviceTemplate(null);
                      setCreateDeviceStep('pickTemplate');
                    }}
                  >
                    <span className="device-create-choose-title">Elegir plantilla</span>
                    <span className="device-create-choose-desc">
                      Lista de modelos: decoder, downlinks y modelo de producto según la fila que elijas.
                    </span>
                  </button>
                </div>
                {defaultTemplateForAlta && (
                  <p className="device-create-hint device-create-hint--tight" style={{ marginTop: '0.75rem' }}>
                    La plantilla predeterminada se configura en <strong>Plantillas</strong> (botón «Heredar en altas»).
                  </p>
                )}
              </div>
            )}

            {createDeviceStep === 'pickTemplate' && (
              <div className="device-create-pick-template">
                <p className="device-create-hint device-create-hint--tight">
                  Busca por <strong>modelo</strong> o <strong>marca</strong>. Las plantillas se gestionan en el menú <strong>Plantillas</strong>.
                </p>
                <input
                  type="search"
                  className="glass device-modal-input device-modal-input--lg device-template-search"
                  placeholder="Filtrar por modelo o marca…"
                  value={templatePickQuery}
                  onChange={(e) => setTemplatePickQuery(e.target.value)}
                  autoComplete="off"
                />
                <div className="device-template-pick-list glass">
                  {templatesForPicker.length === 0 ? (
                    <div className="device-template-pick-empty">
                      No hay plantillas que coincidan. Crea una en <strong>Plantillas</strong> o limpia el filtro.
                    </div>
                  ) : (
                    templatesForPicker.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        className="device-template-pick-row"
                        onClick={() => {
                          setSelectedDeviceTemplate(tpl);
                          setCreateDeviceStep('form');
                        }}
                      >
                        <span className="device-template-pick-model">{tpl.modelo}</span>
                        <span className="device-template-pick-brand">{tpl.marca}</span>
                        <span className="device-template-pick-meta">
                          {tpl.channel || '—'} · {tpl.downlinks?.length || 0} downlink(s)
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="modal-footer device-create-pick-footer">
                  <button type="button" className="btn btn-secondary" onClick={() => setCreateDeviceStep('choose')}>
                    ← Volver
                  </button>
                </div>
              </div>
            )}

            {createDeviceStep === 'form' && (
              <>
                {createNotify && (
                  <FormToast
                    type={createNotify.type}
                    message={createNotify.message}
                    onDismiss={() => setCreateNotify(null)}
                    durationMs={createNotify.type === 'error' ? 9000 : 4000}
                  />
                )}
                <form onSubmit={handleCreateDevice} className="device-create-form">
                  <div className="device-create-grid">
                    <label className="device-modal-field">
                      <span className="device-modal-label-text">
                        DevEUI <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        className="glass mono device-modal-input device-modal-input--lg"
                        value={createForm.devEUI}
                        onChange={(e) => setCreateForm({ ...createForm, devEUI: e.target.value })}
                        required
                        placeholder="16 caracteres hex"
                        autoComplete="off"
                      />
                    </label>
                    <label className="device-modal-field">
                      <span className="device-modal-label-text">
                        AppEUI (JoinEUI) <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        className="glass mono device-modal-input device-modal-input--lg"
                        value={createForm.appEUI}
                        onChange={(e) => setCreateForm({ ...createForm, appEUI: e.target.value })}
                        placeholder="16 caracteres hex"
                        autoComplete="off"
                      />
                    </label>
                    <label className="device-create-span2 device-modal-field">
                      <span className="device-modal-label-text">
                        AppKey <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        className="glass mono device-modal-input device-modal-input--lg"
                        value={createForm.appKey}
                        onChange={(e) => setCreateForm({ ...createForm, appKey: e.target.value })}
                        placeholder="32 caracteres hex"
                        autoComplete="off"
                      />
                    </label>
                    <label className="device-modal-field">
                      <span className="device-modal-label-text">
                        Nombre del dispositivo <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        className="glass device-modal-input device-modal-input--lg"
                        value={createForm.displayName}
                        onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                        required
                        placeholder="Nombre visible"
                      />
                    </label>
                    <label className="device-modal-field">
                      <span className="device-modal-label-text">Etiqueta (opcional)</span>
                      <input
                        className="glass device-modal-input device-modal-input--lg"
                        value={createForm.etiqueta}
                        onChange={(e) => setCreateForm({ ...createForm, etiqueta: e.target.value })}
                        placeholder="Código interno, zona, responsable… (búsqueda en Dispositivos)"
                        maxLength={500}
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={savingDevice}
                      onClick={() => (selectedDeviceTemplate ? setCreateDeviceStep('pickTemplate') : setCreateDeviceStep('choose'))}
                    >
                      ← Atrás
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={savingDevice || !sensorFormValid.ok}>
                      {savingDevice ? 'Guardando…' : 'Guardar'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {assignForDevice && (
        <div className="modal-overlay" role="presentation">
          <div
            className="modal-content glass device-create-modal device-assign-modal"
            role="dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Asignar dispositivo</h2>
              <button type="button" className="btn-icon" onClick={() => !savingDevice && setAssignForDevice(null)} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <p className="device-create-hint">
              Dispositivo: <strong>{assignForDevice.name || assignForDevice.deviceId}</strong>. Busca por correo o nombre y selecciona un usuario.
              El dispositivo aparecerá en su cuenta al confirmar.
            </p>
            <form onSubmit={handleAssignConfirm} className="device-create-form">
              <label className="device-modal-field device-assign-search-field">
                <span className="device-modal-label-text">Buscar usuario</span>
                <input
                  className="glass device-modal-input device-modal-input--search"
                  type="search"
                  value={assignSearch}
                  onChange={(e) => setAssignSearch(e.target.value)}
                  placeholder="Correo o nombre…"
                  autoComplete="off"
                />
              </label>
              <div className="assign-user-list glass">
                {assignFiltered.length === 0 ? (
                  <div className="assign-user-empty">No hay coincidencias.</div>
                ) : (
                  assignFiltered.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className={`assign-user-row ${assignSelectedUser?.id === u.id ? 'selected' : ''}`}
                      onClick={() => setAssignSelectedUser(u)}
                    >
                      <span className="assign-user-email">{u.email}</span>
                      <span className="assign-user-meta">
                        {u.profileName || '—'} · {u.role === 'superadmin' ? 'Super admin' : u.role === 'admin' ? 'Admin' : 'Usuario'}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={savingDevice} onClick={() => setAssignForDevice(null)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingDevice || !assignSelectedUser}>
                  {savingDevice ? 'Asignando…' : 'Asignar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {configForDevice && (
        <div className="modal-overlay" role="presentation">
          <div
            className="modal-content glass device-create-modal device-decode-modal"
            role="dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Configuración — {configForDevice.name || configForDevice.deviceId}</h2>
              <button type="button" className="btn-icon" onClick={() => !savingDevice && setConfigForDevice(null)} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <p className="device-create-hint">
              <strong>Canal plantilla (FPort de aplicación)</strong> (1–223): metadato del decoder/downlink;{' '}
              <strong>no</strong> es la frecuencia LoRaWAN del gateway (eso es la banda en Gateways LoRaWAN). Se usa en downlinks e
              ingesta si el uplink no trae fPort; debe alinearse con la plantilla del modelo. Pegue el <strong>payload decoder</strong>{' '}
              (JavaScript) en el servidor para este dispositivo.
            </p>
            {loadingDecode ? (
              <div className="assign-user-empty"><Loader className="spin" /> Cargando…</div>
            ) : (
              <form onSubmit={handleSaveDecodeConfig} className="device-create-form">
                <label className="device-modal-field">
                  <span className="device-modal-label-text">Canal plantilla (FPort aplicación)</span>
                  <input
                    className="glass device-modal-input device-modal-input--lg"
                    list="decode-fport-presets"
                    value={decoderForm.channel}
                    onChange={(e) => setDecoderForm({ ...decoderForm, channel: e.target.value })}
                    placeholder="Ej. 85 (FPort Milesight)"
                  />
                  <datalist id="decode-fport-presets">
                    {CHANNEL_PRESETS.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>
                <label className="device-modal-field">
                  <span className="device-modal-label-text">Payload decoder</span>
                  <textarea
                    className="glass device-decode-textarea device-modal-textarea"
                    rows={14}
                    value={decoderForm.decoderScript}
                    onChange={(e) => setDecoderForm({ ...decoderForm, decoderScript: e.target.value })}
                    placeholder="// function Decoder(bytes, port) { return { data: { ... } }; }"
                    spellCheck={false}
                  />
                </label>
                <div className="modal-footer">
                  <button type="button" className="btn btn-secondary" disabled={savingDevice} onClick={() => setConfigForDevice(null)}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={savingDevice}>
                    {savingDevice ? 'Guardando…' : 'Guardar'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DeviceList;
