/**
 * Plantillas de dispositivo (modelo, marca, decoder, downlinks).
 * Persistencia local del navegador; sirven para acelerar el alta y coherencia con el gateway.
 * El `decoderScript` se guarda en el servidor (`device_decode_config`) y se ejecuta en cada ingesta
 * HTTP si hay `payload_b64` o `payload_hex`; el JSON decodificado se fusiona con los metadatos LoRaWAN.
 */
import { SEED_DEVICE_TEMPLATES } from '../constants/seedDeviceTemplates';

const STORAGE_KEY = 'device_profile_templates_v1';
/** id de plantilla aplicada automáticamente al crear dispositivos (decoder + downlinks). */
const DEFAULT_TEMPLATE_ID_KEY = 'device_profile_default_template_id_v1';

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

function ensureBuiltinSeedsMerged() {
  if (typeof window === 'undefined') return;

  const list = loadRaw();
  const modeloSet = new Set(list.map((t) => (t.modelo || '').trim().toLowerCase()));
  const additions = [];
  let salt = 0;
  for (const seed of SEED_DEVICE_TEMPLATES) {
    const m = (seed.modelo || '').trim().toLowerCase();
    if (!m || modeloSet.has(m)) continue;
    modeloSet.add(m);
    salt += 1;
    additions.push({
      id: `tpl_builtin_${m.replace(/[^a-z0-9]+/g, '_')}_${Date.now()}_${salt}`,
      modelo: seed.modelo.trim(),
      marca: (seed.marca || 'Milesight').trim(),
      channel: String(seed.channel || '1').trim(),
      decoderScript: String(seed.decoderScript || ''),
      downlinks: normalizeDownlinks(seed.downlinks),
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
  const entry = {
    id,
    modelo: String(payload.modelo || '').trim(),
    marca: String(payload.marca || '').trim(),
    channel: String(payload.channel || '').trim(),
    decoderScript: String(payload.decoderScript || ''),
    downlinks: normalizeDownlinks(payload.downlinks),
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
  const list = loadRaw().filter((t) => t.id !== id);
  persistList(list);
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
 * Tras registrar el dispositivo en el servidor: guarda decoder (API) y downlinks (localStorage).
 * @param {string} deviceId DevEUI / id de dispositivo
 * @param {{ decoderScript?: string, channel?: string, downlinks?: Array<{name?: string, hex?: string}> }} template
 * @param {(deviceId: string, payload: { decoderScript: string, channel: string }) => Promise<unknown>} saveDeviceDecodeConfig
 */
export async function persistTemplateForDeviceId(deviceId, template, saveDeviceDecodeConfig) {
  if (!template || !deviceId) return;
  const did = String(deviceId).trim();
  await saveDeviceDecodeConfig(did, {
    decoderScript: template.decoderScript != null ? String(template.decoderScript) : '',
    channel: template.channel != null ? String(template.channel) : '',
  });
  const dls = normalizeDownlinks(template.downlinks);
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
