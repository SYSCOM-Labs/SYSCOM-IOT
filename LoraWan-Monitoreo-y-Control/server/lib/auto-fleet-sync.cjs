'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDownlinkDeviceClassForLns, normalizeDeviceClass } = require('./resolve-downlink-class.cjs');
const { remapWs501LegacyDownlinkHex, remapWs501DownlinkList } = require('./ws501-downlink-legacy.cjs');
const { sanitizeTemplateCatalogEntry, sanitizeTemplatesCatalog } = require('./template-catalog-normalize.cjs');

const ROOT = path.join(__dirname, '..', '..');

function envFlag(name, defaultOn) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultOn;
  const v = String(raw).trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function autoRegisterGatewayEnabled() {
  return envFlag('SYSCOM_LNS_AUTO_REGISTER_GATEWAY', true);
}

function autoSyncDeviceTemplateEnabled() {
  return envFlag('SYSCOM_AUTO_SYNC_DEVICE_TEMPLATE', true);
}

function autoSyncDecoderEnabled() {
  return envFlag('SYSCOM_AUTO_SYNC_DECODER', true);
}

/** Replica dispositivos/gateways entre varias cuentas superadmin (desactivado por defecto: evita duplicados en BD). */
function superadminPoolMirrorEnabled() {
  return envFlag('SYSCOM_SUPERADMIN_POOL_MIRROR', false);
}

function autoReconcileFleetOnStartEnabled() {
  return envFlag('SYSCOM_AUTO_RECONCILE_FLEET_ON_START', true);
}

function defaultGatewayBand() {
  const b = process.env.SYSCOM_LNS_AUTO_GATEWAY_FREQUENCY_BAND;
  return b != null && String(b).trim() ? String(b).trim().slice(0, 64) : 'US902-928';
}

function normalizeDownlinks(arr, productModelOrModelo) {
  const base = (Array.isArray(arr) ? arr : [])
    .map((d) => ({
      name: String(d?.name || '').trim(),
      hex: String(d?.hex || '')
        .trim()
        .replace(/\s/g, '')
        .toLowerCase()
        .replace(/^0x/, ''),
    }))
    .filter((d) => d.name && d.hex && d.hex.length % 2 === 0);
  return remapWs501DownlinkList(base, productModelOrModelo);
}

function extractDecoderFromJsExport(fileRel, exportName) {
  try {
    const p = path.join(ROOT, 'src', 'constants', fileRel);
    const raw = fs.readFileSync(p, 'utf8');
    const re = new RegExp(`export const ${exportName} = \`([\\s\\S]*?)\`;`);
    const m = raw.match(re);
    return m && m[1] ? String(m[1]).trim() : '';
  } catch {
    return '';
  }
}

/** Catálogo mínimo si SQLite aún no tiene plantillas publicadas por superadmin. */
function builtinCatalogTemplates() {
  const ws501Decoder = extractDecoderFromJsExport('ws501DecoderScript.js', 'WS501_DECODER_SCRIPT');
  const wt201Decoder = extractDecoderFromJsExport('wt201DecoderScript.js', 'WT201_DECODER_SCRIPT');
  return [
    {
      id: 'tpl_builtin_ws501',
      modelo: 'WS501',
      marca: 'Milesight',
      channel: '85',
      lorawanClass: 'C',
      decoderScript: ws501Decoder,
      downlinks: normalizeDownlinks([
        { name: 'Encender', hex: '0811ff' },
        { name: 'Apagar', hex: '0810ff' },
        { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
        { name: 'Consultar estado eléctrico', hex: 'ff28ff' },
      ]),
    },
    {
      id: 'tpl_builtin_wt201',
      modelo: 'WT201',
      marca: 'Milesight',
      channel: '85',
      lorawanClass: 'C',
      decoderScript: wt201Decoder,
      downlinks: normalizeDownlinks([
        { name: 'Encender (control temperatura)', hex: 'ffc501' },
        { name: 'Apagar (control temperatura)', hex: 'ffc500' },
        { name: 'Consigna 22 °C (auto)', hex: 'ffb70316' },
        { name: 'Consigna 23 °C (auto)', hex: 'ffb70317' },
        { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
        { name: 'Consultar estado', hex: 'ff28ff' },
      ]),
    },
  ];
}

function listCatalogTemplates(store) {
  const cat = store.getDeviceTemplatesCatalog();
  const fromDb = Array.isArray(cat.templates) ? cat.templates : [];
  if (fromDb.length) return fromDb;
  return builtinCatalogTemplates();
}

function productModelLabel(template) {
  const modelo = String(template.modelo || '').trim();
  const marca = String(template.marca || '').trim();
  if (marca && modelo) return `${marca} · ${modelo}`;
  return modelo || marca || '';
}

function matchTemplateForDevice(store, deviceId, ud) {
  const templates = listCatalogTemplates(store);
  const presets = store.getDeviceSharedPresetsParsed(deviceId);
  const tid =
    presets && presets.catalogTemplateId != null && String(presets.catalogTemplateId).trim()
      ? String(presets.catalogTemplateId).trim()
      : '';
  if (tid) {
    const byId = templates.find((t) => String(t.id || '').trim() === tid);
    if (byId) return byId;
  }
  const cfg = store.getDeviceDecodeConfig(String(deviceId));
  const pm = String(
    ud?.productModel || cfg?.productModel || ud?.model || ''
  ).toUpperCase();
  for (const t of templates) {
    const modelo = String(t.modelo || '').trim().toUpperCase();
    if (modelo && pm.includes(modelo)) return t;
  }
  const cat = store.getDeviceTemplatesCatalog();
  const defId =
    cat.defaultTemplateId != null && String(cat.defaultTemplateId).trim()
      ? String(cat.defaultTemplateId).trim()
      : '';
  if (defId) {
    const def = templates.find((t) => String(t.id || '').trim() === defId);
    if (def) return def;
  }
  return null;
}

/**
 * Alta automática de gateway al primer PUSH/PULL (UG65, UG63, futuros).
 * @returns {string[]} userIds que pueden procesar el gateway
 */
function ensureGatewaysAutoRegistered(store, mac8) {
  let userIds =
    typeof store.findUserIdsForSemtechPush === 'function'
      ? store.findUserIdsForSemtechPush(mac8)
      : store.findUserIdsBySemtechGatewayMac8(mac8);
  if (!autoRegisterGatewayEnabled()) return userIds;
  const eui16 = store.lnsResolveGatewayEuiNorm(mac8);
  if (!eui16 || eui16.length !== 16) return userIds;

  const defUid = process.env.SYSCOM_LNS_DEFAULT_USER_ID;
  const targets = new Set();
  const allSuper =
    String(process.env.SYSCOM_LNS_AUTO_REGISTER_ALL_SUPERADMINS || '0').trim() === '1';
  if (defUid != null && String(defUid).trim()) {
    targets.add(String(defUid).trim());
  } else if (!allSuper) {
    const supers = store.listSuperadminUserIds();
    if (supers.length > 0) targets.add(String(supers[0]));
  }
  if (allSuper) {
    for (const sid of store.listSuperadminUserIds()) targets.add(String(sid));
  }

  const band = defaultGatewayBand();
  const nowIso = new Date().toISOString();
  let created = false;
  for (const uid of targets) {
    if (store.lorawanGatewayExists(uid, eui16)) continue;
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      userId: uid,
      name: `GW auto ${eui16.slice(-8).toUpperCase()}`,
      gatewayEui: eui16,
      frequencyBand: band,
      createdAt: nowIso,
    };
    store.insertLorawanGateway(row);
    if (
      superadminPoolMirrorEnabled() &&
      typeof store.mirrorLorawanGatewayToSuperadminPool === 'function'
    ) {
      store.mirrorLorawanGatewayToSuperadminPool(row);
    }
    created = true;
    console.log('[LNS] Gateway auto-registrado:', eui16, 'user=', uid, 'band=', band);
  }
  if (created) {
    userIds =
      typeof store.findUserIdsForSemtechPush === 'function'
        ? store.findUserIdsForSemtechPush(mac8)
        : store.findUserIdsBySemtechGatewayMac8(mac8);
  }
  return userIds;
}

/**
 * Aplica plantilla del catálogo (decoder, FPort, clase, downlinks en servidor).
 * @returns {{ applied: boolean, templateId?: string, modelo?: string }}
 */
function syncDeviceTemplateFromCatalog(store, deviceId, ud, userId) {
  if (!autoSyncDeviceTemplateEnabled() || !deviceId) return { applied: false };
  const did = String(deviceId).trim();
  const template = matchTemplateForDevice(store, did, ud);
  if (!template) return { applied: false };

  const sanitized = sanitizeTemplateCatalogEntry(template);
  const modelo = String(sanitized.modelo || '').trim();
  const pm = productModelLabel(sanitized);
  const cls = normalizeDeviceClass(sanitized.lorawanClass || 'A');
  const channel = sanitized.channel != null ? String(sanitized.channel).trim() : '85';
  const existing = store.getDeviceDecodeConfig(did);
  const scriptInTpl =
    sanitized.decoderScript != null && String(sanitized.decoderScript).trim().length > 0
      ? String(sanitized.decoderScript)
      : '';
  const scriptExisting =
    existing && existing.decoderScript != null && String(existing.decoderScript).trim().length > 0
      ? String(existing.decoderScript)
      : '';
  const useScript =
    autoSyncDecoderEnabled() && scriptInTpl
      ? scriptInTpl
      : scriptExisting || (autoSyncDecoderEnabled() ? scriptInTpl : '');

  store.setDeviceDecodeConfig(did, useScript, channel, cls, pm);

  const downlinks = normalizeDownlinks(sanitized.downlinks, pm);
  store.setDeviceSharedPresetsParsed(did, {
    downlinks,
    catalogTemplateId: String(template.id || '').trim() || null,
    telemetryLabels:
      template.telemetryLabels && typeof template.telemetryLabels === 'object'
        ? template.telemetryLabels
        : {},
  });

  if (ud && userId) {
    const deui = String(ud.devEUI || ud.devEui || did)
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (ud.productModel !== pm || ud.lorawanClass !== cls) {
      store.upsertUserDevice({
        ...ud,
        productModel: pm,
        lorawanClass: cls,
        updatedAt: new Date().toISOString(),
      });
      if (
        superadminPoolMirrorEnabled() &&
        typeof store.syncUserDeviceToSuperadminPool === 'function'
      ) {
        store.syncUserDeviceToSuperadminPool(store.getUserDevice(userId, did) || ud);
      }
    }
    if (deui.length === 16) {
      store.lnsSyncSessionDeviceClass(userId, deui, cls);
      if (superadminPoolMirrorEnabled()) {
        for (const sid of store.listSuperadminUserIds()) {
          if (sid !== userId) store.lnsSyncSessionDeviceClass(sid, deui, cls);
        }
      }
    }
  }

  return { applied: true, templateId: template.id, modelo };
}

/**
 * Alinea decoder, clase, downlinks y sesión LNS con el catálogo (sin duplicar filas).
 * Se ejecuta al arrancar el servidor si SYSCOM_AUTO_RECONCILE_FLEET_ON_START=1.
 */
function reconcileFleetTemplatesOnStartup(store) {
  if (!autoReconcileFleetOnStartEnabled() || !autoSyncDeviceTemplateEnabled()) {
    return { synced: 0, users: 0, catalogFixed: 0 };
  }
  let catalogFixed = 0;
  try {
    const cat = store.getDeviceTemplatesCatalog();
    const raw = Array.isArray(cat.templates) ? cat.templates : [];
    const next = sanitizeTemplatesCatalog(raw);
    const changed = JSON.stringify(raw) !== JSON.stringify(next);
    if (changed && next.length) {
      store.setDeviceTemplatesCatalog({
        templates: next,
        defaultTemplateId: cat.defaultTemplateId,
      });
      catalogFixed = next.length;
      console.log('[Syscom] Catálogo de plantillas normalizado (clase/downlinks WS501):', catalogFixed);
    }
  } catch (e) {
    console.warn('[Syscom] reconcile catalog normalize:', e.message);
  }
  let synced = 0;
  let users = 0;
  const rows = store.db.prepare('SELECT id FROM users').all();
  for (const { id: userId } of rows) {
    const uid = String(userId);
    const devices = store.listUserDevices(uid);
    if (!devices.length) continue;
    users += 1;
    for (const ud of devices) {
      const did = ud && ud.deviceId != null ? String(ud.deviceId).trim() : '';
      if (!did) continue;
      try {
        const r = syncDeviceTemplateFromCatalog(store, did, ud, uid);
        if (r.applied) synced += 1;
      } catch (e) {
        console.warn('[Syscom] reconcileFleetTemplatesOnStartup', did, e.message);
      }
    }
  }
  return { synced, users, catalogFixed };
}

function ensureBuiltinCatalogSeeded(store) {
  if (!envFlag('SYSCOM_AUTO_SEED_TEMPLATE_CATALOG', true)) return false;
  const cat = store.getDeviceTemplatesCatalog();
  if (Array.isArray(cat.templates) && cat.templates.length > 0) return false;
  const templates = builtinCatalogTemplates();
  store.setDeviceTemplatesCatalog({
    templates,
    defaultTemplateId: process.env.SYSCOM_DEFAULT_TEMPLATE_MODEL === 'WT201' ? 'tpl_builtin_wt201' : null,
  });
  console.log('[Syscom] Catálogo de plantillas sembrado en servidor:', templates.map((t) => t.modelo).join(', '));
  return true;
}

module.exports = {
  autoRegisterGatewayEnabled,
  autoSyncDeviceTemplateEnabled,
  superadminPoolMirrorEnabled,
  autoReconcileFleetOnStartEnabled,
  ensureGatewaysAutoRegistered,
  syncDeviceTemplateFromCatalog,
  reconcileFleetTemplatesOnStartup,
  ensureBuiltinCatalogSeeded,
  listCatalogTemplates,
  matchTemplateForDevice,
  normalizeDownlinks,
  resolveDownlinkDeviceClassForLns,
};
