/**
 * Plantillas de dispositivo (modelo, marca, decoder, downlinks).
 * El **catálogo compartido** vive en SQLite (`server_settings` vía GET/PUT `/api/device-templates`): el superadmin lo publica;
 * el resto de usuarios lo hidrata al cargar la app y ve las mismas plantillas (más semillas integradas).
 * Persistencia local (`localStorage`) sigue como respaldo y caché; downlinks por equipo se replican en `device_shared_presets` (servidor)
 * para que cualquier usuario asignado vea los mismos presets y telemetría en tiempo real (SSE) sin depender del navegador del superadmin.
 * El `decoderScript` y el **channel** (FPort LoRaWAN de aplicación para downlinks; p. ej. 85 en plantillas Milesight)
 * se guardan en el servidor (`device_decode_config`): el script en cada ingesta y el channel al enviar downlinks.
 * **lorawanClass** (A/B/C) se guarda en `device_decode_config` y en `user_devices` / sesión LNS al aplicar la plantilla.
 * Al **guardar** o **importar** plantillas, `pushTemplateToAssignedDevices` vuelca puerto, clase, decoder y downlinks en cada `deviceId`
 * vinculado (`device_template_source_*`). Las credenciales OTAA por dispositivo las define el **alta** (DevEUI / AppEUI / AppKey); en la
 * plantilla pueden guardarse como **sugerencia** para rellenar campos vacíos del formulario, sin PATCH masivo al servidor.
 * HTTP si hay `payload_b64` o `payload_hex`; el JSON decodificado se fusiona con los metadatos LoRaWAN.
 */
import { SEED_DEVICE_TEMPLATES } from '../constants/seedDeviceTemplates';
import { downlinkDeferUntilUplink } from '../utils/lorawanClassBehavior';
import { remapWs501DownlinkList } from '../utils/ws501DownlinkHex';

const STORAGE_KEY = 'device_profile_templates_v1';
/** id de plantilla aplicada automáticamente al crear dispositivos (decoder + downlinks). */
const DEFAULT_TEMPLATE_ID_KEY = 'device_profile_default_template_id_v1';
/**
 * Claves `marca|modelo` (minúsculas) que el usuario eliminó y no deben reinyectarse desde SEED_DEVICE_TEMPLATES.
 * Sin esto, al borrar p. ej. UC512 el merge volvería a crear la plantilla integrada al instante.
 */
const EXCLUDED_BUILTIN_SEEDS_KEY = 'device_profile_excluded_builtin_seeds_v1';

/** Catálogo publicado en servidor (SQLite). Tras hidratar, `getDeviceTemplates()` lo fusiona con semillas integradas. */
let serverTemplatesState = {
  status: 'unknown',
  templates: [],
  defaultTemplateId: null,
  updatedAt: null,
};

const primedDownlinksByNorm = new Map();
const primedCatalogTemplateIdByNorm = new Map();
const primedTelemetryLabelsByNorm = new Map();

function deviceKeyNorm(deviceId) {
  return storageDeviceIdKey(deviceId) || String(deviceId || '').trim().toLowerCase();
}

export function primeDeviceSharedPresetsFromDeviceRows(rows) {
  for (const row of rows || []) {
    const p = row.deviceSharedPresets;
    if (!p || typeof p !== 'object') continue;
    const k = deviceKeyNorm(row.deviceId);
    if (!k) continue;
    if (Array.isArray(p.downlinks) && p.downlinks.length) {
      primedDownlinksByNorm.set(k, normalizeDownlinks(p.downlinks));
    }
    if (p.catalogTemplateId != null && String(p.catalogTemplateId).trim()) {
      primedCatalogTemplateIdByNorm.set(k, String(p.catalogTemplateId).trim());
    }
    const tl = normalizeTelemetryLabelHints(p.telemetryLabels || {});
    if (Object.keys(tl).length) primedTelemetryLabelsByNorm.set(k, tl);
  }
}

export function clearPrimedDeviceSharedPresets() {
  primedDownlinksByNorm.clear();
  primedCatalogTemplateIdByNorm.clear();
  primedTelemetryLabelsByNorm.clear();
}

/**
 * Fusiona catálogos por `id`. `overlay` gana sobre `primary` en ids compartidos;
 * ids solo presentes en `overlay` se conservan (p. ej. importaciones aún no publicadas).
 */
function mergeCatalogTemplatesById(primary, overlay) {
  const byId = new Map();
  for (const t of primary || []) {
    if (!t || t.id == null || String(t.id).trim() === '') continue;
    byId.set(String(t.id).trim(), { ...t });
  }
  for (const t of overlay || []) {
    if (!t || t.id == null || String(t.id).trim() === '') continue;
    byId.set(String(t.id).trim(), { ...t });
  }
  return [...byId.values()];
}

function resolveDefaultTemplateIdFromDoc(doc) {
  if (doc?.defaultTemplateId != null && String(doc.defaultTemplateId).trim()) {
    return String(doc.defaultTemplateId).trim();
  }
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(DEFAULT_TEMPLATE_ID_KEY);
    return v && String(v).trim() ? String(v).trim() : null;
  } catch {
    return null;
  }
}

/** Actualiza catálogo en memoria y localStorage (sin semillas integradas). */
function commitDeviceTemplatesCatalog(list, defaultTemplateId = undefined) {
  const templates = Array.isArray(list) ? list.map((t) => (t && typeof t === 'object' ? { ...t } : {})) : [];
  const def =
    defaultTemplateId === undefined
      ? getDefaultTemplateId()
      : defaultTemplateId == null || String(defaultTemplateId).trim() === ''
        ? null
        : String(defaultTemplateId).trim();
  serverTemplatesState = {
    status: 'loaded',
    templates,
    defaultTemplateId: def,
    updatedAt: serverTemplatesState.updatedAt,
  };
  persistList(templates);
}

/**
 * @param {object} doc respuesta GET /api/device-templates
 */
export function applyServerDeviceTemplatesCatalog(doc) {
  const templates = Array.isArray(doc?.templates) ? doc.templates : [];
  serverTemplatesState = {
    status: 'loaded',
    templates: templates.map((t) => (t && typeof t === 'object' ? { ...t } : {})),
    defaultTemplateId: resolveDefaultTemplateIdFromDoc(doc),
    updatedAt: doc?.updatedAt != null ? String(doc.updatedAt) : null,
  };
}

/**
 * @param {{ syncLocalExtrasToServer?: boolean }} [opts]
 *   Si `syncLocalExtrasToServer`, publica al servidor plantillas que solo existían en localStorage.
 */
export async function hydrateDeviceTemplatesCatalogFromServer(opts = {}) {
  const { fetchDeviceTemplatesCatalog } = await import('./api.js');
  const doc = await fetchDeviceTemplatesCatalog();
  const serverTemplates = Array.isArray(doc?.templates) ? doc.templates : [];
  const localTemplates = loadRaw();
  const serverIds = new Set(
    serverTemplates.map((t) => (t?.id != null ? String(t.id).trim() : '')).filter(Boolean)
  );
  const localOnlyCount = localTemplates.filter(
    (t) => t?.id != null && String(t.id).trim() && !serverIds.has(String(t.id).trim())
  ).length;
  const merged = mergeCatalogTemplatesById(serverTemplates, localTemplates);
  applyServerDeviceTemplatesCatalog({
    ...doc,
    templates: merged,
    defaultTemplateId: resolveDefaultTemplateIdFromDoc(doc),
  });
  persistList(merged);

  if (opts.syncLocalExtrasToServer && localOnlyCount > 0) {
    await flushDeviceTemplatesCatalogToServer();
  }
  return { ...doc, templates: merged };
}

export async function publishLocalCustomTemplatesIfServerEmpty(isSuperAdmin) {
  if (!isSuperAdmin) return false;
  const { fetchDeviceTemplatesCatalog, putDeviceTemplatesCatalog } = await import('./api.js');
  const cat = await fetchDeviceTemplatesCatalog();
  if (Array.isArray(cat.templates) && cat.templates.length > 0) return false;
  const customs = loadRaw().filter((t) => !templateMatchesSeedCatalog(t));
  if (customs.length === 0) return false;
  let def = cat.defaultTemplateId != null && String(cat.defaultTemplateId).trim() ? String(cat.defaultTemplateId).trim() : null;
  if (!def && typeof window !== 'undefined') {
    try {
      const v = localStorage.getItem(DEFAULT_TEMPLATE_ID_KEY);
      if (v && String(v).trim()) def = String(v).trim();
    } catch {
      /* ignore */
    }
  }
  await putDeviceTemplatesCatalog({ templates: customs, defaultTemplateId: def });
  const next = await fetchDeviceTemplatesCatalog();
  applyServerDeviceTemplatesCatalog(next);
  persistList(customs);
  return true;
}

export async function flushDeviceTemplatesCatalogToServer() {
  const templates =
    serverTemplatesState.status === 'loaded'
      ? [...serverTemplatesState.templates]
      : [...loadRaw()];
  const defaultTemplateId = getDefaultTemplateId();
  const { putDeviceTemplatesCatalog } = await import('./api.js');
  const saved = await putDeviceTemplatesCatalog({ templates, defaultTemplateId });
  applyServerDeviceTemplatesCatalog(saved);
  persistList(Array.isArray(saved?.templates) ? saved.templates : templates);
}

function mergeSeedsIntoTemplateList(customList) {
  const list = Array.isArray(customList) ? [...customList] : [];
  const modeloSet = new Set(list.map((t) => (t.modelo || '').trim().toLowerCase()));
  const excludedSeeds = loadExcludedBuiltinSeedKeys();
  const additions = [];
  let salt = 0;
  for (const seed of SEED_DEVICE_TEMPLATES) {
    const m = (seed.modelo || '').trim().toLowerCase();
    if (!m || modeloSet.has(m)) continue;
    if (excludedSeeds.has(seedKeyForSeedEntry(seed))) continue;
    modeloSet.add(m);
    salt += 1;
    additions.push({
      id: `tpl_builtin_${m.replace(/[^a-z0-9]+/g, '_')}_${Date.now()}_${salt}`,
      modelo: seed.modelo.trim(),
      marca: (seed.marca || 'Milesight').trim(),
      channel: String(seed.channel || '1').trim(),
      lorawanClass: normalizeTemplateLorawanClass(seed.lorawanClass),
      decoderScript: String(seed.decoderScript || ''),
      downlinks: normalizeDownlinks(seed.downlinks),
      otaaAppEui: '',
      otaaAppKey: '',
    });
  }
  return [...list, ...additions];
}

function seedCatalogKey(marca, modelo) {
  return `${String(marca || '').trim().toLowerCase()}|${String(modelo || '').trim().toLowerCase()}`;
}

function seedKeyForSeedEntry(seed) {
  return seedCatalogKey(seed.marca || 'Milesight', seed.modelo);
}

export function templateMatchesSeedCatalog(t) {
  const k = seedCatalogKey(t.marca, t.modelo);
  return SEED_DEVICE_TEMPLATES.some((s) => seedKeyForSeedEntry(s) === k);
}

function loadExcludedBuiltinSeedKeys() {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(EXCLUDED_BUILTIN_SEEDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x) => typeof x === 'string' && x.includes('|')));
  } catch {
    return new Set();
  }
}

function rememberExcludedBuiltinSeedKey(key) {
  if (typeof window === 'undefined' || !key) return;
  try {
    const set = loadExcludedBuiltinSeedKeys();
    set.add(key);
    localStorage.setItem(EXCLUDED_BUILTIN_SEEDS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore quota */
  }
}

/** @returns {'A'|'B'|'C'} */
export function normalizeTemplateLorawanClass(raw) {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (s === 'B' || s === 'CLASE B' || s === 'CLASS B') return 'B';
  if (s === 'C' || s === 'CLASE C' || s === 'CLASS C') return 'C';
  return 'A';
}

export function lorawanClassOptionLabel(letter) {
  const k = normalizeTemplateLorawanClass(letter);
  if (k === 'B') return 'Clase B';
  if (k === 'C') return 'Clase C';
  return 'Clase A';
}

/** Texto persistido en servidor (`user_devices.product_model` / `device_decode_config.product_model`). */
export function productModelLabelFromTemplate(tpl) {
  if (!tpl) return '';
  const modelo = String(tpl.modelo || '').trim();
  const marca = String(tpl.marca || '').trim();
  if (marca && modelo) return `${marca} · ${modelo}`;
  return modelo || marca || '';
}

/**
 * Clase LoRaWAN de la plantilla guardada para este `deviceId` en localStorage (tras aplicar plantilla al crear).
 * Sirve para enviar `lorawanClass` en downlinks sin depender solo de la sesión LNS antigua.
 * @returns {'A'|'B'|'C'|null} null si no hay plantilla asociada
 */
/** Si la plantilla en localStorage no trae `lorawanClass` (datos previos al campo), usa el valor del catálogo semilla mismo marca/modelo. */
function seedDefaultLorawanClassForTemplate(t) {
  if (!t) return null;
  const k = seedKeyForSeedEntry({ marca: t.marca, modelo: t.modelo });
  const seed = SEED_DEVICE_TEMPLATES.find((s) => seedKeyForSeedEntry(s) === k);
  if (!seed) return null;
  const lc = seed.lorawanClass;
  if (lc == null || String(lc).trim() === '') return null;
  return String(lc).trim();
}

/**
 * Clase LoRaWAN efectiva desde plantilla (catálogo / id vinculado / modelo de producto).
 * @param {string} deviceId
 * @param {string} [deviceModel]
 * @returns {'A'|'B'|'C'|null}
 */
export function getDownlinkLorawanClassForDevice(deviceId, deviceModel) {
  if (typeof window === 'undefined' || !deviceId) return null;
  const tpl = findTemplateForDevice(deviceId, deviceModel);
  if (!tpl) return null;
  const explicit = tpl.lorawanClass != null && String(tpl.lorawanClass).trim() !== '';
  const raw = explicit ? tpl.lorawanClass : seedDefaultLorawanClassForTemplate(tpl);
  if (raw == null) return null;
  return normalizeTemplateLorawanClass(raw);
}

/**
 * Opciones para POST /devices/:id/downlink según **clase de la plantilla** (C = inmediato, sin esperar uplink).
 * @param {string} deviceId
 * @param {{ lorawanClass?: string, model?: string, productModel?: string }} [deviceRow]
 */
export function getDownlinkSendOptionsForDevice(deviceId, deviceRow) {
  const deviceModel = deviceRow?.productModel || deviceRow?.model || '';
  const fromTpl = getDownlinkLorawanClassForDevice(deviceId, deviceModel);
  const fromRow =
    deviceRow?.lorawanClass != null && String(deviceRow.lorawanClass).trim() !== ''
      ? normalizeTemplateLorawanClass(deviceRow.lorawanClass)
      : null;
  const cls = fromTpl || fromRow;
  return {
    confirmed: false,
    ...(cls ? { lorawanClass: cls } : {}),
    deferUntilUplink: cls ? downlinkDeferUntilUplink(cls) : true,
    priority: 200,
  };
}

const normalizeDownlinks = (arr, productModelOrTpl) => {
  const base = (Array.isArray(arr) ? arr : [])
    .map((d) => ({
      name: String(d?.name || '').trim(),
      hex: String(d?.hex || '').trim().replace(/\s/g, '').toLowerCase().replace(/^0x/, ''),
    }))
    .filter((d) => d.name && d.hex);
  const pm =
    typeof productModelOrTpl === 'string'
      ? productModelOrTpl
      : productModelOrTpl
        ? productModelLabelFromTemplate(productModelOrTpl)
        : '';
  return remapWs501DownlinkList(base, pm);
};

/**
 * Plantilla vinculada al dispositivo (id guardado) o por modelo de producto.
 * @param {string} deviceId
 * @param {string} [deviceModel]
 */
export function findTemplateForDevice(deviceId, deviceModel) {
  const tid = getStoredTemplateIdForDevice(deviceId);
  if (tid) {
    const byId = getDeviceTemplateById(tid);
    if (byId) return byId;
  }
  const pm = String(deviceModel || '').toUpperCase();
  if (!pm) return null;
  return (
    getDeviceTemplates().find((t) => {
      const m = String(t.modelo || '').trim().toUpperCase();
      return m && pm.includes(m);
    }) || null
  );
}

function cacheDownlinksForDevice(deviceId, template, downlinks) {
  if (typeof window === 'undefined' || !deviceId) return;
  const norm = deviceKeyNorm(deviceId);
  const dls = Array.isArray(downlinks) ? downlinks : [];
  try {
    localStorage.setItem(downlinksLocalStorageKey(deviceId), JSON.stringify(dls));
    const tid = template?.id != null ? String(template.id).trim() : '';
    if (tid) localStorage.setItem(templateSourceLocalStorageKey(deviceId), tid);
  } catch {
    /* ignore quota */
  }
  if (norm) {
    primedDownlinksByNorm.set(norm, dls);
    const tid = template?.id != null ? String(template.id).trim() : '';
    if (tid) primedCatalogTemplateIdByNorm.set(norm, tid);
  }
}

/**
 * Downlinks efectivos: **siempre** prioriza la plantilla del catálogo sobre localStorage manual.
 * @param {string} deviceId
 * @param {string} [deviceModel] p. ej. `Milesight · WS501`
 */
export function resolveDownlinksForDevice(deviceId, deviceModel) {
  const tpl = findTemplateForDevice(deviceId, deviceModel);
  if (tpl) {
    const dls = normalizeDownlinks(tpl.downlinks, tpl);
    cacheDownlinksForDevice(deviceId, tpl, dls);
    return dls;
  }
  return readDownlinksFromLocalStorage(deviceId, { deviceModel, preferTemplate: false });
}

/** Mapa campo (minúsculas) → textos para UI (booleanos, enums desde «Ajustar» en plantillas). */
export function normalizeTelemetryLabelHints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const fk = String(k || '').trim().toLowerCase();
    if (!fk) continue;
    if (!v || typeof v !== 'object') continue;
    const trueText = v.trueText != null ? String(v.trueText).trim() : '';
    const falseText = v.falseText != null ? String(v.falseText).trim() : '';
    let valueLabels = null;
    if (v.valueLabels && typeof v.valueLabels === 'object' && !Array.isArray(v.valueLabels)) {
      valueLabels = {};
      for (const [rk, rv] of Object.entries(v.valueLabels)) {
        const lab = rv != null ? String(rv).trim() : '';
        if (lab) valueLabels[String(rk).trim().toLowerCase()] = lab;
      }
      if (!Object.keys(valueLabels).length) valueLabels = null;
    }
    if (!trueText && !falseText && !valueLabels) continue;
    out[fk] = {
      ...(trueText ? { trueText } : {}),
      ...(falseText ? { falseText } : {}),
      ...(valueLabels ? { valueLabels } : {}),
    };
  }
  return out;
}

/**
 * Pistas de etiquetas guardadas en la plantilla vinculada al dispositivo (localStorage).
 * @returns {Record<string, { trueText?: string, falseText?: string }> | null}
 */
export function getTelemetryLabelHintsForDevice(deviceId) {
  if (typeof window === 'undefined' || !deviceId) return null;
  const norm = storageDeviceIdKey(deviceId) || String(deviceId).trim().toLowerCase();
  const tid = getStoredTemplateIdForDevice(deviceId);
  const tpl = getDeviceTemplateById(tid);
  const fromTpl = tpl ? normalizeTelemetryLabelHints(tpl.telemetryLabels) : {};
  const primed = (norm && primedTelemetryLabelsByNorm.get(norm)) || {};
  const merged = { ...fromTpl };
  for (const [fk, vals] of Object.entries(primed)) {
    merged[fk] = { ...(fromTpl[fk] || {}), ...(vals && typeof vals === 'object' ? vals : {}) };
  }
  return Object.keys(merged).length ? merged : null;
}

/** Join EUI (App EUI) y AppKey para OTAA en el LNS; vacíos = no propagar al servidor desde la plantilla. */
export function normalizeOtaaTemplateFields(tpl) {
  const otaaAppEui = String(tpl?.otaaAppEui || tpl?.otaa_app_eui || tpl?.joinEui || tpl?.join_eui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
  const otaaAppKey = String(tpl?.otaaAppKey || tpl?.otaa_app_key || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return { otaaAppEui, otaaAppKey };
}

export function validateOtaaTemplateFields(otaa) {
  const { otaaAppEui, otaaAppKey } = otaa || {};
  if (otaaAppEui && otaaAppEui.length !== 16) {
    throw new Error('Join EUI (App EUI): debe ser 16 caracteres hex (8 bytes) o dejar vacío.');
  }
  if (otaaAppKey && otaaAppKey.length !== 32) {
    throw new Error('AppKey: debe ser 32 caracteres hex (16 bytes) o dejar vacío.');
  }
}

const DEVICE_TEMPLATE_SOURCE_KEY_PREFIX = 'device_template_source_';

/**
 * Clave estable en localStorage (plantilla / downlinks): DevEUI en minúsculas sin separadores no hex.
 */
export function storageDeviceIdKey(deviceId) {
  const s = String(deviceId || '').trim();
  if (!s) return '';
  const onlyHex = s.replace(/[^0-9a-fA-F]/gi, '');
  if (onlyHex.length >= 8 && onlyHex.length === s.replace(/[^0-9a-fA-F]/gi, '').length) {
    return onlyHex.toLowerCase();
  }
  return s.toLowerCase();
}

export function downlinksLocalStorageKey(deviceId) {
  const n = storageDeviceIdKey(deviceId) || String(deviceId || '').trim().toLowerCase();
  return `downlinks_${n}`;
}

/**
 * Lee downlinks (plantilla del catálogo predomina; si no hay plantilla, caché local/servidor).
 * @param {string} deviceId
 * @param {{ deviceModel?: string, preferTemplate?: boolean }} [opts]
 */
export function readDownlinksFromLocalStorage(deviceId, opts = {}) {
  if (typeof window === 'undefined' || !deviceId) return [];
  const preferTemplate = opts.preferTemplate !== false;
  const deviceModel = opts.deviceModel != null ? String(opts.deviceModel) : '';
  if (preferTemplate) {
    const tpl = findTemplateForDevice(deviceId, deviceModel);
    if (tpl) {
      const dls = normalizeDownlinks(tpl.downlinks, tpl);
      cacheDownlinksForDevice(deviceId, tpl, dls);
      return dls;
    }
  }
  const k = storageDeviceIdKey(deviceId) || String(deviceId).trim().toLowerCase();
  if (k && primedDownlinksByNorm.has(k)) {
    return remapWs501DownlinkList([...primedDownlinksByNorm.get(k)], deviceModel);
  }
  try {
    const key = downlinksLocalStorageKey(deviceId);
    let raw = localStorage.getItem(key);
    if (!raw) {
      const leg = `downlinks_${String(deviceId).trim()}`;
      if (leg !== key) raw = localStorage.getItem(leg);
    }
    const list = raw ? JSON.parse(raw) : [];
    const arr = Array.isArray(list) ? list : [];
    return remapWs501DownlinkList(arr, deviceModel);
  } catch {
    return [];
  }
}

function templateSourceLocalStorageKey(deviceId) {
  const n = storageDeviceIdKey(deviceId) || String(deviceId || '').trim().toLowerCase();
  return `${DEVICE_TEMPLATE_SOURCE_KEY_PREFIX}${n}`;
}

/** Id de plantilla usada al dar de alta (vínculo para sincronizar desde Plantillas). */
export function getStoredTemplateIdForDevice(deviceId) {
  if (typeof localStorage === 'undefined' || !deviceId) return null;
  const norm = storageDeviceIdKey(deviceId) || String(deviceId).trim().toLowerCase();
  const primed = norm && primedCatalogTemplateIdByNorm.get(norm);
  if (primed) return primed;
  const kNorm = `${DEVICE_TEMPLATE_SOURCE_KEY_PREFIX}${norm}`;
  try {
    let v = localStorage.getItem(kNorm);
    if (v != null && String(v).trim()) return String(v).trim();
    const prefix = DEVICE_TEMPLATE_SOURCE_KEY_PREFIX;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const suffix = k.slice(prefix.length);
      if (storageDeviceIdKey(suffix) !== norm) continue;
      v = localStorage.getItem(k);
      if (v != null && String(v).trim()) {
        const tid = String(v).trim();
        try {
          if (k !== kNorm) {
            localStorage.setItem(kNorm, tid);
            localStorage.removeItem(k);
          }
        } catch {
          /* ignore quota */
        }
        return tid;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function loadRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistList(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function ensureBuiltinSeedsMerged() {
  if (typeof window === 'undefined') return;
  if (serverTemplatesState.status === 'loaded') return;

  const list = loadRaw();
  const modeloSet = new Set(list.map((t) => (t.modelo || '').trim().toLowerCase()));
  const excludedSeeds = loadExcludedBuiltinSeedKeys();
  const additions = [];
  let salt = 0;
  for (const seed of SEED_DEVICE_TEMPLATES) {
    const m = (seed.modelo || '').trim().toLowerCase();
    if (!m || modeloSet.has(m)) continue;
    if (excludedSeeds.has(seedKeyForSeedEntry(seed))) continue;
    modeloSet.add(m);
    salt += 1;
    additions.push({
      id: `tpl_builtin_${m.replace(/[^a-z0-9]+/g, '_')}_${Date.now()}_${salt}`,
      modelo: seed.modelo.trim(),
      marca: (seed.marca || 'Milesight').trim(),
      channel: String(seed.channel || '1').trim(),
      lorawanClass: normalizeTemplateLorawanClass(seed.lorawanClass),
      decoderScript: String(seed.decoderScript || ''),
      downlinks: normalizeDownlinks(seed.downlinks),
      otaaAppEui: '',
      otaaAppKey: '',
    });
  }
  if (additions.length > 0) {
    persistList([...list, ...additions]);
  }
}

export function getDeviceTemplates() {
  if (serverTemplatesState.status === 'loaded') {
    return mergeSeedsIntoTemplateList(serverTemplatesState.templates);
  }
  ensureBuiltinSeedsMerged();
  return loadRaw();
}

export function saveDeviceTemplate(payload) {
  const incomingId = payload.id != null && String(payload.id).trim() !== '' ? String(payload.id).trim() : null;
  const modeloNorm = String(payload.modelo || '').trim().toLowerCase();
  if (modeloNorm) {
    const list = getDeviceTemplates();
    const conflict = list.find((t) => {
      if ((t.modelo || '').trim().toLowerCase() !== modeloNorm) return false;
      if (incomingId && String(t.id || '').trim() === incomingId) return false;
      return true;
    });
    if (conflict) {
      const err = new Error('TEMPLATE_MODEL_EXISTS');
      err.code = 'TEMPLATE_MODEL_EXISTS';
      err.conflictModelo = conflict.modelo;
      err.conflictMarca = conflict.marca;
      throw err;
    }
  }
  const id =
    incomingId ||
    `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const otaa = normalizeOtaaTemplateFields(payload);
  validateOtaaTemplateFields(otaa);
  const entry = {
    id,
    modelo: String(payload.modelo || '').trim(),
    marca: String(payload.marca || '').trim(),
    channel: String(payload.channel || '').trim(),
    lorawanClass: normalizeTemplateLorawanClass(payload.lorawanClass),
    decoderScript: String(payload.decoderScript || ''),
    downlinks: normalizeDownlinks(payload.downlinks, productModelLabelFromTemplate(payload)),
    otaaAppEui: otaa.otaaAppEui,
    otaaAppKey: otaa.otaaAppKey,
    telemetryLabels: normalizeTelemetryLabelHints(payload.telemetryLabels),
  };
  if (serverTemplatesState.status === 'loaded') {
    const list = [...serverTemplatesState.templates];
    const idx = list.findIndex((t) => String(t.id) === String(entry.id));
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    serverTemplatesState = { ...serverTemplatesState, templates: list };
    persistList(list);
  } else {
    const list = loadRaw();
    const idx = list.findIndex((t) => t.id === id);
    if (idx >= 0) {
      list[idx] = entry;
    } else {
      list.push(entry);
    }
    persistList(list);
  }
  return entry;
}

export function deleteDeviceTemplate(id) {
  const sid = id != null ? String(id).trim() : '';
  const sourceList =
    serverTemplatesState.status === 'loaded' ? [...serverTemplatesState.templates] : [...loadRaw()];
  const victim = sid ? sourceList.find((t) => String(t.id ?? '').trim() === sid) : null;
  if (victim && templateMatchesSeedCatalog(victim)) {
    rememberExcludedBuiltinSeedKey(seedCatalogKey(victim.marca, victim.modelo));
  }
  const next = sid ? sourceList.filter((t) => String(t.id ?? '').trim() !== sid) : sourceList;
  if (serverTemplatesState.status === 'loaded') {
    serverTemplatesState = { ...serverTemplatesState, templates: next };
  }
  persistList(next);
  const def = getDefaultTemplateId();
  if (typeof window !== 'undefined' && sid && def != null && String(def).trim() === sid) {
    setDefaultTemplateId(null);
  }
}

export function getDefaultTemplateId() {
  if (serverTemplatesState.status === 'loaded') {
    const d = serverTemplatesState.defaultTemplateId;
    return d && String(d).trim() ? String(d).trim() : null;
  }
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(DEFAULT_TEMPLATE_ID_KEY);
    return v && String(v).trim() ? String(v).trim() : null;
  } catch {
    return null;
  }
}

/** @param {string | null | undefined} templateId id de plantilla o null para no heredar por defecto */
export function setDefaultTemplateId(templateId) {
  if (serverTemplatesState.status === 'loaded') {
    serverTemplatesState = {
      ...serverTemplatesState,
      defaultTemplateId:
        templateId == null || String(templateId).trim() === '' ? null : String(templateId).trim(),
    };
  }
  if (typeof window === 'undefined') return;
  try {
    if (templateId == null || String(templateId).trim() === '') {
      localStorage.removeItem(DEFAULT_TEMPLATE_ID_KEY);
    } else {
      localStorage.setItem(DEFAULT_TEMPLATE_ID_KEY, String(templateId).trim());
    }
  } catch {
    /* ignore quota / private mode */
  }
}

export function getDeviceTemplateById(templateId) {
  if (!templateId) return null;
  const id = String(templateId).trim();
  return getDeviceTemplates().find((t) => t.id === id) || null;
}

/**
 * Aplica datos **generales** de la plantilla al dispositivo: decoder, FPort, clase (API) y downlinks (localStorage + vínculo a la plantilla).
 * No envía Join EUI / AppKey: esos valores los fija el alta del dispositivo (`registerUserDevice`); la plantilla solo puede sugerirlos en el formulario.
 * @param {string} deviceId DevEUI / id de dispositivo
 * @param {(deviceId: string, payload: { decoderScript: string, channel: string, lorawanClass?: string, productModel?: string }) => Promise<unknown>} saveDeviceDecodeConfig
 */
export async function persistTemplateForDeviceId(deviceId, template, saveDeviceDecodeConfig, opts = {}) {
  if (!template || !deviceId) return;
  const idApi = String(deviceId).trim();
  const cls = normalizeTemplateLorawanClass(template.lorawanClass);
  const skipDecoder = Boolean(opts.skipDecoder);
  if (!skipDecoder) {
    await saveDeviceDecodeConfig(idApi, {
      decoderScript: template.decoderScript != null ? String(template.decoderScript) : '',
      channel: template.channel != null ? String(template.channel) : '',
      lorawanClass: cls,
      productModel: productModelLabelFromTemplate(template),
    });
  } else if (opts.syncLoraMetaOnly) {
    const { fetchDeviceDecodeConfig } = await import('./api.js');
    const cur = await fetchDeviceDecodeConfig(idApi);
    const script =
      cur?.decoderScript != null && String(cur.decoderScript).trim()
        ? String(cur.decoderScript)
        : template.decoderScript != null
          ? String(template.decoderScript)
          : '';
    await saveDeviceDecodeConfig(idApi, {
      decoderScript: script,
      channel: template.channel != null ? String(template.channel) : String(cur?.channel || ''),
      lorawanClass: cls,
      productModel: productModelLabelFromTemplate(template),
    });
  }
  const dls = normalizeDownlinks(template.downlinks, template);
  const tid = template.id != null && String(template.id).trim() ? String(template.id).trim() : '';
  if (typeof localStorage !== 'undefined') {
    const kDl = downlinksLocalStorageKey(deviceId);
    const kSrc = templateSourceLocalStorageKey(deviceId);
    localStorage.setItem(kDl, JSON.stringify(dls));
    if (tid) {
      localStorage.setItem(kSrc, tid);
    }
  }
  const kNorm = deviceKeyNorm(deviceId);
  if (kNorm) {
    primedDownlinksByNorm.set(kNorm, dls);
    if (tid) primedCatalogTemplateIdByNorm.set(kNorm, tid);
    const tl = normalizeTelemetryLabelHints(template.telemetryLabels);
    if (Object.keys(tl).length) primedTelemetryLabelsByNorm.set(kNorm, tl);
    else primedTelemetryLabelsByNorm.delete(kNorm);
  }
  try {
    const { putDeviceDownlinkPresets } = await import('./api.js');
    await putDeviceDownlinkPresets(idApi, {
      downlinks: dls,
      catalogTemplateId: tid || null,
      telemetryLabels: normalizeTelemetryLabelHints(template.telemetryLabels),
    });
  } catch (e) {
    console.warn('[deviceTemplates] putDeviceDownlinkPresets:', e?.message || e);
  }
}

/**
 * Lista `deviceId` en este navegador que tienen guardada la misma plantilla (`device_template_source_*` en localStorage).
 */
export function listDeviceIdsBoundToTemplate(templateId) {
  const tid = String(templateId || '').trim();
  if (!tid || typeof window === 'undefined') return [];
  const prefix = DEVICE_TEMPLATE_SOURCE_KEY_PREFIX;
  /** @type {Map<string, string>} norm → deviceId como en la clave (conserva mayúsculas del alta si aplica). */
  const byNorm = new Map();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = localStorage.getItem(k);
      if (v != null && String(v).trim() === tid) {
        const suffix = k.slice(prefix.length);
        const n = storageDeviceIdKey(suffix) || String(suffix).trim().toLowerCase();
        if (!byNorm.has(n)) byNorm.set(n, suffix);
      }
    }
  } catch {
    /* ignore */
  }
  return [...byNorm.values()].map((x) => String(x).trim()).filter(Boolean);
}

/**
 * Propaga una plantilla guardada al servidor (`decode-config` + clase) y downlinks locales para cada dispositivo vinculado.
 * No modifica credenciales OTAA en servidor (cada equipo ya las tiene en el alta).
 * @param {{ onProgress?: (p: { phase: string, current: number, total: number, deviceId?: string }) => void, perDeviceTimeoutMs?: number }} [opts]
 * @returns {{ synced: number, errors: string[] }}
 */
async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const n = Math.max(1, Math.min(limit, list.length));
  let next = 0;
  async function runOne() {
    while (next < list.length) {
      const i = next;
      next += 1;
      await worker(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => runOne()));
}

/**
 * @param {object} template
 * @param {object|null|undefined} previous
 */
export function templateSyncPlan(template, previous) {
  if (!previous) {
    return { skipDecoder: false, syncLoraMetaOnly: false, downlinksOnly: false };
  }
  const decEq = String(template.decoderScript || '') === String(previous.decoderScript || '');
  const chEq = String(template.channel || '').trim() === String(previous.channel || '').trim();
  const clsEq =
    normalizeTemplateLorawanClass(template.lorawanClass) ===
    normalizeTemplateLorawanClass(previous.lorawanClass);
  const downlinksOnly = decEq && chEq && clsEq;
  return {
    skipDecoder: downlinksOnly,
    syncLoraMetaOnly: decEq && (!chEq || !clsEq),
    downlinksOnly,
  };
}

export async function pushTemplateToAssignedDevices(template, saveDeviceDecodeConfig, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const perDeviceTimeoutMs =
    Number.isFinite(Number(opts.perDeviceTimeoutMs)) && Number(opts.perDeviceTimeoutMs) > 0
      ? Math.floor(Number(opts.perDeviceTimeoutMs))
      : 90000;
  const concurrency =
    Number.isFinite(Number(opts.concurrency)) && Number(opts.concurrency) > 0
      ? Math.min(4, Math.floor(Number(opts.concurrency)))
      : 3;
  const syncPlan =
    opts.syncPlan && typeof opts.syncPlan === 'object'
      ? opts.syncPlan
      : templateSyncPlan(template, opts.previousTemplate);
  const persistOpts = {
    skipDecoder: Boolean(syncPlan.skipDecoder),
    syncLoraMetaOnly: Boolean(syncPlan.syncLoraMetaOnly),
  };
  const id = template?.id != null && String(template.id).trim() ? String(template.id).trim() : '';
  if (!id) return { synced: 0, errors: ['Plantilla sin id'] };
  const localIds = listDeviceIdsBoundToTemplate(id);
  let remoteIds = [];
  if (onProgress) onProgress({ phase: 'list', current: 0, total: 0 });
  try {
    const { fetchAssignedDeviceIdsForTemplate } = await import('./api.js');
    const data = await Promise.race([
      fetchAssignedDeviceIdsForTemplate(id),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Tiempo de espera al listar dispositivos (45 s)')), 45000);
      }),
    ]);
    remoteIds = Array.isArray(data?.deviceIds) ? data.deviceIds : [];
  } catch (e) {
    if (e?.message) {
      return { synced: 0, errors: [String(e.message)] };
    }
    /* sin sesión o sin permiso Dispositivos */
  }
  const deviceIds = [...new Set([...localIds, ...remoteIds].map((x) => String(x || '').trim()).filter(Boolean))];
  const errors = [];
  let synced = 0;
  const total = deviceIds.length;
  let done = 0;
  await runWithConcurrency(deviceIds, concurrency, async (did) => {
    done += 1;
    if (onProgress) onProgress({ phase: 'devices', current: done, total, deviceId: did });
    try {
      await Promise.race([
        persistTemplateForDeviceId(did, template, saveDeviceDecodeConfig, persistOpts),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error(`Tiempo de espera (${Math.round(perDeviceTimeoutMs / 1000)} s)`)),
            perDeviceTimeoutMs
          );
        }),
      ]);
      synced += 1;
    } catch (e) {
      errors.push(`${did}: ${e?.message || String(e)}`);
    }
  });
  return { synced, errors, syncPlan };
}

export function filterDeviceTemplatesByQuery(query) {
  const q = String(query || '').trim().toLowerCase();
  const list = getDeviceTemplates();
  if (!q) return list;
  return list.filter(
    (t) =>
      (t.modelo || '').toLowerCase().includes(q) ||
      (t.marca || '').toLowerCase().includes(q)
  );
}

export const DEVICE_TEMPLATES_EXPORT_FORMAT = 'syscom-iot-device-templates';

/** Documento JSON para exportar / importar todas las plantillas locales. */
export function buildDeviceTemplatesExportDocument() {
  const templates = getDeviceTemplates().map((t) => ({
    id: t.id,
    modelo: t.modelo,
    marca: t.marca,
    channel: t.channel,
    lorawanClass: normalizeTemplateLorawanClass(t.lorawanClass),
    decoderScript: t.decoderScript != null ? String(t.decoderScript) : '',
    downlinks: Array.isArray(t.downlinks) ? t.downlinks : [],
    otaaAppEui: t.otaaAppEui || '',
    otaaAppKey: t.otaaAppKey || '',
    telemetryLabels: normalizeTelemetryLabelHints(t.telemetryLabels),
  }));
  return {
    format: DEVICE_TEMPLATES_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    templates,
  };
}

/**
 * Fusiona plantillas desde un JSON exportado u otro array compatible.
 * - Misma `id` que ya existe: se sustituye la fila.
 * - `id` ausente o vacío: se genera una nueva y se añade.
 * @returns {{ added: number, replaced: number, skipped: string[], affectedTemplateIds: string[] }}
 */
export function mergeDeviceTemplatesFromImport(parsed) {
  const doc = parsed;
  let items = [];
  if (Array.isArray(doc)) {
    items = doc;
  } else if (doc && typeof doc === 'object' && Array.isArray(doc.templates)) {
    items = doc.templates;
  } else {
    throw new Error('El archivo debe ser un array de plantillas o un objeto con la propiedad templates.');
  }

  let customBase;
  if (serverTemplatesState.status === 'loaded') {
    customBase = [...serverTemplatesState.templates];
  } else {
    ensureBuiltinSeedsMerged();
    customBase = [...loadRaw()];
  }
  const list = [...customBase];
  const byId = new Map(list.map((t) => [t.id, t]));
  let added = 0;
  let replaced = 0;
  const skipped = [];
  /** Ids de plantillas realmente escritas (para sincronizar dispositivos vinculados). */
  const affectedTemplateIds = [];

  items.forEach((it, i) => {
    const row = it && typeof it === 'object' ? it : {};
    const modelo = String(row.modelo || '').trim();
    const marca = String(row.marca || '').trim();
    if (!modelo || !marca) {
      skipped.push(`Fila ${i + 1}: falta modelo o marca.`);
      return;
    }

    let otaa = normalizeOtaaTemplateFields(row);
    try {
      validateOtaaTemplateFields(otaa);
    } catch {
      otaa = { otaaAppEui: '', otaaAppKey: '' };
      skipped.push(`Fila ${i + 1} (${modelo}): credenciales OTAA inválidas; se importaron sin AppKey/App EUI.`);
    }

    const fileId = row.id != null && String(row.id).trim() ? String(row.id).trim() : '';
    const id =
      fileId || `tpl_import_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`;

    const ch = String(row.channel != null ? row.channel : '').trim();
    const entry = {
      id,
      modelo,
      marca,
      channel: ch || '1',
      lorawanClass: normalizeTemplateLorawanClass(row.lorawanClass),
      decoderScript: String(row.decoderScript || ''),
      downlinks: normalizeDownlinks(row.downlinks),
      otaaAppEui: otaa.otaaAppEui,
      otaaAppKey: otaa.otaaAppKey,
      telemetryLabels: normalizeTelemetryLabelHints(row.telemetryLabels),
    };

    if (byId.has(id)) {
      const idx = list.findIndex((x) => x.id === id);
      if (idx >= 0) list[idx] = entry;
      replaced += 1;
    } else {
      list.push(entry);
      byId.set(id, entry);
      added += 1;
    }
    affectedTemplateIds.push(id);
  });

  commitDeviceTemplatesCatalog(list);
  return { added, replaced, skipped, affectedTemplateIds: [...new Set(affectedTemplateIds)] };
}
