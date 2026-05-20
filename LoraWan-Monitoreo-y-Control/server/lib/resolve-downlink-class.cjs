'use strict';

/**
 * Clase LoRaWAN efectiva para temporizar downlinks (RX1/RX2 vs clase C).
 * Prioridad: explícita en POST → plantilla (catálogo) → decode-config (plantilla aplicada) →
 * user_devices → modelo en catálogo → sesión LNS → A.
 */

function normalizeDeviceClass(raw) {
  const u = String(raw || 'A')
    .trim()
    .toUpperCase();
  if (u === 'B' || u === 'C') return u;
  if (u.includes('CLASS C') || u.includes('CLASE C')) return 'C';
  if (u.includes('CLASS B') || u.includes('CLASE B')) return 'B';
  return 'A';
}

/** Solo respaldo si no hay clase en plantilla ni decode-config (preferir catálogo / semilla). */
function productModelClassHint(productModel) {
  const s = String(productModel || '').toUpperCase();
  if (s.includes('SHENGDA') || s.includes('TIMEWAVE') || s.includes('EASTRON')) return 'A';
  return null;
}

/**
 * Clase desde plantilla publicada en catálogo (UI Plantillas / SQLite).
 * @param {object} store
 * @param {string} deviceId
 * @param {object | null | undefined} ud
 * @param {object | null | undefined} cfg
 * @returns {'A'|'B'|'C'|null}
 */
function lorawanClassFromCatalogTemplate(store, deviceId, ud, cfg) {
  if (!store || typeof store.getDeviceTemplatesCatalog !== 'function') return null;
  const cat = store.getDeviceTemplatesCatalog();
  const templates = Array.isArray(cat.templates) ? cat.templates : [];
  if (!templates.length) return null;

  const did = String(deviceId || '').trim();
  let presets = null;
  if (did && typeof store.getDeviceSharedPresetsParsed === 'function') {
    try {
      presets = store.getDeviceSharedPresetsParsed(did);
    } catch {
      presets = null;
    }
  }
  const tid =
    presets && presets.catalogTemplateId != null ? String(presets.catalogTemplateId).trim() : '';
  if (tid) {
    const byId = templates.find((t) => String(t.id || '').trim() === tid);
    if (byId && byId.lorawanClass != null && String(byId.lorawanClass).trim() !== '') {
      return normalizeDeviceClass(byId.lorawanClass);
    }
  }

  const pm = String(ud?.productModel || cfg?.productModel || '').toUpperCase();
  for (const t of templates) {
    const modelo = String(t.modelo || '').trim().toUpperCase();
    if (modelo && pm.includes(modelo) && t.lorawanClass != null && String(t.lorawanClass).trim() !== '') {
      return normalizeDeviceClass(t.lorawanClass);
    }
  }
  return null;
}

/**
 * @param {import('../store').Store | object} store
 * @param {string} userId
 * @param {string} devEuiNorm16
 * @param {{ explicitClass?: string, sessionClass?: string, deviceId?: string, productModel?: string }} [opts]
 * @returns {'A'|'B'|'C'}
 */
function resolveDownlinkDeviceClassForLns(store, userId, devEuiNorm16, opts = {}) {
  if (opts.explicitClass != null && String(opts.explicitClass).trim() !== '') {
    return normalizeDeviceClass(opts.explicitClass);
  }
  const ud =
    typeof store.getUserDeviceByDevEuiNorm === 'function'
      ? store.getUserDeviceByDevEuiNorm(userId, devEuiNorm16)
      : null;
  const deviceId = opts.deviceId || (ud && ud.deviceId) || devEuiNorm16;
  let cfg = null;
  if (typeof store.getDeviceDecodeConfig === 'function') {
    for (const key of [String(deviceId), String(devEuiNorm16)].filter((k, i, a) => k && a.indexOf(k) === i)) {
      const c = store.getDeviceDecodeConfig(key);
      if (c && (c.lorawanClass != null || c.lorawan_class != null || c.productModel != null)) {
        cfg = c;
        break;
      }
    }
  }

  const fromTemplate = lorawanClassFromCatalogTemplate(store, deviceId, ud, cfg);
  if (fromTemplate) return fromTemplate;

  const fromCfg = cfg && (cfg.lorawanClass ?? cfg.lorawan_class);
  if (fromCfg != null && String(fromCfg).trim() !== '') {
    return normalizeDeviceClass(fromCfg);
  }
  if (ud && ud.lorawanClass != null && String(ud.lorawanClass).trim() !== '') {
    return normalizeDeviceClass(ud.lorawanClass);
  }
  const pm = String(opts.productModel || ud?.productModel || cfg?.productModel || '').trim();
  const hint = productModelClassHint(pm);
  if (hint) return hint;
  if (opts.sessionClass != null && String(opts.sessionClass).trim() !== '') {
    return normalizeDeviceClass(opts.sessionClass);
  }
  return 'A';
}

module.exports = {
  normalizeDeviceClass,
  productModelClassHint,
  lorawanClassFromCatalogTemplate,
  resolveDownlinkDeviceClassForLns,
};
