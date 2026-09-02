'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDeviceClass,
  productModelClassHint,
  lorawanClassFromCatalogTemplate,
  resolveDownlinkDeviceClassForLns,
} = require('../lib/resolve-downlink-class.cjs');

test('productModelClassHint solo medidores sin plantilla Milesight', () => {
  assert.equal(productModelClassHint('Milesight · WT201'), null);
  assert.equal(productModelClassHint('Milesight · UC300'), 'C');
  assert.equal(productModelClassHint('Shengda · Medidor-ALP-v1.6'), 'A');
});

test('resolveDownlinkDeviceClassForLns: WT201 clase C desde plantilla', () => {
  const store = {
    getUserDeviceByDevEuiNorm: () => ({ deviceId: 'dev1', productModel: 'WT201' }),
    getDeviceDecodeConfig: () => ({ lorawanClass: 'C', productModel: 'Milesight · WT201' }),
    getDeviceTemplatesCatalog: () => ({
      templates: [{ id: 'tpl_wt201', modelo: 'WT201', lorawanClass: 'C' }],
    }),
    getDeviceSharedPresetsParsed: () => ({ catalogTemplateId: 'tpl_wt201' }),
  };
  assert.equal(
    resolveDownlinkDeviceClassForLns(store, 'u1', '24e124715d419053', { sessionClass: 'A' }),
    'C'
  );
});

test('resolveDownlinkDeviceClassForLns: WS501 es clase C (plantilla / decode-config)', () => {
  const store = {
    getUserDeviceByDevEuiNorm: () => ({ deviceId: 'dev1', productModel: 'WS501' }),
    getDeviceDecodeConfig: (id) =>
      id === 'dev1' ? { lorawanClass: 'C', productModel: 'Milesight · WS501' } : null,
    getDeviceTemplatesCatalog: () => ({
      templates: [{ id: 'tpl_builtin_ws501', modelo: 'WS501', lorawanClass: 'C' }],
    }),
    getDeviceSharedPresetsParsed: () => ({ catalogTemplateId: 'tpl_builtin_ws501' }),
  };
  assert.equal(
    resolveDownlinkDeviceClassForLns(store, 'u1', '24e124777e282770', { sessionClass: 'A' }),
    'C'
  );
});

test('lorawanClassFromCatalogTemplate prioriza plantilla sobre sesión LNS', () => {
  const store = {
    getDeviceTemplatesCatalog: () => ({
      templates: [{ id: 'tpl_ws501', modelo: 'WS501', lorawanClass: 'C' }],
    }),
    getDeviceSharedPresetsParsed: () => ({ catalogTemplateId: 'tpl_ws501' }),
  };
  assert.equal(lorawanClassFromCatalogTemplate(store, 'dev1', { productModel: 'Milesight · WS501' }, null), 'C');
});

test('normalizeDeviceClass acepta etiquetas Milesight', () => {
  assert.equal(normalizeDeviceClass('Class C'), 'C');
  assert.equal(normalizeDeviceClass('Class A'), 'A');
});

test('resolveDownlinkDeviceClassForLns: UC300 es clase C aunque catálogo/sesión/POST digan A', () => {
  const store = {
    getUserDeviceByDevEuiNorm: () => ({
      deviceId: 'dev-uc300',
      productModel: 'Milesight · UC300',
      lorawanClass: 'A',
    }),
    getDeviceDecodeConfig: () => ({ lorawanClass: 'A', productModel: 'Milesight · UC300' }),
    getDeviceTemplatesCatalog: () => ({
      templates: [{ id: 'tpl_uc300', modelo: 'UC300', lorawanClass: 'A' }],
    }),
    getDeviceSharedPresetsParsed: () => ({ catalogTemplateId: 'tpl_uc300' }),
  };
  assert.equal(
    resolveDownlinkDeviceClassForLns(store, 'u1', '24e1240000000001', {
      sessionClass: 'A',
      explicitClass: 'A',
    }),
    'C'
  );
});
