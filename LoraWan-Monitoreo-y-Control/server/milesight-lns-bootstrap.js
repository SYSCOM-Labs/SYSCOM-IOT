/**
 * Sesión LNS automática para Milesight en ABP con valores de fábrica (documentación oficial):
 * - NwkSKey y AppSKey por defecto: 5572404C696E6B4C6F52613230313823
 * - DevAddr por defecto: dígitos 5–12 del número de serie (hex en etiqueta; 8 caracteres hex)
 *
 * No sustituye OTAA: si el nodo ya hizo join en este LNS, no se toca la sesión.
 * Desactivar: SYSCOM_LNS_AUTO_MILESIGHT_ABP=0
 *
 * Si el AppKey guardado es el predeterminado OTAA reciente (DevEUI||DevEUI), se asume intención OTAA
 * y no se inserta sesión ABP (evita fila inútil mientras el nodo aún no ha hecho join).
 */
'use strict';

const MILESIGHT_FACTORY_ABP_NWK_APP_HEX = '5572404c696e6b4c6f52613230313823';
const { isUs915ForUserGateway } = require('./lorawan-us915-region');

function normalizeSerialHex(raw) {
  return String(raw || '').replace(/[^0-9a-fA-F]/gi, '');
}

/**
 * DevAddr ABP Milesight desde SN de etiqueta (hex).
 * - SN ≥ 12 hex: dígitos 5–12 (índices 4–11).
 * - SN de 8 hex: se interpreta como DevAddr completo.
 */
function milesightAbpDevAddrFromSerial(snHexRaw) {
  const h = normalizeSerialHex(snHexRaw);
  if (h.length === 8) return h.toUpperCase();
  if (h.length >= 12) return h.slice(4, 12).toUpperCase();
  return null;
}

function isLikelyMilesightOtaaDefaultAppKey(devEui16, appKey32) {
  const d = String(devEui16 || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const k = String(appKey32 || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (d.length !== 16 || k.length !== 32) return false;
  /** Política Milesight desde ~Q4 2025: AppKey = DevEUI || DevEUI → se asume OTAA, no ABP automático. */
  return k === d + d;
}

/**
 * @param {import('./store')} store
 * @param {string} userId
 * @param {{ devEUI?: string, deviceId?: string, displayName?: string, lorawanClass?: string, appKey?: string }} ud
 * @param {string | undefined} serialRaw SN / número de serie en hex (etiqueta)
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, devAddr?: string, gatewayEui?: string }}
 */
function tryBootstrapMilesightAbpSession(store, userId, ud, serialRaw) {
  if (String(process.env.SYSCOM_LNS_AUTO_MILESIGHT_ABP || '').trim() === '0') {
    return { ok: false, skipped: true, reason: 'disabled_by_env' };
  }
  const deui = String(ud?.devEUI || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length !== 16) return { ok: false, skipped: true, reason: 'bad_dev_eui' };

  const appKey = String(ud?.appKey || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (isLikelyMilesightOtaaDefaultAppKey(deui, appKey)) {
    return { ok: false, skipped: true, reason: 'likely_otaa_default_appkey' };
  }

  const existing = store.lnsGetSessionByDevEui(userId, deui);
  if (existing) return { ok: false, skipped: true, reason: 'session_already_exists' };

  const devAddr = milesightAbpDevAddrFromSerial(serialRaw);
  if (!devAddr || devAddr.length !== 8) {
    return { ok: false, skipped: true, reason: 'serial_missing_or_short' };
  }

  const other = store.lnsGetSessionByDevAddr(userId, devAddr);
  if (other && String(other.devEui).toLowerCase() !== deui) {
    return { ok: false, skipped: true, reason: 'devaddr_in_use_by_other_device' };
  }

  const gws = store.listLorawanGateways(userId);
  const gwNorm =
    gws.length > 0 ? String(gws[0].gatewayEui || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() : '';
  if (gwNorm.length !== 16) {
    return { ok: false, skipped: true, reason: 'no_lorawan_gateway_registered' };
  }

  const gwRow = store.lnsGetGatewayByEui(userId, gwNorm);
  const bandU = gwRow ? String(gwRow.frequencyBand || '').toUpperCase() : '';
  const isUs = isUs915ForUserGateway(bandU);
  const rxDelaySec = isUs ? 5 : 1;
  const clsRaw = String(ud.lorawanClass || ud.lorawan_class || 'A')
    .trim()
    .toUpperCase();
  const deviceClass = clsRaw === 'B' || clsRaw === 'C' ? clsRaw : 'A';
  const lastRxFreq = isUs ? 905.3 : 868.5;
  const lastRxDatr = isUs ? 'SF10BW125' : 'SF12BW125';

  store.lnsUpsertSessionJoin({
    userId,
    devEui: deui,
    devAddr,
    nwkSKeyHex: MILESIGHT_FACTORY_ABP_NWK_APP_HEX,
    appSKeyHex: MILESIGHT_FACTORY_ABP_NWK_APP_HEX,
    lastGatewayEui: gwNorm,
    lastRxTmst: 0,
    lastRxFreq,
    lastRxDatr,
    lastRxCodr: '4/5',
    lastRxRfch: 0,
    deviceClass,
    lastUplinkWallMs: Date.now(),
    classBPingPeriodicity: -1,
    classBDataRate: null,
    rxDelaySec,
    pendingMacAck: false,
  });
  store.lnsSyncSessionDeviceClass(userId, deui, deviceClass);

  const did = String(ud.deviceId || deui).trim();
  const name = String(ud.displayName || did).trim() || did;
  try {
    store.appendTelemetry(userId, did, name, {
      devEUI: deui,
      deviceId: did,
      lorawan_event: 'lns_milesight_abp_auto',
      devAddr,
      connectStatus: 'joined',
      gateway_id: gwNorm,
    }, Date.now());
  } catch {
    /* no bloquear alta */
  }

  console.log(
    '[LNS] Sesión Milesight ABP automática (SN→DevAddr, claves fábrica) dev_eui=',
    deui,
    'devAddr=',
    devAddr,
    'gateway=',
    gwNorm
  );

  return { ok: true, devAddr, gatewayEui: gwNorm };
}

/**
 * Tras registrar el primer gateway: reintenta sesión ABP Milesight para dispositivos
 * que ya tienen SN guardado pero no tenían gateway al darse de alta.
 */
function retryMilesightAbpBootstrapAll(store, userId) {
  const list = store.listUserDevices(userId);
  const summary = { attempted: 0, provisioned: 0, results: [] };
  for (const ud of list) {
    const serial = String(ud.deviceSerialHex || '').replace(/[^0-9a-fA-F]/gi, '');
    if (serial.length < 8) continue;
    summary.attempted += 1;
    const r = tryBootstrapMilesightAbpSession(store, userId, ud, ud.deviceSerialHex || '');
    summary.results.push({ deviceId: ud.deviceId, devEUI: ud.devEUI, ...r });
    if (r.ok) summary.provisioned += 1;
  }
  return summary;
}

module.exports = {
  tryBootstrapMilesightAbpSession,
  retryMilesightAbpBootstrapAll,
  milesightAbpDevAddrFromSerial,
  MILESIGHT_FACTORY_ABP_NWK_APP_HEX,
};
