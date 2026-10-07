'use strict';

const { normalizeDeviceClass } = require('./resolve-downlink-class.cjs');
const { remapWs501DownlinkList } = require('./ws501-downlink-legacy.cjs');
const timewaveWaterMeter = require('../timewave-water-meter');
const timewaveUltrasonic = require('../timewave-ultrasonic-water-meter');
const { WT201_DOWNLINK_PRESETS } = require('./wt201-downlink-encode.cjs');

/** Consigna 24 °C modo cool (canal ffb7, modo 02, 24 = 0x18). */
const WT201_COOL_24 = WT201_DOWNLINK_PRESETS.find((d) => String(d?.hex || '').toLowerCase() === 'ffb70218') || {
  name: 'Consigna 24 °C (frío)',
  hex: 'ffb70218',
};

/** Medidor de referencia de la plantilla Water-Meter-LoRa (el n.º real se reescribe al encolar). */
const TIMEWAVE_TEMPLATE_METER = '022026003618';
/** Medidor de ejemplo de la ficha ultrasónica V1.0.2 (14 hex). */
const TIMEWAVE_ULTRASONIC_TEMPLATE_METER = timewaveUltrasonic.TIMEWAVE_ULTRASONIC_EXAMPLE_METER_NO;

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

function isTimewaveUltrasonicTemplate(t) {
  const { marca, modelo } = timewaveMarcaModelo(t);
  return (
    marca === 'timewave' &&
    (modelo === 'ultrasonic-water-meter-lora' || modelo === 'ultrasonic-water-meter')
  );
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
    return (
      h.includes('aaaa') ||
      h.includes('bbbb') ||
      h.includes(TIMEWAVE_PDF_EXAMPLE_METER_FRAME) ||
      !h.startsWith('fefefefe')
    );
  });
}

function canonicalTimewaveUltrasonicDownlinks() {
  const m = TIMEWAVE_ULTRASONIC_TEMPLATE_METER;
  return [
    { name: 'Cerrar válvula', hex: timewaveUltrasonic.buildCloseValveCommand(m).toString('hex') },
    { name: 'Abrir válvula', hex: timewaveUltrasonic.buildOpenValveCommand(m).toString('hex') },
    {
      name: 'Intervalo de reporte 24 h',
      hex: timewaveUltrasonic.buildUploadParamsCommand(m, { reportIntervalHours: 24 }).toString('hex'),
    },
    {
      name: 'Intervalo de reporte 12 h',
      hex: timewaveUltrasonic.buildUploadParamsCommand(m, { reportIntervalHours: 12 }).toString('hex'),
    },
    {
      name: 'Intervalo de reporte 1 h',
      hex: timewaveUltrasonic.buildUploadParamsCommand(m, { reportIntervalHours: 1 }).toString('hex'),
    },
  ];
}

function downlinkHexNorm(hex) {
  return String(hex || '')
    .trim()
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/** Inserta la consigna 24 °C en frío si la plantilla WT201 aún no la trae. */
function appendWt201Cool24Downlink(modelo, downlinks) {
  if (String(modelo || '').trim().toUpperCase() !== 'WT201') return downlinks;
  const list = Array.isArray(downlinks) ? downlinks.slice() : [];
  const hex = downlinkHexNorm(WT201_COOL_24.hex);
  if (list.some((d) => downlinkHexNorm(d?.hex) === hex)) return list;
  const row = { name: WT201_COOL_24.name, hex };
  const after23 = list.findIndex((d) => downlinkHexNorm(d?.hex) === 'ffb70217');
  if (after23 >= 0) {
    list.splice(after23 + 1, 0, row);
    return list;
  }
  let lastSetpoint = -1;
  list.forEach((d, i) => {
    if (downlinkHexNorm(d?.hex).startsWith('ffb7')) lastSetpoint = i;
  });
  if (lastSetpoint >= 0) {
    list.splice(lastSetpoint + 1, 0, row);
    return list;
  }
  list.push(row);
  return list;
}

function timewaveUltrasonicCatalogDownlinksNeedRefresh(downlinks) {
  const list = Array.isArray(downlinks) ? downlinks.filter((d) => timewaveHexNorm(d?.hex)) : [];
  if (!list.length) return true;
  return list.some((d) => {
    const h = timewaveHexNorm(d?.hex);
    return h.startsWith('fefefefe') || h.includes('aaaa') || h.includes('bbbb');
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
  if (isTimewaveWaterMeterLoraTemplate({ marca, modelo })) {
    if (timewaveCatalogDownlinksNeedRefresh(downlinks)) {
      downlinks = canonicalTimewaveLoraDownlinks().map((d) => ({
        name: d.name,
        hex: timewaveHexNorm(d.hex),
      }));
    }
  } else if (isTimewaveUltrasonicTemplate({ marca, modelo })) {
    if (timewaveUltrasonicCatalogDownlinksNeedRefresh(downlinks)) {
      downlinks = canonicalTimewaveUltrasonicDownlinks().map((d) => ({
        name: d.name,
        hex: timewaveHexNorm(d.hex),
      }));
    }
  }
  downlinks = appendWt201Cool24Downlink(modelo, downlinks);
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
  isTimewaveUltrasonicTemplate,
  isTimewaveBrandTemplate,
  isTimewaveBrandLabel,
  canonicalTimewaveLoraDownlinks,
  canonicalTimewaveUltrasonicDownlinks,
};
