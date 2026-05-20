'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(
  path.join(__dirname, '../../src/utils/inferDecoderTelemetryLabels.js')
).href;

const vs133Path = path.join(__dirname, '../../src/constants/vs133DecoderScript.js');
const ws101Path = path.join(__dirname, '../../src/constants/ws101DecoderScript.js');

function extractExportedScript(filePath, exportName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const backtick = `export const ${exportName} = \``;
  const btStart = raw.indexOf(backtick);
  if (btStart >= 0) {
    const from = btStart + backtick.length;
    const end = raw.indexOf('`;', from);
    if (end >= 0) return raw.slice(from, end);
  }
  const quoted = new RegExp(`export const ${exportName}\\s*=\\s*"([\\s\\S]*)";\\s*$`);
  const m = quoted.exec(raw);
  return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : raw;
}

test('infer WS101: led_indicator_enable y press', async () => {
  const { inferTelemetryLabelsFromDecoderScript } = await import(modUrl);
  const script = extractExportedScript(ws101Path, 'WS101_DECODER_SCRIPT');
  const { labelsByField } = inferTelemetryLabelsFromDecoderScript(script);
  assert.equal(labelsByField.led_indicator_enable?.valueLabels?.['1'], 'Enable');
  assert.equal(labelsByField.press?.valueLabels?.['1'], 'Short');
  assert.equal(labelsByField['button_event.status']?.valueLabels?.['2'], 'Long');
});

test('infer VS133: confirm_mode_enable y occlusion_alarm', async () => {
  const { inferTelemetryLabelsFromDecoderScript } = await import(modUrl);
  const script = extractExportedScript(vs133Path, 'VS133_DECODER_SCRIPT');
  const { labelsByField } = inferTelemetryLabelsFromDecoderScript(script);
  assert.equal(labelsByField.confirm_mode_enable?.valueLabels?.['1'], 'Enable');
  const alarmKey = Object.keys(labelsByField).find((k) => k.includes('occlusion_alarm'));
  assert.ok(alarmKey);
  assert.equal(labelsByField[alarmKey].valueLabels['1'], 'Alarm triggered');
});
