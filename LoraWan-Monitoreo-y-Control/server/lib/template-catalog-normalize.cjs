'use strict';

const { normalizeDeviceClass } = require('./resolve-downlink-class.cjs');
const { remapWs501DownlinkList } = require('./ws501-downlink-legacy.cjs');
const timewaveWaterMeter = require('../timewave-water-meter');

const TIMEWAVE_EXAMPLE_METER = '022025001955';

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

/** Los 5 comandos de Timewave Water-Meter-LoRa (PDF: DDDD/EEEE; intervalo scrambleado). */
function canonicalTimewaveLoraDownlinks() {
  return [
    {
      name: 'abrir_valvula (Cut on) — Abre la válvula',
      hex: timewaveWaterMeter.buildValveCommand(TIMEWAVE_EXAMPLE_METER, true).toString('hex'),
    },
    {
      name: 'cerrar_valvula (Cut off) — Cierra la válvula',
      hex: timewaveWaterMeter.buildValveCommand(TIMEWAVE_EXAMPLE_METER, false).toString('hex'),
    },
    {
      name: 'cambiar_intervalo — 1440 min (24 h, defecto 1 día)',
      hex: timewaveWaterMeter.buildIntervalCommand(TIMEWAVE_EXAMPLE_METER, 1440).toString('hex'),
    },
    {
      name: 'cambiar_intervalo — 720 min (12 h)',
      hex: timewaveWaterMeter.buildIntervalCommand(TIMEWAVE_EXAMPLE_METER, 720).toString('hex'),
    },
    {
      name: 'cambiar_intervalo — 60 min (1 h)',
      hex: timewaveWaterMeter.buildIntervalCommand(TIMEWAVE_EXAMPLE_METER, 60).toString('hex'),
    },
  ];
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
  if (isTimewaveWaterMeterLoraTemplate({ marca, modelo })) {
    downlinks = canonicalTimewaveLoraDownlinks();
  } else if (/timewave/i.test(marca)) {
    downlinks = downlinks.map((d) => {
      const rewritten = timewaveWaterMeter.rewriteDownlinkHex(d.hex, null);
      return rewritten ? { ...d, hex: rewritten } : d;
    });
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
  canonicalTimewaveLoraDownlinks,
};
