/**
 * Plantillas de dispositivo (modelo, marca, decoder, downlinks).
 * Persistencia local del navegador; sirven para acelerar el alta y coherencia con el gateway.
 * El `decoderScript` y el **channel** (FPort LoRaWAN de aplicación para downlinks; p. ej. 85 en plantillas Milesight)
 * se guardan en el servidor (`device_decode_config`): el script en cada ingesta y el channel al enviar downlinks.
 * **lorawanClass** (A/B/C) se guarda en `device_decode_config` y en `user_devices` / sesión LNS al aplicar la plantilla.
 * Al **guardar** o **importar** plantillas, `pushTemplateToAssignedDevices` vuelca puerto, clase, decoder y downlinks en cada `deviceId`
 * vinculado (`device_template_source_*`). Las credenciales OTAA por dispositivo las define el **alta** (DevEUI / AppEUI / AppKey); en la
 * plantilla pueden guardarse como **sugerencia** para rellenar campos vacíos del formulario, sin PATCH masivo al servidor.
 * HTTP si hay `payload_b64` o `payload_hex`; el JSON decodificado se fusiona con los metadatos LoRaWAN.
 */
import { SEED_DEVICE_TEMPLATES } from '../constants/seedDeviceTemplates';

const STORAGE_KEY = 'device_profile_templates_v1';
/** id de plantilla aplicada automáticamente al crear dispositivos (decoder + downlinks). */
const DEFAULT_TEMPLATE_ID_KEY = 'device_profile_default_template_id_v1';
/**
 * Claves `marca|modelo` (minúsculas) que el usuario eliminó y no deben reinyectarse desde SEED_DEVICE_TEMPLATES.
 * Sin esto, al borrar p. ej. UC512 el merge volvería a crear la plantilla integrada al instante.
 */
const EXCLUDED_BUILTIN_SEEDS_KEY = 'device_profile_excluded_builtin_seeds_v1';

function seedCatalogKey(marca, modelo) {
  return `${String(marca || '').trim().toLowerCase()}|${String(modelo || '').trim().toLowerCase()}`;
}

function seedKeyForSeedEntry(seed) {
  return seedCatalogKey(seed.marca || 'Milesight', seed.modelo);
}

function templateMatchesSeedCatalog(t) {
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

export function getDownlinkLorawanClassForDevice(deviceId) {
  if (typeof window === 'undefined' || !deviceId) return null;
  const tid = getStoredTemplateIdForDevice(deviceId);
  const tpl = getDeviceTemplateById(tid);
  if (!tpl) return null;
  const explicit = tpl.lorawanClass != null && String(tpl.lorawanClass).trim() !== '';
  const raw = explicit ? tpl.lorawanClass : seedDefaultLorawanClassForTemplate(tpl);
  if (raw == null) return null;
  return normalizeTemplateLorawanClass(raw);
}

const normalizeDownlinks = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((d) => ({
      name: String(d?.name || '').trim(),
      hex: String(d?.hex || '').trim().replace(/\s/g, '').toLowerCase().replace(/^0x/, ''),
    }))
    .filter((d) => d.name && d.hex);

/** Mapa campo (minúsculas) → textos para valores booleanos/on-off (desde «Ajustar» en plantillas). */
export function normalizeTelemetryLabelHints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const fk = String(k || '').trim().toLowerCase();
    if (!fk) continue;
    if (!v || typeof v !== 'object') continue;
    const trueText = v.trueText != null ? String(v.trueText).trim() : '';
    const falseText = v.falseText != null ? String(v.falseText).trim() : '';
    if (!trueText && !falseText) continue;
    out[fk] = {
      ...(trueText ? { trueText } : {}),
      ...(falseText ? { falseText } : {}),
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
  const tid = getStoredTemplateIdForDevice(deviceId);
  if (!tid) return null;
  const tpl = getDeviceTemplateById(tid);
  if (!tpl) return null;
  const norm = normalizeTelemetryLabelHints(tpl.telemetryLabels);
  return Object.keys(norm).length ? norm : null;
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

/** Lee downlinks guardados (clave normalizada o legado `downlinks_<id>`). */
export function readDownlinksFromLocalStorage(deviceId) {
  if (typeof window === 'undefined' || !deviceId) return [];
  try {
    const k = downlinksLocalStorageKey(deviceId);
    let raw = localStorage.getItem(k);
    if (!raw) {
      const leg = `downlinks_${String(deviceId).trim()}`;
      if (leg !== k) raw = localStorage.getItem(leg);
    }
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
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
  ensureBuiltinSeedsMerged();
  return loadRaw();
}

export function saveDeviceTemplate(payload) {
  const list = loadRaw();
  const id =
    payload.id ||
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
    downlinks: normalizeDownlinks(payload.downlinks),
    otaaAppEui: otaa.otaaAppEui,
    otaaAppKey: otaa.otaaAppKey,
    telemetryLabels: normalizeTelemetryLabelHints(payload.telemetryLabels),
  };
  const idx = list.findIndex((t) => t.id === id);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  persistList(list);
  return entry;
}

export function deleteDeviceTemplate(id) {
  const sid = id != null ? String(id).trim() : '';
  const list = loadRaw();
  const victim = sid ? list.find((t) => String(t.id ?? '').trim() === sid) : null;
  if (victim && templateMatchesSeedCatalog(victim)) {
    rememberExcludedBuiltinSeedKey(seedCatalogKey(victim.marca, victim.modelo));
  }
  const next = sid ? list.filter((t) => String(t.id ?? '').trim() !== sid) : list;
  persistList(next);
  const def = getDefaultTemplateId();
  if (typeof window !== 'undefined' && sid && def != null && String(def).trim() === sid) {
    setDefaultTemplateId(null);
  }
}

export function getDefaultTemplateId() {
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
export async function persistTemplateForDeviceId(deviceId, template, saveDeviceDecodeConfig) {
  if (!template || !deviceId) return;
  const idApi = String(deviceId).trim();
  const cls = normalizeTemplateLorawanClass(template.lorawanClass);
  await saveDeviceDecodeConfig(idApi, {
    decoderScript: template.decoderScript != null ? String(template.decoderScript) : '',
    channel: template.channel != null ? String(template.channel) : '',
    lorawanClass: cls,
    productModel: productModelLabelFromTemplate(template),
  });
  const dls = normalizeDownlinks(template.downlinks);
  if (typeof localStorage !== 'undefined') {
    const kDl = downlinksLocalStorageKey(deviceId);
    const kSrc = templateSourceLocalStorageKey(deviceId);
    localStorage.setItem(kDl, JSON.stringify(dls));
    const tid = template.id != null && String(template.id).trim() ? String(template.id).trim() : '';
    if (tid) {
      localStorage.setItem(kSrc, tid);
    }
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
 * @returns {{ synced: number, errors: string[] }}
 */
export async function pushTemplateToAssignedDevices(template, saveDeviceDecodeConfig) {
  const id = template?.id != null && String(template.id).trim() ? String(template.id).trim() : '';
  if (!id) return { synced: 0, errors: ['Plantilla sin id'] };
  const deviceIds = listDeviceIdsBoundToTemplate(id);
  const errors = [];
  let synced = 0;
  for (const did of deviceIds) {
    try {
      await persistTemplateForDeviceId(did, template, saveDeviceDecodeConfig);
      synced += 1;
    } catch (e) {
      errors.push(`${did}: ${e?.message || String(e)}`);
    }
  }
  return { synced, errors };
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

  const list = [...getDeviceTemplates()];
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

  persistList(list);
  return { added, replaced, skipped, affectedTemplateIds: [...new Set(affectedTemplateIds)] };
}
