import React, { useEffect, useState, useMemo, useRef } from 'react';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import {
  Battery,
  Loader,
  Plus,
  Search,
  X,
  UserPlus,
  RefreshCw,
  Edit2,
  Play,
  Database,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import FormToast from '../components/FormToast';
import { getDuplicateEntityNotice } from '../utils/duplicateEntityNotice';
import CenteredAlertModal from '../components/CenteredAlertModal';
import DeviceActionsModal from '../components/modals/DeviceActionsModal';
import DeviceDashboardModal from '../components/modals/DeviceDashboardModal';
import DeviceDataModal from '../components/modals/DeviceDataModal';
import {
  fetchDevices,
  updateDevice,
  sendDownlink,
  registerUserDevice,
  purgeDeviceFromSystem,
  assignDeviceToUser,
  putDeviceBsdPreferences,
  saveDeviceDecodeConfig,
  renewDeviceLicense,
} from '../services/api';
import {
  filterDeviceTemplatesByQuery,
  persistTemplateForDeviceId,
  normalizeTemplateLorawanClass,
  normalizeOtaaTemplateFields,
  lorawanClassOptionLabel,
  productModelLabelFromTemplate,
  hydrateDeviceTemplatesCatalogFromServer,
  publishLocalCustomTemplatesIfServerEmpty,
  primeDeviceSharedPresetsFromDeviceRows,
} from '../services/deviceTemplates';
import { getLatestDeviceData, getUsers } from '../services/localAuth';
import { applyStaleOfflineConnectStatus, isDeviceVisuallyOnline } from '../utils/deviceConnectionStatus';
import { pushAppActivityLog } from '../utils/appActivityLog';
import { SYSCOM_REALTIME_TELEMETRY } from '../constants/realtimeEvents';
import { collectDeviceBsdBundle, deviceBsdBundleIsEmpty } from '../utils/deviceBsdPreferencesBundle';
import { hexDigitsBorderClass, requiredTrimBorderClass } from '../utils/formFieldBorderClasses';

const EMPTY_CREATE = { devEUI: '', appEUI: '', appKey: '', displayName: '', tag: '' };

const DEVICE_PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

/** Lista de índices de página (1-based) con huecos como null para «…». */
function buildDevicePageList(current, total) {
  if (total <= 9) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set([1, total, current]);
  for (let d = 1; d <= 2; d += 1) {
    pages.add(current - d);
    pages.add(current + d);
  }
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Rellena AppKey / App EUI del formulario de alta desde la plantilla **solo si el usuario los dejó vacíos**.
 * En el registro manda el formulario (`registerUserDevice`); la plantilla no vuelve a pisar esas claves al aplicar decoder/downlinks.
 */
function mergeOtaaFromTemplateIntoCreateForm(template, prev) {
  if (!template) return {};
  const o = normalizeOtaaTemplateFields(template);
  const out = {};
  const prevKey = String(prev.appKey || '').replace(/[^0-9a-fA-F]/gi, '');
  const prevEui = String(prev.appEUI || '').replace(/[^0-9a-fA-F]/gi, '');
  if (prevKey.length === 0 && o.otaaAppKey.length === 32) out.appKey = o.otaaAppKey;
  if (prevEui.length === 0 && o.otaaAppEui.length === 16) out.appEUI = o.otaaAppEui.toLowerCase();
  return out;
}

/** Validación OTAA completa para alta de sensor (longitudes hex exactas). */
function computeSensorFormValidation(form) {
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
  return { ok: errors.length === 0, errors, devHex, appEui, appKey };
}

/** Coincidencia por modelo, DevEUI/sn/deviceId, nombre, etiqueta (insensible a mayúsculas y espacios en hex). */
function deviceMatchesListSearch(device, query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return true;
  const parts = [
    device.deviceId,
    device.sn,
    device.name,
    device.model,
    device.productModel,
    device.deviceType,
    device.devEUI,
    device.devEui,
    device.tag,
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

/** A / B → columna batería; C → voltaje (LoRaWAN desde BD / API). */
function normalizeLwClassForDeviceList(raw) {
  const u = String(raw || '')
    .trim()
    .toUpperCase();
  return u === 'C' ? 'C' : 'A';
}

function formatDevicePowerCell(device) {
  const cls = normalizeLwClassForDeviceList(device.lorawanClass);
  if (cls === 'C') {
    let v =
      device.voltage != null && Number.isFinite(Number(device.voltage))
        ? Number(device.voltage)
        : null;
    if (v == null && device.batteryVoltage != null && Number.isFinite(Number(device.batteryVoltage))) {
      v = Number(device.batteryVoltage);
    }
    if (v == null && device.batteryVoltage_mV != null && Number.isFinite(Number(device.batteryVoltage_mV))) {
      v = Number(device.batteryVoltage_mV) / 1000;
    }
    if (v != null && Number.isFinite(v)) {
      const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
      return { mode: 'voltage', text: `${v.toFixed(decimals)} V` };
    }
    if (device.electricity != null && Number.isFinite(Number(device.electricity))) {
      return { mode: 'voltage', text: `${Math.round(Number(device.electricity))}%` };
    }
    return { mode: 'voltage', text: '—' };
  }
  if (device.electricity != null && Number.isFinite(Number(device.electricity))) {
    return { mode: 'battery', text: `${Math.round(Number(device.electricity))}%` };
  }
  return { mode: 'battery', text: '—' };
}

/**
 * Mezcla propiedades leídas de la BD vía `GET /api/devices/latest` (última fila de telemetría por dispositivo; `timestamp` = ts de ingesta).
 * No genera datos nuevos: solo refleja lo persistido en el servidor.
 */
function mergeDeviceRowWithLatestTelemetry(dev, localUpdate) {
  if (!localUpdate || !localUpdate.properties || typeof localUpdate.properties !== 'object') {
    return applyStaleOfflineConnectStatus(dev);
  }
  const p = localUpdate.properties;
  const merged = {
    ...dev,
    ...p,
    deviceId: dev.deviceId,
    name: dev.name,
    tag: dev.tag,
    productModel: dev.productModel,
    lorawanClass: dev.lorawanClass,
    model: String(
      (p.model != null && String(p.model).trim() !== '' ? p.model : '') ||
        p.deviceType ||
        p.hardwareVersion ||
        dev.productModel ||
        dev.model ||
        ''
    ).trim(),
    devEUI: dev.devEUI || dev.devEui || p.devEUI || p.devEui,
    connectStatus: p.connectStatus || p.status || dev.connectStatus,
    electricity: p.electricity !== undefined ? p.electricity : dev.electricity,
    lastUpdateTime:
      localUpdate.timestamp > (dev.lastUpdateTime || 0) ? localUpdate.timestamp : dev.lastUpdateTime,
  };
  return applyStaleOfflineConnectStatus(merged);
}

const DeviceList = ({ listSearchQuery = '', onListSearchQueryChange }) => {
  const { credentials, token, user, userProfile, hasNavPage, isSuperAdmin, canCreateDevices } = useAuth();
  const { t } = useLanguage();
  const canAssignDevice = isSuperAdmin || (hasNavPage('Users') && hasNavPage('Devices'));
  const showDeviceRowActions = hasNavPage('Devices') || isSuperAdmin;
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalType, setModalType] = useState(null);
  const [activeDevice, setActiveDevice] = useState(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showCreateDevice, setShowCreateDevice] = useState(false);
  /** pickTemplate | form — siempre se elige plantilla antes del formulario OTAA */
  const [createDeviceStep, setCreateDeviceStep] = useState('pickTemplate');
  const [selectedDeviceTemplate, setSelectedDeviceTemplate] = useState(null);
  const [templatePickQuery, setTemplatePickQuery] = useState('');
  const [assignForDevice, setAssignForDevice] = useState(null);
  const [assignSearch, setAssignSearch] = useState('');
  const [assignSelectedUser, setAssignSelectedUser] = useState(null);
  const [usersForAssign, setUsersForAssign] = useState([]);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [savingDevice, setSavingDevice] = useState(false);
  const [createNotify, setCreateNotify] = useState(null);
  const [renewingLicenseId, setRenewingLicenseId] = useState(null);
  const [showDataModal, setShowDataModal] = useState(false);
  const [activeDataDevice, setActiveDataDevice] = useState(null);
  const [blockingAlert, setBlockingAlert] = useState(null);
  /** Confirmación modal (sustituye `window.confirm`) antes de purgar o renovar licencia. */
  const [purgeConfirmDevice, setPurgeConfirmDevice] = useState(null);
  const [licenseRenewConfirmDevice, setLicenseRenewConfirmDevice] = useState(null);
  const [deviceTablePage, setDeviceTablePage] = useState(1);
  const [devicePageSize, setDevicePageSize] = useState(10);
  /** Último evento SSE de telemetría (evita GET /devices/latest redundante cada 5 s). */
  const lastRealtimeTelemetryMsRef = useRef(0);

  /**
   * @param {{ silent?: boolean, softFail?: boolean, ensureRows?: object[] }} [opts]
   * - silent: no pantalla completa de carga (p. ej. tras alta / edición).
   * - softFail: no sustituir la página por `error-state`; devolver el error al llamador.
   * - ensureRows: filas mínimas que deben seguir en la lista si el GET no las devolvió (p. ej. caché vacía o desfase).
   * @returns {Promise<{ ok: boolean, error: string | null }>}
   */
  const loadDevices = async (opts = {}) => {
    const silent = Boolean(opts.silent);
    const softFail = Boolean(opts.softFail);
    const ensureRows = Array.isArray(opts.ensureRows) ? opts.ensureRows.filter(Boolean) : [];
    if (!silent) setLoading(true);
    let caught = null;
    try {
      const response = await fetchDevices(credentials, token);
      let list = response.data?.data?.content || response.data?.content || [];
      if (!Array.isArray(list)) list = [];
      let mapped = list.map((d) => applyStaleOfflineConnectStatus(d));
      primeDeviceSharedPresetsFromDeviceRows(mapped);
      if (ensureRows.length > 0) {
        const seen = new Set(mapped.map((d) => String(d.deviceId || '').trim().toLowerCase()));
        for (const row of ensureRows) {
          const id = String(row.deviceId || '').trim().toLowerCase();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          mapped.push(applyStaleOfflineConnectStatus(row));
        }
        mapped.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));
      }
      setDevices(mapped);
      setError(null);
    } catch (err) {
      const msg =
        err.response?.data?.error || err.response?.data?.errMsg || err.message || t('common.error');
      caught = msg;
      if (!softFail) setError(msg);
    } finally {
      if (!silent) setLoading(false);
    }
    return { ok: !caught, error: caught };
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await hydrateDeviceTemplatesCatalogFromServer();
        if (!cancelled && isSuperAdmin) {
          await publishLocalCustomTemplatesIfServerEmpty(true);
        }
      } catch (e) {
        if (!cancelled) console.warn('[DeviceList] catálogo plantillas:', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  useEffect(() => {
    loadDevices();
  }, []);

  /** Mantener «Datos» al día con la fila del listado mientras el modal está abierto. */
  useEffect(() => {
    if (!showDataModal) return;
    setActiveDataDevice((prev) => {
      if (!prev?.deviceId) return prev;
      const fresh = devices.find((d) => String(d.deviceId) === String(prev.deviceId));
      return fresh || prev;
    });
  }, [devices, showDataModal]);

  const applyLatestBatchToDevices = (latestData) => {
    if (!latestData?.length) {
      setDevices((prev) => prev.map((dev) => applyStaleOfflineConnectStatus(dev)));
      return;
    }
    setDevices((prevDevices) => {
      if (prevDevices.length === 0) return prevDevices;
      return prevDevices.map((dev) => {
        const localUpdate = latestData.find((d) => d.deviceId.toString() === dev.deviceId.toString());
        if (localUpdate && localUpdate.properties) {
          return mergeDeviceRowWithLatestTelemetry(dev, localUpdate);
        }
        return applyStaleOfflineConnectStatus(dev);
      });
    });
  };

  useEffect(() => {
    let interval;
    const pollLocalUpdates = async () => {
      if (devices.length === 0) return;
      if (Date.now() - lastRealtimeTelemetryMsRef.current < 15000) return;
      try {
        const latestData = await getLatestDeviceData();
        applyLatestBatchToDevices(latestData);
      } catch (err) {
        console.error('Error polling local DB:', err);
      }
    };

    interval = setInterval(pollLocalUpdates, 15000);
    return () => clearInterval(interval);
  }, [devices.length]);

  useEffect(() => {
    const onRealtimeTelemetry = (ev) => {
      const detail = ev && typeof ev === 'object' ? ev.detail : null;
      if (detail?.deviceId && detail.properties && typeof detail.properties === 'object') {
        lastRealtimeTelemetryMsRef.current = Date.now();
        setDevices((prevDevices) => {
          if (prevDevices.length === 0) return prevDevices;
          const id = String(detail.deviceId);
          return prevDevices.map((dev) =>
            String(dev.deviceId) === id
              ? mergeDeviceRowWithLatestTelemetry(dev, {
                  deviceId: id,
                  properties: detail.properties,
                  timestamp: detail.timestamp != null ? detail.timestamp : Date.now(),
                })
              : applyStaleOfflineConnectStatus(dev)
          );
        });
        return;
      }
      /* Sin deviceId en el evento: no refetch masivo del listado (bloqueaba la UI). */
    };
    window.addEventListener(SYSCOM_REALTIME_TELEMETRY, onRealtimeTelemetry);
    return () => window.removeEventListener(SYSCOM_REALTIME_TELEMETRY, onRealtimeTelemetry);
  }, []);

  useEffect(() => {
    if (!assignForDevice || !canAssignDevice) return;
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
  }, [assignForDevice, canAssignDevice]);

  const templatesForPicker = useMemo(
    () => filterDeviceTemplatesByQuery(templatePickQuery),
    [templatePickQuery]
  );

  const filteredDevices = useMemo(
    () => devices.filter((d) => deviceMatchesListSearch(d, listSearchQuery)),
    [devices, listSearchQuery]
  );

  const powerColumnLabel = useMemo(() => {
    const normalized = filteredDevices.map((d) => normalizeLwClassForDeviceList(d.lorawanClass));
    const hasC = normalized.some((c) => c === 'C');
    const hasOther = normalized.some((c) => c !== 'C');
    if (hasC && hasOther) return 'Batería / Voltaje';
    if (hasC) return 'Voltaje';
    return 'Batería';
  }, [filteredDevices]);

  useEffect(() => {
    setDeviceTablePage(1);
  }, [listSearchQuery]);

  useEffect(() => {
    setDeviceTablePage(1);
  }, [devicePageSize]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredDevices.length / devicePageSize) || 1);
    setDeviceTablePage((p) => Math.min(p, totalPages));
  }, [filteredDevices.length, devicePageSize]);

  const deviceListPagination = useMemo(() => {
    const total = filteredDevices.length;
    const totalPages = Math.max(1, Math.ceil(total / devicePageSize) || 1);
    const safePage = Math.min(Math.max(1, deviceTablePage), totalPages);
    const offset = (safePage - 1) * devicePageSize;
    const slice = filteredDevices.slice(offset, offset + devicePageSize);
    const rangeStart = total === 0 ? 0 : offset + 1;
    const rangeEnd = offset + slice.length;
    return {
      paginatedDevices: slice,
      totalPages,
      safePage,
      rangeStart,
      rangeEnd,
      pageButtons: buildDevicePageList(safePage, totalPages),
    };
  }, [filteredDevices, deviceTablePage, devicePageSize]);

  const sensorFormValid = useMemo(() => computeSensorFormValidation(createForm), [createForm]);

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

  const handleSaveDeviceEdit = async (deviceId, newName, newTag) => {
    try {
      await updateDevice({ deviceId, name: newName, tag: newTag ?? '' }, credentials, token);
      setModalType(null);
      setActiveDevice(null);
      loadDevices();
    } catch (err) {
      setBlockingAlert(t('common.error') + ': ' + (err.response?.data?.errMsg || err.message));
    }
  };

  const handleSendDownlink = async (deviceId, hex, commandName) => {
    try {
      await sendDownlink(deviceId, hex, credentials, token, { confirmed: false });
      /* Toast global: LnsDownlinkToastBridge → "Downlink enviado" */
    } catch (err) {
      const status = err.response?.status;
      const apiCode = err.response?.data?.code;
      const msg = err.response?.data?.errMsg || err.response?.data?.error || err.message || '';
      pushAppActivityLog({
        level: 'warn',
        tag: 'Downlink',
        message: `Intento ${commandName || 'comando'} · ${deviceId}${apiCode ? ` · ${apiCode}` : status ? ` · HTTP ${status}` : ''}`,
        detail: msg || undefined,
      });
      let friendlyError = '';
      if (!navigator.onLine || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
        friendlyError = '❌ Error de conexión a internet. Verifica tu red e intenta de nuevo.';
      } else if (status === 401 || msg.toLowerCase().includes('token') || msg.toLowerCase().includes('unauthorized')) {
        friendlyError = '❌ Sesión expirada. Cierra sesión y vuelve a entrar.';
      } else if (status === 404 || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('does not exist')) {
        friendlyError = '❌ Dispositivo no encontrado o sin soporte para downlinks.';
      } else if (
        status === 400 &&
        (err.response?.data?.code === 'DOWNLINK_FPORT_MISSING' || (msg && msg.includes('Puerto LoRaWAN')))
      ) {
        friendlyError =
          '❌ No hay puerto LoRaWAN (FPort) guardado para este dispositivo. Debe coincidir con el «puerto» de la plantilla (decoder en servidor): reaplique la plantilla o pida al superadmin que actualice el canal.';
      } else if (status === 400 && err.response?.data?.code === 'CLASS_A_RX_WINDOW_CLOSED') {
        friendlyError =
          '❌ Clase A: ventana RX cerrada y el servidor no encoló el comando (reinicie el backend con la última versión; si persiste, revise logs del servidor).';
      } else if (status === 400 && err.response?.data?.code === 'DEFER_INSERT_FAILED') {
        friendlyError = `❌ No se pudo guardar el downlink en cola: ${msg || 'error desconocido'}`;
      } else if (status === 400 && err.response?.data?.code === 'NO_SESSION') {
        friendlyError =
          '❌ Sin sesión LoRaWAN en el servidor (hace falta join OTAA). Compruebe uplinks y claves; si el MIC falla, borre la sesión LNS (p. ej. DELETE /api/devices/{id}/lns/session) y vuelva a enlazar.';
      } else if ((status === 400 || status === 503) && err.response?.data?.code === 'NO_GATEWAY') {
        friendlyError =
          '❌ El LNS aún no ha visto un gateway para este dispositivo. Verifique que el gateway esté en línea y que el nodo suba por ese GW.';
      } else if (status === 429 || err.response?.data?.code === 'DOWNLINK_IN_FLIGHT') {
        friendlyError =
          '❌ Hay un downlink pendiente de GW_TX_ACK. Espere ~8 s (o revise actividad LNS: TX_ACK / timeout). Si el UG65 no envía txpk_ack, defina SYSCOM_LNS_APP_DOWNLINK_TX_ACK=0 o SYSCOM_LNS_TX_ACK_SILENCE_MS.';
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
      setBlockingAlert(friendlyError);
    }
  };

  const openDeviceDashboard = (d) => {
    setActiveDevice(d);
    setShowDashboard(true);
  };

  /** Vista y widgets por dispositivo (local por deviceId); no redirige al Panel. */
  const onDeviceNameOrOpenClick = (d) => {
    openDeviceDashboard(d);
  };

  const handleCreateDevice = async (e) => {
    e.preventDefault();
    setCreateNotify(null);
    if (!selectedDeviceTemplate) {
      setCreateNotify({
        type: 'error',
        message: 'Debe elegir una plantilla. Use «Cambiar plantilla» o vuelva atrás para seleccionarla.',
      });
      return;
    }
    if (!sensorFormValid.ok) {
      setCreateNotify({
        type: 'error',
        message: sensorFormValid.errors.join(' '),
      });
      return;
    }
    const { devHex, appEui, appKey } = sensorFormValid;
    const name = createForm.displayName.trim();
    const tagStr = createForm.tag.trim();
    setSavingDevice(true);
    try {
      const idNorm = String(devHex || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      const alreadyListed =
        idNorm.length === 16 &&
        devices.some((d) => String(d.deviceId || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() === idNorm);
      if (alreadyListed) {
        const dup = getDuplicateEntityNotice('DEVICE_EXISTS');
        setCreateNotify({
          type: 'warning',
          title: dup.title,
          message: dup.body,
        });
        return;
      }

      const created = await registerUserDevice({
        deviceId: devHex,
        displayName: name,
        devEUI: devHex,
        appEUI: appEui,
        appKey: appKey,
        tag: tagStr,
        productModel: productModelLabelFromTemplate(selectedDeviceTemplate),
        notes: '',
        lorawanClass: normalizeTemplateLorawanClass(selectedDeviceTemplate.lorawanClass),
      });

      const tplPm = productModelLabelFromTemplate(selectedDeviceTemplate);

      let templateApplyWarning = '';
      try {
        await persistTemplateForDeviceId(devHex, selectedDeviceTemplate, saveDeviceDecodeConfig);
      } catch (applyErr) {
        console.warn('[DeviceList] apply template after create:', applyErr);
        const apiDetail =
          applyErr?.response?.data?.errMsg ||
          applyErr?.response?.data?.error ||
          applyErr?.message ||
          '';
        templateApplyWarning = apiDetail
          ? `Dispositivo creado, pero al aplicar la plantilla:\n\n${apiDetail}\n\nEl decoder y el FPort pueden haberse guardado ya; en Plantillas use «Propagar a vinculados» o revise permisos (decode en servidor).`
          : 'Dispositivo creado, pero no se pudo aplicar la plantilla por completo (decoder, puerto o downlinks). Revise permisos o en Plantillas «Propagar a vinculados».';
      }

      if (typeof onListSearchQueryChange === 'function') {
        onListSearchQueryChange('');
      }

      const idStr = String(created?.deviceId || devHex).trim();
      const display = String(created?.displayName || name || idStr).trim();
      const deuiNorm = String(created?.devEUI || devHex || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase();
      const pm = String(created?.productModel || tplPm || '').trim() || tplPm;

      const baseRow = {
        deviceId: idStr,
        name: display,
        sn: deuiNorm.length === 16 ? deuiNorm : idStr,
        model: pm,
        productModel: pm,
        connectStatus: 'Sin telemetría',
        registeredOnly: true,
        registered: true,
        lastUpdateTime: null,
        devEUI: deuiNorm.length === 16 ? deuiNorm : undefined,
        tag: tagStr,
      };
      if (isSuperAdmin) {
        baseRow.superadminGlobalView = true;
        if (user?.email) {
          baseRow.assignments = [
            {
              email: user.email,
              role: user.role,
              displayName: user.profileName || user.email,
            },
          ];
        }
      }
      const createdRowForList = applyStaleOfflineConnectStatus(baseRow);

      setDevices((prev) => {
        if (prev.some((d) => String(d.deviceId).toLowerCase() === idStr.toLowerCase())) return prev;
        const next = [...prev, createdRowForList];
        next.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));
        return next;
      });

      setShowCreateDevice(false);
      setCreateDeviceStep('pickTemplate');
      setSelectedDeviceTemplate(null);
      setTemplatePickQuery('');
      setCreateForm(EMPTY_CREATE);
      setCreateNotify(null);

      const { ok: listOk, error: listErr } = await loadDevices({
        silent: true,
        softFail: true,
        ensureRows: [createdRowForList],
      });
      const alertParts = [];
      if (!listOk && listErr) {
        alertParts.push(
          `${listErr}\n\nNo se pudo volver a cargar la lista desde el servidor. La tabla puede mostrar el alta reciente de forma local; recargue la página (F5) para sincronizar.`
        );
      }
      if (templateApplyWarning) alertParts.push(templateApplyWarning);
      if (alertParts.length) setBlockingAlert(alertParts.join('\n\n—\n\n'));
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const code = data?.code;
      const errText = String(data?.error || data?.errMsg || data?.message || err.message || '');
      const treatAsDeviceExists =
        code === 'DEVICE_EXISTS' ||
        (status === 409 &&
          /ya existe|duplicar|no se puede duplicar|ya está registrado en su cuenta/i.test(errText));
      const msg = errText || t('common.error');
      if (treatAsDeviceExists) {
        const dup = getDuplicateEntityNotice('DEVICE_EXISTS');
        setCreateNotify({
          type: 'warning',
          title: dup.title,
          message: dup.body,
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
      setBlockingAlert('Busca y selecciona un usuario de la lista.');
      return;
    }
    setSavingDevice(true);
    try {
      const did = String(assignForDevice.deviceId || '').trim();
      const uid = String((user && user.id) || (userProfile && userProfile.id) || '').trim();
      if (did && uid) {
        const bundle = collectDeviceBsdBundle(did);
        if (!deviceBsdBundleIsEmpty(bundle)) {
          try {
            const resp = await putDeviceBsdPreferences(did, bundle);
            const at = resp?.updatedAt != null ? String(resp.updatedAt) : '';
            if (at) {
              try {
                localStorage.setItem(`sycom_bsd_remote_rev_${uid}_${did}`, at);
              } catch {
                /* ignore */
              }
            }
          } catch (e) {
            console.warn('[DeviceList] No se pudieron guardar preferencias BSD antes de asignar:', e?.message || e);
          }
        }
      }
      await assignDeviceToUser(assignForDevice.deviceId, assignSelectedUser.email.trim().toLowerCase());
      setAssignForDevice(null);
      setAssignSelectedUser(null);
      setAssignSearch('');
      await loadDevices();
    } catch (err) {
      setBlockingAlert(err.response?.data?.error || err.message || t('common.error'));
    } finally {
      setSavingDevice(false);
    }
  };

  const closeCreateDeviceModal = () => {
    if (savingDevice) return;
    setShowCreateDevice(false);
    setCreateDeviceStep('pickTemplate');
    setSelectedDeviceTemplate(null);
    setTemplatePickQuery('');
    setCreateNotify(null);
    setCreateForm(EMPTY_CREATE);
  };

  const executeRenewLicense = async (d) => {
    if (!d || renewingLicenseId) return;
    setRenewingLicenseId(d.deviceId);
    try {
      await renewDeviceLicense(d.deviceId);
      await loadDevices();
    } catch (err) {
      setBlockingAlert(err.response?.data?.error || err.message || t('common.error'));
    } finally {
      setRenewingLicenseId(null);
    }
  };

  const executePurgeDevice = async (d) => {
    if (!d) return;
    try {
      await purgeDeviceFromSystem(d.deviceId);
      await loadDevices();
    } catch (err) {
      setBlockingAlert(err.response?.data?.error || err.message || t('common.error'));
    }
  };

  if (loading) return <div className="loading-state"><Loader className="spin" /> {t('common.loading')}</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div className="device-list-page device-list-page--premium">
      <CenteredAlertModal
        open={Boolean(blockingAlert)}
        message={blockingAlert || ''}
        onClose={() => setBlockingAlert(null)}
      />
      <CenteredAlertModal
        open={Boolean(purgeConfirmDevice)}
        title="Eliminar dispositivo"
        variant="error"
        message={
          purgeConfirmDevice
            ? `¿Está seguro de que desea **eliminar** el dispositivo de forma definitiva?\n\nSe borrarán telemetría, asignaciones y tableros. **Esta acción no se puede deshacer.**\n\n**Dispositivo:** ${purgeConfirmDevice.name || purgeConfirmDevice.deviceId}`
            : ''
        }
        cancelLabel="Cancelar"
        confirmLabel="Sí, eliminar"
        confirmDanger
        onClose={() => setPurgeConfirmDevice(null)}
        onConfirm={() => executePurgeDevice(purgeConfirmDevice)}
      />
      <CenteredAlertModal
        open={Boolean(licenseRenewConfirmDevice)}
        title="Renovación de licencia"
        variant="info"
        message={
          licenseRenewConfirmDevice
            ? `¿Confirma **renovar la licencia** del dispositivo?\n\nSe añadirá un año de vigencia desde la fecha de vencimiento actual (o desde hoy si la licencia ya venció).\n\n**Dispositivo:** ${licenseRenewConfirmDevice.name || licenseRenewConfirmDevice.deviceId}`
            : ''
        }
        cancelLabel="Cancelar"
        confirmLabel="Sí, renovar"
        onClose={() => setLicenseRenewConfirmDevice(null)}
        onConfirm={() => executeRenewLicense(licenseRenewConfirmDevice)}
      />
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            {t('devices.title')} (
            {listSearchQuery.trim()
              ? `${filteredDevices.length} de ${devices.length}`
              : devices.length}
            )
          </h1>
        </div>
      </div>

      <div className="table-container glass card">
        <div className="device-list-card-toolbar">
          <h2 className="device-list-card-toolbar__title">
            {t('devices.title')} (
            {listSearchQuery.trim()
              ? `${filteredDevices.length} de ${devices.length}`
              : devices.length}
            )
          </h2>
          <div className="device-list-card-toolbar__actions">
            {typeof onListSearchQueryChange === 'function' && (
              <label className="device-list-search-shimmer">
                <Search size={18} className="device-list-search-shimmer__icon" strokeWidth={2} aria-hidden />
                <input
                  id="device-list-card-search"
                  name="device-list-card-search"
                  type="search"
                  className="device-list-search-shimmer__input"
                  placeholder="Modelo, nombre o etiqueta…"
                  value={listSearchQuery}
                  onChange={(e) => onListSearchQueryChange(e.target.value)}
                  aria-label="Filtrar dispositivos por modelo, nombre o etiqueta"
                  autoComplete="off"
                />
              </label>
            )}
            {canCreateDevices && (
              <button
                type="button"
                className="btn btn-primary device-create-top-btn"
                onClick={() => {
                  setCreateForm(EMPTY_CREATE);
                  setSelectedDeviceTemplate(null);
                  setCreateDeviceStep('pickTemplate');
                  setTemplatePickQuery('');
                  setCreateNotify(null);
                  setShowCreateDevice(true);
                }}
              >
                <Plus size={18} /> Crear nuevo dispositivo
              </button>
            )}
          </div>
        </div>
        <div className="device-table-scroll">
        <table className="device-table">
          <thead>
            <tr>
              <th>{t('devices.name')}</th>
              <th>{t('devices.model')}</th>
              <th>{t('devices.tag')}</th>
              <th>{t('devices.status')}</th>
              <th>{powerColumnLabel}</th>
              <th>{t('devices.last_seen')}</th>
              <th>Vencimiento</th>
              <th className="device-actions-col" scope="col">
                <div className="device-actions-head">
                  <span className="device-actions-head-label">Acciones</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredDevices.length === 0 && devices.length > 0 && (
              <tr>
                <td colSpan={8} className="device-table-empty-filter">
                  No hay dispositivos que coincidan con «{listSearchQuery.trim()}». Prueba con modelo, nombre o etiqueta.
                </td>
              </tr>
            )}
            {deviceListPagination.paginatedDevices.map((device) => {
              const lic = licenseExpiryDisplay(device);
              const visuallyOnline = isDeviceVisuallyOnline(device);
              const power = formatDevicePowerCell(device);
              return (
              <tr key={device.deviceId}>
                <td>
                  <div className="device-name-cell clickable" onClick={() => onDeviceNameOrOpenClick(device)}>
                    <span className="name">{device.name || t('devices.unnamed')}</span>
                    <span className="sn">{device.sn}</span>
                  </div>
                </td>
                <td>
                  <span className="model-badge">
                    {String(device.model || device.deviceType || '')
                      .trim() || '—'}
                  </span>
                </td>
                <td>
                  <span className="device-list-tag" title={device.tag || ''}>
                    {String(device.tag || '').trim() || '—'}
                  </span>
                </td>
                <td>
                  <div className="status-cell">
                    <span className={`status-dot ${visuallyOnline ? 'online' : 'offline'}`}></span>
                    {visuallyOnline ? t('devices.online') : t('devices.offline')}
                  </div>
                </td>
                <td>
                  <div className="battery-cell">
                    {power.mode === 'voltage' ? <Zap size={14} aria-hidden /> : <Battery size={14} aria-hidden />}
                    {power.text}
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
                <td className="device-actions-col">
                  <div className="actions">
                    {showDeviceRowActions && (
                      <div className="device-row-actions-icons" role="group" aria-label="Acciones del dispositivo">
                        {isSuperAdmin && (
                          <button
                            type="button"
                            className="btn btn-accent super-license-renew device-actions-license-btn device-actions-license-inline"
                            title="Añade un año de vigencia desde la fecha de vencimiento actual (o desde hoy si ya venció)"
                            disabled={
                              renewingLicenseId === device.deviceId ||
                              licenseRenewConfirmDevice?.deviceId === device.deviceId
                            }
                            onClick={() => setLicenseRenewConfirmDevice(device)}
                          >
                            {renewingLicenseId === device.deviceId ? (
                              <Loader className="spin" size={16} />
                            ) : (
                              <RefreshCw size={16} />
                            )}
                            Renovación de licencia
                          </button>
                        )}
                        {hasNavPage('Devices') && (
                          <>
                        <button
                          type="button"
                          className="device-action-pill"
                          title="Editar"
                          aria-label="Editar"
                          onClick={() => {
                            setActiveDevice(device);
                            setModalType('edit');
                          }}
                        >
                          <Edit2 size={18} strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          className="device-action-pill"
                          title="Datos"
                          aria-label="Datos"
                          onClick={() => {
                            setActiveDataDevice(device);
                            setShowDataModal(true);
                          }}
                        >
                          <Database size={18} strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          className="device-action-pill"
                          title="Downlink"
                          aria-label="Downlink"
                          onClick={() => {
                            setActiveDevice(device);
                            setModalType('downlink');
                          }}
                        >
                          <Play size={18} strokeWidth={2} />
                        </button>
                          </>
                        )}
                        {canAssignDevice && (
                        <button
                          type="button"
                          className="device-action-pill"
                          title="Asignar dispositivo"
                          aria-label="Asignar dispositivo"
                          onClick={() => openAssignModal(device)}
                        >
                          <UserPlus size={18} strokeWidth={2} />
                        </button>
                        )}
                        {isSuperAdmin && (
                          <button
                            type="button"
                            className="device-action-pill device-action-pill--danger"
                            title="Eliminar del sistema"
                            aria-label="Eliminar del sistema"
                            disabled={purgeConfirmDevice?.deviceId === device.deviceId}
                            onClick={() => setPurgeConfirmDevice(device)}
                          >
                            <Trash2 size={18} strokeWidth={2} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
            })}
          </tbody>
        </table>
        </div>
        {filteredDevices.length > 0 && (
          <div className="device-table-pagination" role="navigation" aria-label="Paginación del listado de dispositivos">
            <div className="device-table-pagination__left">
              <label className="device-table-pagination__label" htmlFor="device-page-size">
                Por página
              </label>
              <select
                id="device-page-size"
                name="device-page-size"
                className="device-table-pagination__select glass"
                value={devicePageSize}
                onChange={(e) => setDevicePageSize(Number(e.target.value))}
              >
                {DEVICE_PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="device-table-pagination__range">
                {deviceListPagination.rangeStart}–{deviceListPagination.rangeEnd} de {filteredDevices.length}
              </span>
            </div>
            <div className="device-table-pagination__right">
              <button
                type="button"
                className="device-table-pagination__nav btn-icon"
                aria-label="Página anterior"
                disabled={deviceListPagination.safePage <= 1}
                onClick={() => setDeviceTablePage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft size={20} />
              </button>
              <div className="device-table-pagination__pages">
                {deviceListPagination.pageButtons.map((p, idx) =>
                  p === null ? (
                    <span key={`e-${idx}`} className="device-table-pagination__ellipsis" aria-hidden>
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      className={`device-table-pagination__page${p === deviceListPagination.safePage ? ' is-active' : ''}`}
                      aria-label={`Página ${p}`}
                      aria-current={p === deviceListPagination.safePage ? 'page' : undefined}
                      onClick={() => setDeviceTablePage(p)}
                    >
                      {p}
                    </button>
                  )
                )}
              </div>
              <button
                type="button"
                className="device-table-pagination__nav btn-icon"
                aria-label="Página siguiente"
                disabled={deviceListPagination.safePage >= deviceListPagination.totalPages}
                onClick={() =>
                  setDeviceTablePage((p) =>
                    Math.min(Math.max(1, Math.ceil(filteredDevices.length / devicePageSize) || 1), p + 1)
                  )
                }
              >
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modals persistentes */}
      {showDataModal && activeDataDevice && (
        <DeviceDataModal 
          device={activeDataDevice} 
          onClose={() => {
            setShowDataModal(false);
            setActiveDataDevice(null);
          }} 
        />
      )}

      {modalType && activeDevice && (
        <DeviceActionsModal
          type={modalType}
          device={activeDevice}
          onClose={() => {
            setModalType(null);
            setActiveDevice(null);
          }}
          onSave={handleSaveDeviceEdit}
          onSend={handleSendDownlink}
        />
      )}

      {showDashboard && activeDevice && (
        <DeviceDashboardModal
          device={activeDevice}
          onClose={() => {
            setShowDashboard(false);
            setActiveDevice(null);
          }}
          onSendDownlink={handleSendDownlink}
        />
      )}

      {showCreateDevice && (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !savingDevice) closeCreateDeviceModal();
          }}
        >
          <div
            className={`modal-content glass device-create-modal ${createDeviceStep === 'form' ? 'device-create-modal--wide' : 'device-create-modal--chooser'}`}
            role="dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>
                {createDeviceStep === 'pickTemplate' && 'Elegir plantilla'}
                {createDeviceStep === 'form' && 'Crear nuevo dispositivo'}
              </h2>
              <button type="button" className="btn-icon" onClick={closeCreateDeviceModal} aria-label="Cerrar" disabled={savingDevice}>
                <X size={20} />
              </button>
            </div>

            {createDeviceStep === 'pickTemplate' && (
              <div className="device-create-pick-template">
                <p className="device-create-hint device-create-hint--tight">
                  Busca por <strong>modelo</strong> o <strong>marca</strong>. Las plantillas se gestionan en el menú <strong>Plantillas</strong>.
                </p>
                <input
                  id="device-create-template-filter"
                  name="device-create-template-filter"
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
                          setCreateForm((prev) => ({
                            ...prev,
                            ...mergeOtaaFromTemplateIntoCreateForm(tpl, prev),
                          }));
                          setCreateDeviceStep('form');
                        }}
                      >
                        <span className="device-template-pick-model">{tpl.modelo}</span>
                        <span className="device-template-pick-brand">{tpl.marca}</span>
                        <span className="device-template-pick-meta">
                          Puerto {tpl.channel || '—'} · {lorawanClassOptionLabel(tpl.lorawanClass)} ·{' '}
                          {tpl.downlinks?.length || 0} downlink(s)
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="modal-footer device-create-pick-footer">
                  <button type="button" className="btn btn-secondary" onClick={closeCreateDeviceModal}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {createDeviceStep === 'form' && selectedDeviceTemplate && (
              <>
                <div className="device-create-template-banner glass">
                  Plantilla: <strong>{selectedDeviceTemplate.modelo}</strong> · {selectedDeviceTemplate.marca} — al guardar: decoder,
                  puerto y {lorawanClassOptionLabel(selectedDeviceTemplate.lorawanClass)} (servidor). El AppEUI/AppKey del formulario son los que
                  se guardan en el alta. {selectedDeviceTemplate.downlinks?.length || 0} downlink(s) en este navegador.
                  <button
                    type="button"
                    className="btn btn-secondary device-create-template-change"
                    onClick={() => setCreateDeviceStep('pickTemplate')}
                  >
                    Cambiar plantilla
                  </button>
                </div>
                <p className="device-create-hint">
                  Registro LoRaWAN (OTAA): campos marcados obligatorios; el identificador interno es el DevEUI. Tras el
                  alta, el dispositivo debe completar <strong>Join</strong> por radio con AppEUI/AppKey indicados. Si el
                  AppKey es el predeterminado reciente Milesight (DevEUI repetido dos veces), el servidor asume intención
                  OTAA estándar.
                </p>
                {createNotify && (
                  <FormToast
                    type={createNotify.type}
                    title={createNotify.title}
                    message={createNotify.message}
                    onDismiss={() => setCreateNotify(null)}
                    durationMs={
                      createNotify.type === 'warning' ? 11000 : createNotify.type === 'error' ? 9000 : 4000
                    }
                  />
                )}
                {!sensorFormValid.ok && (
                  <ul className="device-create-validation-hint glass" aria-live="polite">
                    {sensorFormValid.errors.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <form onSubmit={handleCreateDevice} className="device-create-form">
                  <div className="device-create-grid">
                    <label className="device-modal-field" htmlFor="device-create-deveui">
                      <span className="device-modal-label-text">
                        DevEUI <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        id="device-create-deveui"
                        name="device-create-deveui"
                        className={[
                          'glass',
                          'mono',
                          'device-modal-input',
                          'device-modal-input--lg',
                          hexDigitsBorderClass(createForm.devEUI, 16),
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        value={createForm.devEUI}
                        onChange={(e) => setCreateForm({ ...createForm, devEUI: e.target.value })}
                        required
                        placeholder="16 caracteres hex"
                        autoComplete="off"
                      />
                    </label>
                    <label className="device-modal-field" htmlFor="device-create-appeui">
                      <span className="device-modal-label-text">
                        AppEUI (JoinEUI) <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        id="device-create-appeui"
                        name="device-create-appeui"
                        className={[
                          'glass',
                          'mono',
                          'device-modal-input',
                          'device-modal-input--lg',
                          hexDigitsBorderClass(createForm.appEUI, 16),
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        value={createForm.appEUI}
                        onChange={(e) => setCreateForm({ ...createForm, appEUI: e.target.value })}
                        required
                        placeholder="16 caracteres hex"
                        autoComplete="off"
                      />
                    </label>
                    <label className="device-create-span2 device-modal-field" htmlFor="device-create-appkey">
                      <span className="device-modal-label-text">
                        AppKey <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        id="device-create-appkey"
                        name="device-create-appkey"
                        className={[
                          'glass',
                          'mono',
                          'device-modal-input',
                          'device-modal-input--lg',
                          hexDigitsBorderClass(createForm.appKey, 32),
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        value={createForm.appKey}
                        onChange={(e) => setCreateForm({ ...createForm, appKey: e.target.value })}
                        required
                        placeholder="32 caracteres hex"
                        autoComplete="off"
                      />
                    </label>
                    <label className="device-modal-field" htmlFor="device-create-displayname">
                      <span className="device-modal-label-text">
                        Nombre del dispositivo <span className="req" aria-hidden="true">*</span>
                      </span>
                      <input
                        id="device-create-displayname"
                        name="device-create-displayname"
                        className={[
                          'glass',
                          'device-modal-input',
                          'device-modal-input--lg',
                          requiredTrimBorderClass(createForm.displayName),
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        value={createForm.displayName}
                        onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                        required
                        placeholder="Nombre visible"
                      />
                    </label>
                    <label className="device-modal-field" htmlFor="device-create-tag">
                      <span className="device-modal-label-text">Etiqueta (identificación)</span>
                      <input
                        id="device-create-tag"
                        name="device-create-tag"
                        className="glass device-modal-input device-modal-input--lg"
                        value={createForm.tag}
                        onChange={(e) => setCreateForm({ ...createForm, tag: e.target.value })}
                        placeholder="Ej. sitio, edificio, cliente"
                      />
                    </label>
                  </div>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={savingDevice}
                      onClick={() => setCreateDeviceStep('pickTemplate')}
                    >
                      ← Atrás
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={savingDevice || !selectedDeviceTemplate}
                    >
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
        <div
          className="modal-overlay um-modal-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !savingDevice) setAssignForDevice(null);
          }}
        >
          <div
            className="modal-content glass um-modal-shell device-assign-modal"
            role="dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Asignar dispositivo</h2>
              <button
                type="button"
                className="btn-icon um-modal-close"
                onClick={() => !savingDevice && setAssignForDevice(null)}
                aria-label="Cerrar"
              >
                <X size={20} />
              </button>
            </div>
            <p className="um-modal-hint device-assign-modal-hint">
              Dispositivo: <strong>{assignForDevice.name || assignForDevice.deviceId}</strong>. Busca por correo o nombre y selecciona un usuario.
              El dispositivo aparecerá en su cuenta al confirmar.
            </p>
            <form onSubmit={handleAssignConfirm} className="device-create-form device-assign-modal-form">
              <label className="device-modal-field device-assign-search-field" htmlFor="device-assign-user-search">
                <span className="device-modal-label-text">Buscar usuario</span>
                <input
                  id="device-assign-user-search"
                  name="device-assign-user-search"
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
                        {u.profileName || '—'} · {u.role === 'superadmin' ? 'Super admin' : 'Usuario'}
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
    </div>
  );
};

export default DeviceList;
