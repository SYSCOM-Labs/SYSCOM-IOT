'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDecoderScriptForRuntime } = require('../lib/decoder-script-adapt.cjs');
const { runDecoderScript } = require('../payload-decoder');

test('prepareDecoderScriptForRuntime: inyecta decodeUplink y __syscomNormalizePayloadBytes', () => {
  const raw = `function milesightDeviceDecode(bytes) { return { line_1_total_in: 7 }; }`;
  const s = prepareDecoderScriptForRuntime(raw);
  assert.match(s, /function decodeUplink/);
  assert.match(s, /__syscomNormalizePayloadBytes/);
  const out = runDecoderScript(s, 85, Buffer.from('0367FE000467E60005E763', 'hex'));
  assert.equal(out?.line_1_total_in, 7);
});

test('runDecoderScript: WT201 temperatura (payload Milesight canal 0x67)', () => {
  const hex = '0367FE000467E60005E763';
  const { store } = require('../store');
  const cfg = store.getDeviceDecodeConfig('24e124715d419053');
  const script = cfg?.decoderScript ? String(cfg.decoderScript) : '';
  if (!script.trim()) {
    console.log('skip WT201: sin decoder en BD');
    return;
  }
  const out = runDecoderScript(script, 85, Buffer.from(hex, 'hex'));
  assert.ok(out && (out.temperature != null || out.target_temperature != null), JSON.stringify(out));
});
