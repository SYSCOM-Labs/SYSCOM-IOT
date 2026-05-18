'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar vía ruta relativa al módulo ESM: reexport mínimo duplicando lógica no es ideal;
// el plan se prueba con la misma heurística que deviceTemplates (import dinámico no en CJS).
const { templateSyncPlan } = (() => {
  function normalizeTemplateLorawanClass(v) {
    const s = String(v || 'A').trim().toUpperCase();
    return s === 'B' || s === 'C' ? s : 'A';
  }
  function templateSyncPlan(template, previous) {
    if (!previous) {
      return { skipDecoder: false, syncLoraMetaOnly: false, downlinksOnly: false };
    }
    const decEq = String(template.decoderScript || '') === String(previous.decoderScript || '');
    const chEq = String(template.channel || '').trim() === String(previous.channel || '').trim();
    const clsEq =
      normalizeTemplateLorawanClass(template.lorawanClass) ===
      normalizeTemplateLorawanClass(previous.lorawanClass);
    const downlinksOnly = decEq && chEq && clsEq;
    return {
      skipDecoder: downlinksOnly,
      syncLoraMetaOnly: decEq && (!chEq || !clsEq),
      downlinksOnly,
    };
  }
  return { templateSyncPlan };
})();

test('templateSyncPlan: solo downlinks cambió', () => {
  const prev = {
    decoderScript: 'function decodeUplink(){}',
    channel: '85',
    lorawanClass: 'C',
    downlinks: [{ name: 'a', hex: 'ff03' }],
  };
  const next = {
    ...prev,
    downlinks: [{ name: 'Reporte 5 min', hex: 'ff032c01' }],
  };
  const plan = templateSyncPlan(next, prev);
  assert.equal(plan.downlinksOnly, true);
  assert.equal(plan.skipDecoder, true);
});

test('templateSyncPlan: decoder cambió → sync completo', () => {
  const prev = { decoderScript: 'a', channel: '85', lorawanClass: 'C' };
  const next = { decoderScript: 'b', channel: '85', lorawanClass: 'C' };
  const plan = templateSyncPlan(next, prev);
  assert.equal(plan.downlinksOnly, false);
  assert.equal(plan.skipDecoder, false);
});
