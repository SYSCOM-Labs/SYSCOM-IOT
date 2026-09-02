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
