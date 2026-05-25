'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
function normalizeDownlinkHex(hex) {
  const t = String(hex ?? '')
    .replace(/\s/g, '')
    .toLowerCase()
    .replace(/^0x/, '');
  if (!t || !/^[0-9a-f]+$/i.test(t) || t.length % 2 !== 0) return '';
  return t;
}

function resolveSwitchDownlinkHexPair(switchData, downlinkList) {
  const dls = Array.isArray(downlinkList) ? downlinkList : [];
  const pickHex = (stored) => {
    const n = normalizeDownlinkHex(stored);
    if (!n) return null;
    const hit = dls.find((d) => normalizeDownlinkHex(d.hex) === n);
    return hit ? normalizeDownlinkHex(hit.hex) : n;
  };
  const onHex = pickHex(switchData?.switchHexOn);
  const offHex = pickHex(switchData?.switchHexOff);
  if (onHex && offHex) return { onHex, offHex };
  if (dls.length >= 2) {
    return { onHex: normalizeDownlinkHex(dls[0].hex), offHex: normalizeDownlinkHex(dls[1].hex) };
  }
  return { onHex: onHex || null, offHex: offHex || null };
}

function inferSwitchStateFromDownlinkHex(hex, pair) {
  const n = normalizeDownlinkHex(hex);
  if (!n || !pair) return null;
  if (pair.onHex && n === pair.onHex) return true;
  if (pair.offHex && n === pair.offHex) return false;
  return null;
}

describe('switch downlink binding', () => {
  it('resuelve ON/OFF desde configuración del widget', () => {
    const pair = resolveSwitchDownlinkHexPair(
      { switchHexOn: 'ffc501', switchHexOff: 'ffc500' },
      [{ hex: 'ffc501' }, { hex: 'ffc500' }]
    );
    assert.equal(pair.onHex, 'ffc501');
    assert.equal(pair.offHex, 'ffc500');
    assert.equal(inferSwitchStateFromDownlinkHex('FF C5 01', pair), true);
    assert.equal(inferSwitchStateFromDownlinkHex('ffc500', pair), false);
    assert.equal(inferSwitchStateFromDownlinkHex('ff10ff', pair), null);
  });
});
