'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeTemplateCatalogEntry } = require('../lib/template-catalog-normalize.cjs');

test('sanitizeTemplateCatalogEntry: WS501 mantiene 0810ff/0811ff canónicos', () => {
  const out = sanitizeTemplateCatalogEntry({
    modelo: 'WS501',
    marca: 'Milesight',
    channel: '85',
    lorawanClass: 'C',
    downlinks: [
      { name: 'Encender', hex: '0811ff' },
      { name: 'Apagar', hex: '0810ff' },
    ],
  });
  assert.equal(out.lorawanClass, 'C');
  assert.equal(out.downlinks[0].hex, '0811ff');
  assert.equal(out.downlinks[1].hex, '0810ff');
});

test('sanitizeTemplateCatalogEntry: WS501 convierte ff2910/ff2911 a canónico', () => {
  const out = sanitizeTemplateCatalogEntry({
    modelo: 'WS501',
    downlinks: [
      { name: 'Encender', hex: 'ff2911' },
      { name: 'Apagar', hex: 'ff2910' },
    ],
  });
  assert.equal(out.downlinks[0].hex, '0811ff');
  assert.equal(out.downlinks[1].hex, '0810ff');
});

test('sanitizeTemplateCatalogEntry: UC300 corrige clase A heredada a C', () => {
  const out = sanitizeTemplateCatalogEntry({
    modelo: 'UC300',
    marca: 'Milesight',
    channel: '85',
    lorawanClass: 'A',
    downlinks: [{ name: 'DO 1 - Activar', hex: '070100ff' }],
  });
  assert.equal(out.lorawanClass, 'C');
});

test('sanitizeTemplatesCatalog: elimina Timewave Water-Meter y deja Water-Meter-LoRa con HEX de referencia', () => {
  const { sanitizeTemplatesCatalog } = require('../lib/template-catalog-normalize.cjs');
  const out = sanitizeTemplatesCatalog([
    {
      id: 'old',
      marca: 'Timewave',
      modelo: 'Water-Meter',
      channel: '2',
      lorawanClass: 'A',
      downlinks: [{ name: 'Válvula abrir', hex: 'fefefefe6855190025200268140e35dd93373533333363636363aaaa3116' }],
    },
    {
      id: 'keep',
      marca: 'Timewave',
      modelo: 'Water-Meter-LoRa',
      channel: '2',
      lorawanClass: 'A',
      downlinks: [{ name: 'abrir_valvula (Cut on) — Abre la válvula', hex: 'fefefefe6855190025200268140e35dd93373533333363636363aaaa3116' }],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].modelo, 'Water-Meter-LoRa');
  assert.equal(out[0].downlinks.length, 5);
  assert.equal(out[0].downlinks[0].name, 'Cerrar válvula');
  assert.equal(out[0].downlinks[0].hex, 'fefefefe6818360026200268140e35dd93373533333363636363eeee9a16');
  assert.equal(out[0].downlinks[1].hex, 'fefefefe6818360026200268140e35dd93373533333363636363dddd7816');
  assert.equal(out[0].downlinks[2].hex, 'fefefefe6818360026200268140e3534a33735333333636363637347df16');
  assert.equal(out[0].downlinks[3].hex, 'fefefefe6818360026200268140e3534a3373533333363636363533ab216');
  assert.equal(out[0].downlinks[4].hex, 'fefefefe6818360026200268140e3534a33735333333636363639333eb16');
});

test('sanitizeTemplatesCatalog: Timewave sustituye HEX del PDF de ejemplo por la ficha operativa', () => {
  const { sanitizeTemplatesCatalog } = require('../lib/template-catalog-normalize.cjs');
  const out = sanitizeTemplatesCatalog([
    {
      id: 'keep',
      marca: 'Timewave',
      modelo: 'Water-Meter-LoRa',
      channel: '2',
      lorawanClass: 'A',
      downlinks: [
        { name: 'abrir_valvula (Cut on) — Abre la válvula', hex: 'fefefefe6855190025200268140e35dd93373533333363636363dddd9716' },
        { name: 'cerrar_valvula (Cut off) — Cierra la válvula', hex: 'fefefefe6855190025200268140e35dd93373533333363636363eeeeb916' },
      ],
    },
  ]);
  assert.equal(out[0].downlinks.length, 5);
  assert.equal(out[0].downlinks[0].hex, 'fefefefe6818360026200268140e35dd93373533333363636363eeee9a16');
});

test('sanitizeTemplatesCatalog: Timewave conserva HEX operativos ya actualizados', () => {
  const { sanitizeTemplatesCatalog } = require('../lib/template-catalog-normalize.cjs');
  const hex = 'fefefefe6818360026200268140e35dd93373533333363636363eeee9a16';
  const out = sanitizeTemplatesCatalog([
    {
      id: 'keep',
      marca: 'Timewave',
      modelo: 'Water-Meter-LoRa',
      channel: '2',
      lorawanClass: 'A',
      downlinks: [{ name: 'Cerrar válvula', hex }],
    },
  ]);
  assert.equal(out[0].downlinks.length, 1);
  assert.equal(out[0].downlinks[0].hex, hex);
});

test('sanitizeTemplatesCatalog: elimina Timewave Water-Meter aunque no exista LoRa', () => {
  const { sanitizeTemplatesCatalog } = require('../lib/template-catalog-normalize.cjs');
  const out = sanitizeTemplatesCatalog([
    {
      id: 'old',
      marca: 'Timewave',
      modelo: 'Water-Meter',
      channel: '2',
      downlinks: [{ name: 'x', hex: 'aabb' }],
    },
  ]);
  assert.equal(out.length, 0);
});
