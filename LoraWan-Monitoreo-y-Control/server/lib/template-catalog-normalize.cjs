'use strict';

const { normalizeDeviceClass } = require('./resolve-downlink-class.cjs');
const { remapWs501DownlinkList } = require('./ws501-downlink-legacy.cjs');

function productModelFromTemplate(t) {
  const modelo = String(t?.modelo || '').trim();
  const marca = String(t?.marca || '').trim();
  if (marca && modelo) return `${marca} · ${modelo}`;
  return modelo || marca || '';
}

/** Alineado con `src/constants/seedDeviceTemplates.js` (clase por modelo). */
function defaultLorawanClassForModelo(modelo) {
  const m = String(modelo || '')
    .trim()
    .toUpperCase();
  if (m === 'WT201' || m === 'WS501' || m === 'UC701' || m === 'UC300') return 'C';
  return 'A';
}

/** Modelos que no deben conservar clase A heredada de semillas/catálogos antiguos. */
function coerceCatalogLorawanClass(modelo, stored) {
  const m = String(modelo || '')
    .trim()
    .toUpperCase();
  if (m === 'UC300') return 'C';
  return stored != null && String(stored).trim() !== ''
    ? stored
    : defaultLorawanClassForModelo(modelo);
}

/**
 * Normaliza una plantilla del catálogo (clase, downlinks WS501, canal).
 * @param {Record<string, unknown>} t
 * @returns {Record<string, unknown>}
 */
function sanitizeTemplateCatalogEntry(t) {
  if (!t || typeof t !== 'object') return t;
  const modelo = String(t.modelo || '').trim();
  const marca = String(t.marca || '').trim();
  const pm = productModelFromTemplate({ modelo, marca });
  const rawDown = Array.isArray(t.downlinks) ? t.downlinks : [];
  const downlinks = remapWs501DownlinkList(
    rawDown
      .map((d) => ({
        name: String(d?.name || '').trim(),
        hex: String(d?.hex || '')
          .trim()
          .replace(/\s/g, '')
          .toLowerCase()
          .replace(/^0x/, ''),
      }))
      .filter((d) => d.name && d.hex && d.hex.length % 2 === 0),
    pm
  );
  return {
    ...t,
    modelo,
    marca,
    channel: t.channel != null ? String(t.channel).trim() : '',
    lorawanClass: normalizeDeviceClass(coerceCatalogLorawanClass(modelo, t.lorawanClass || t.lorawan_class)),
    downlinks,
    decoderScript: t.decoderScript != null ? String(t.decoderScript) : '',
  };
}

/**
 * @param {unknown[]} templates
 * @returns {Record<string, unknown>[]}
 */
function sanitizeTemplatesCatalog(templates) {
  return (Array.isArray(templates) ? templates : []).map((t) => sanitizeTemplateCatalogEntry(t));
}

module.exports = {
  sanitizeTemplateCatalogEntry,
  sanitizeTemplatesCatalog,
  productModelFromTemplate,
};
