'use strict';

const { normalizeDeviceClass } = require('./resolve-downlink-class.cjs');
const { remapWs501DownlinkList } = require('./ws501-downlink-legacy.cjs');
const timewaveWaterMeter = require('../timewave-water-meter');

/** Medidor de referencia de la plantilla Water-Meter-LoRa (el n.º real se reescribe al encolar). */
const TIMEWAVE_TEMPLATE_METER = '022026003618';

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

function timewaveMarcaModelo(t) {
  return {
    marca: String(t?.marca || '')
      .trim()
      .toLowerCase(),
    modelo: String(t?.modelo || '')
      .trim()
      .toLowerCase(),
  };
}

/** Duplicado antiguo (4 HEX, decoder decodeUplink, AAAA/BBBB). */
function isStaleTimewaveWaterMeterTemplate(t) {
  const { marca, modelo } = timewaveMarcaModelo(t);
  return marca === 'timewave' && modelo === 'water-meter';
}

function isTimewaveWaterMeterLoraTemplate(t) {
  const { marca, modelo } = timewaveMarcaModelo(t);
  return marca === 'timewave' && modelo === 'water-meter-lora';
}

function isTimewaveBrandTemplate(t) {
  const { marca, modelo } = timewaveMarcaModelo(t);
  return marca.includes('timewave') || modelo.includes('timewave');
}

function isTimewaveBrandLabel(...parts) {
  return parts.some((p) => /timewave/i.test(String(p || '')));
}

/** Los 5 comandos Timewave Water-Meter-LoRa (cerrar, abrir, intervalos 24 h / 12 h / 1 h). */
function canonicalTimewaveLoraDownlinks() {
  return [
    {
      name: 'Cerrar válvula',
      hex: timewaveWaterMeter.buildValveCommand(TIMEWAVE_TEMPLATE_METER, false).toString('hex'),
    },
    {
      name: 'Abrir válvula',
      hex: timewaveWaterMeter.buildValveCommand(TIMEWAVE_TEMPLATE_METER, true).toString('hex'),
    },
    {
      name: 'Intervalo de 1440 min (24 h)',
      hex: timewaveWaterMeter.buildIntervalCommand(TIMEWAVE_TEMPLATE_METER, 1440).toString('hex'),
    },
    {
      name: 'Intervalo de 720 min (12 h)',
      hex: timewaveWaterMeter.buildIntervalCommand(TIMEWAVE_TEMPLATE_METER, 720).toString('hex'),
    },
    {
      name: 'Intervalo de 60 min (1 h)',
      hex: timewaveWaterMeter.buildIntervalCommand(TIMEWAVE_TEMPLATE_METER, 60).toString('hex'),
    },
  ];
}

function timewaveHexNorm(hex) {
  return String(hex || '')
    .trim()
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/** Trama del PDF (`022025001955` → bytes 5–10 `551900252002`). */
const TIMEWAVE_PDF_EXAMPLE_METER_FRAME = '551900252002';

/**
 * Vacío, AAAA/BBBB legado, o HEX del medidor de ejemplo del PDF: hay que poner la ficha actual.
 */
function timewaveCatalogDownlinksNeedRefresh(downlinks) {
  const list = Array.isArray(downlinks) ? downlinks.filter((d) => timewaveHexNorm(d?.hex)) : [];
  if (!list.length) return true;
  return list.some((d) => {
    const h = timewaveHexNorm(d?.hex);
    return h.includes('aaaa') || h.includes('bbbb') || h.includes(TIMEWAVE_PDF_EXAMPLE_METER_FRAME);
  });
}

/**
 * Normaliza una plantilla del catálogo (clase, downlinks WS501 / TimeWave, canal).
 * @param {Record<string, unknown>} t
 * @returns {Record<string, unknown>}
 */
function sanitizeTemplateCatalogEntry(t) {
  if (!t || typeof t !== 'object') return t;
  const modelo = String(t.modelo || '').trim();
  const marca = String(t.marca || '').trim();
  const pm = productModelFromTemplate({ modelo, marca });
  const rawDown = Array.isArray(t.downlinks) ? t.downlinks : [];
  let downlinks = remapWs501DownlinkList(
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
  if (isTimewaveBrandTemplate({ marca, modelo })) {
    if (timewaveCatalogDownlinksNeedRefresh(downlinks)) {
      downlinks = canonicalTimewaveLoraDownlinks().map((d) => ({
        name: d.name,
        hex: timewaveHexNorm(d.hex),
      }));
    }
  }
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
  const list = (Array.isArray(templates) ? templates : []).map((t) => sanitizeTemplateCatalogEntry(t));
  return list.filter((t) => !isStaleTimewaveWaterMeterTemplate(t));
}

module.exports = {
  sanitizeTemplateCatalogEntry,
  sanitizeTemplatesCatalog,
  productModelFromTemplate,
  isStaleTimewaveWaterMeterTemplate,
  isTimewaveWaterMeterLoraTemplate,
  isTimewaveBrandTemplate,
  isTimewaveBrandLabel,
  canonicalTimewaveLoraDownlinks,
};
