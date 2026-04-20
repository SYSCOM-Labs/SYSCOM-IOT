/**
 * Plantillas de dispositivo (modelo, marca, decoder, downlinks, LNS opcional).
 * Persistencia local del navegador; el decoder se ejecuta en ingesta HTTP (servidor).
 */
import { SEED_DEVICE_TEMPLATES } from '../constants/seedDeviceTemplates';

export const STORAGE_KEY = 'device_profile_templates_v1';
const DEFAULT_TEMPLATE_ID_KEY = 'device_profile_default_template_id_v1';
/** Plantillas integradas eliminadas a propósito: no reinyectar por ensureBuiltinSeedsMerged. */
const EXCLUDED_BUILTIN_SEEDS_KEY = 'device_profile_excluded_builtin_seeds_v1';

export const EXPORT_DOC_FORMAT = 'syscom-iot-device-templates';

/** Clase LoRaWAN A / B / C para LNS (plantilla y sincronización con `user_devices`). */
export function normalizeTemplateLorawanClass(raw) {
  const u = String(raw ?? 'A')
    .trim()
    .toUpperCase();
  return u === 'B' || u === 'C' ? u : 'A';
}

const normalizeDownlinks = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((d) => ({
      name: String(d?.name || '').trim(),
      hex: String(d?.hex || '').trim().replace(/\s/g, '').toLowerCase().replace(/^0x/, ''),
    }))
    .filter((d) => d.name && d.hex);

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

function seedKey(marca, modelo) {
  return `${String(marca || '').trim().toLowerCase()}|${String(modelo || '').trim().toLowerCase()}`;
}

function loadExcludedSeedKeys() {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(EXCLUDED_BUILTIN_SEEDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map((x) => String(x).toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

function saveExcludedSeedKeys(set) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(EXCLUDED_BUILTIN_SEEDS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function normalizeLnsTriple(row) {
  const a = row.lnsDevAddr != null ? String(row.lnsDevAddr).trim() : '';
  const b = row.lnsNwkSKey != null ? String(row.lnsNwkSKey).trim() : '';
  const c = row.lnsAppSKey != null ? String(row.lnsAppSKey).trim() : '';
  const count = [a, b, c].filter((x) => x !== '').length;
  if (count === 0) return { row: { ...row, lnsDevAddr: '', lnsNwkSKey: '', lnsAppSKey: '' }, warn: null };
  if (count === 3) return { row: { ...row, lnsDevAddr: a, lnsNwkSKey: b, lnsAppSKey: c }, warn: null };
  return {
    row: { ...row, lnsDevAddr: '', lnsNwkSKey: '', lnsAppSKey: '' },
    warn: 'LNS incompleto (se requieren DevAddr + NwkSKey + AppSKey): claves LNS omitidas en importación.',
  };
}

function ensureBuiltinSeedsMerged() {
  if (typeof window === 'undefined') return;

  const list = loadRaw();
  const modeloSet = new Set(list.map((t) => (t.modelo || '').trim().toLowerCase()));
  const excluded = loadExcludedSeedKeys();
  const additions = [];
  let salt = 0;
  for (const seed of SEED_DEVICE_TEMPLATES) {
    const m = (seed.modelo || '').trim().toLowerCase();
    if (!m || modeloSet.has(m)) continue;
    const sk = seedKey(seed.marca, seed.modelo);
    if (excluded.has(sk)) continue;
    modeloSet.add(m);
    salt += 1;
    additions.push({
      id: `tpl_builtin_${m.replace(/[^a-z0-9]+/g, '_')}_${Date.now()}_${salt}`,
      modelo: seed.modelo.trim(),
      marca: (seed.marca || 'Milesight').trim(),
      channel: String(seed.channel || '1').trim(),
      decoderScript: String(seed.decoderScript || ''),
      downlinks: normalizeDownlinks(seed.downlinks),
      lorawanClass: normalizeTemplateLorawanClass(seed.lorawanClass),
      lnsDevAddr: '',
      lnsNwkSKey: '',
      lnsAppSKey: '',
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
    payload.id || `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const entry = {
    id,
    modelo: String(payload.modelo || '').trim(),
    marca: String(payload.marca || '').trim(),
    channel: String(payload.channel || '').trim(),
    decoderScript: String(payload.decoderScript || ''),
    downlinks: normalizeDownlinks(payload.downlinks),
    lorawanClass: normalizeTemplateLorawanClass(payload.lorawanClass),
    lnsDevAddr: String(payload.lnsDevAddr || '').trim(),
    lnsNwkSKey: String(payload.lnsNwkSKey || '').trim(),
    lnsAppSKey: String(payload.lnsAppSKey || '').trim(),
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
  const list = loadRaw();
  const row = list.find((t) => t.id === id);
  const next = list.filter((t) => t.id !== id);
  if (row) {
    const sk = seedKey(row.marca, row.modelo);
    for (const seed of SEED_DEVICE_TEMPLATES) {
      if (seedKey(seed.marca, seed.modelo) === sk) {
        const ex = loadExcludedSeedKeys();
        ex.add(sk);
        saveExcludedSeedKeys(ex);
        break;
      }
    }
  }
  persistList(next);
  if (typeof window !== 'undefined' && getDefaultTemplateId() === id) {
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

export function setDefaultTemplateId(templateId) {
  if (typeof window === 'undefined') return;
  try {
    if (templateId == null || String(templateId).trim() === '') {
      localStorage.removeItem(DEFAULT_TEMPLATE_ID_KEY);
    } else {
      localStorage.setItem(DEFAULT_TEMPLATE_ID_KEY, String(templateId).trim());
    }
  } catch {
    /* ignore */
  }
}

export function getDeviceTemplateById(templateId) {
  if (!templateId) return null;
  const id = String(templateId).trim();
  return getDeviceTemplates().find((t) => t.id === id) || null;
}

export async function persistTemplateForDeviceId(deviceId, template, saveDeviceDecodeConfig) {
  if (!template || !deviceId) return;
  const did = String(deviceId).trim();
  const dls = normalizeDownlinks(template.downlinks);
  await saveDeviceDecodeConfig(did, {
    decoderScript: template.decoderScript != null ? String(template.decoderScript) : '',
    channel: template.channel != null ? String(template.channel) : '',
    downlinks: dls,
    lorawanClass: normalizeTemplateLorawanClass(template.lorawanClass),
  });
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`downlinks_${did}`, JSON.stringify(dls));
  }
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

/**
 * Documento JSON para exportación / copias de seguridad.
 */
export function buildDeviceTemplatesExportDocument() {
  const templates = getDeviceTemplates().map((t) => ({
    id: t.id,
    modelo: t.modelo,
    marca: t.marca,
    channel: t.channel,
    decoderScript: t.decoderScript || '',
    downlinks: normalizeDownlinks(t.downlinks),
    lorawanClass: normalizeTemplateLorawanClass(t.lorawanClass),
    lnsDevAddr: t.lnsDevAddr || '',
    lnsNwkSKey: t.lnsNwkSKey || '',
    lnsAppSKey: t.lnsAppSKey || '',
  }));
  return {
    format: EXPORT_DOC_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    templates,
  };
}

/**
 * Fusiona plantillas desde JSON importado.
 * @returns {{ added: number, replaced: number, skipped: number, warnings: string[] }}
 */
export function mergeDeviceTemplatesFromImport(parsed) {
  const warnings = [];
  let arr = [];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.templates)) {
    arr = parsed.templates;
  } else {
    return { added: 0, replaced: 0, skipped: 0, warnings: ['JSON inválido: se esperaba { templates: [...] } o un array.'] };
  }

  const list = loadRaw();
  const byId = new Map(list.map((t) => [t.id, t]));
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let lnsIncompleteWarned = false;

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') {
      skipped += 1;
      continue;
    }
    const modelo = String(raw.modelo || '').trim();
    const marca = String(raw.marca || '').trim();
    if (!modelo || !marca) {
      skipped += 1;
      warnings.push('Fila sin modelo o marca: omitida.');
      continue;
    }
    let id = raw.id != null && String(raw.id).trim() !== '' ? String(raw.id).trim() : '';
    if (!id) {
      id = `tpl_import_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      added += 1;
    } else if (byId.has(id)) {
      replaced += 1;
    } else {
      added += 1;
    }

    let row = {
      id,
      modelo,
      marca,
      channel: String(raw.channel != null && String(raw.channel).trim() !== '' ? raw.channel : '1').trim(),
      decoderScript: String(raw.decoderScript || ''),
      downlinks: normalizeDownlinks(raw.downlinks),
      lorawanClass: normalizeTemplateLorawanClass(raw.lorawanClass),
      lnsDevAddr: String(raw.lnsDevAddr || '').trim(),
      lnsNwkSKey: String(raw.lnsNwkSKey || '').trim(),
      lnsAppSKey: String(raw.lnsAppSKey || '').trim(),
    };
    const { row: row2, warn } = normalizeLnsTriple(row);
    row = row2;
    if (warn && !lnsIncompleteWarned) {
      lnsIncompleteWarned = true;
      warnings.push(warn);
    }

    byId.set(id, row);
  }

  const merged = [...byId.values()];
  persistList(merged);
  return { added, replaced, skipped, warnings };
}
