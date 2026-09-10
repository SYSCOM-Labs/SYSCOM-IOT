'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tw = require('../timewave-water-meter.js');

const EXAMPLE = '022025001955';
const REAL = '022026003618';

test('buildValveCommand scramblea AAAA/BBBB a DDDD/EEEE', () => {
  const open = tw.buildValveCommand(EXAMPLE, true).toString('hex');
  const close = tw.buildValveCommand(EXAMPLE, false).toString('hex');
  assert.equal(open, 'fefefefe6855190025200268140e35dd93373533333363636363dddd9716');
  assert.equal(close, 'fefefefe6855190025200268140e35dd93373533333363636363eeeeb916');
  assert.match(open, /dddd/);
  assert.match(close, /eeee/);
  assert.doesNotMatch(open, /aaaa/);
  assert.doesNotMatch(close, /bbbb/);
});

test('buildIntervalCommand 60 y 1440 coinciden con el PDF (medidor ejemplo)', () => {
  assert.equal(
    tw.buildIntervalCommand(EXAMPLE, 1440).toString('hex'),
    'fefefefe6855190025200268140e3534a33735333333636363637347fe16'
  );
  assert.equal(
    tw.buildIntervalCommand(EXAMPLE, 60).toString('hex'),
    'fefefefe6855190025200268140e3534a337353333336363636393330a16'
  );
});

test('rewriteDownlinkHex sustituye medidor y corrige válvula AAAA legado', () => {
  const legacyOpen = 'fefefefe6855190025200268140e35dd93373533333363636363aaaa3116';
  const rewritten = tw.rewriteDownlinkHex(legacyOpen, REAL);
  const expected = tw.buildValveCommand(REAL, true).toString('hex');
  assert.equal(rewritten, expected);
  assert.equal(tw.parseMeterNoFromFrame(Buffer.from(rewritten, 'hex').subarray(5, 11)), REAL);
});

test('rewriteDownlinkHex intervalo 60 con medidor real', () => {
  const tpl60 = 'fefefefe6855190025200268140e3534a337353333336363636393330a16';
  const rewritten = tw.rewriteDownlinkHex(tpl60, REAL);
  assert.equal(rewritten, tw.buildIntervalCommand(REAL, 60).toString('hex'));
});

test('rewriteDownlinkHex no toca payloads que no son TimeWave', () => {
  assert.equal(tw.rewriteDownlinkHex('261f0146', REAL), null);
  assert.equal(tw.rewriteDownlinkHex('ff10ff', REAL), null);
});

test('resolveTimewaveMeterNoFromHints prioriza uplink sobre serial', () => {
  assert.equal(
    tw.resolveTimewaveMeterNoFromHints({
      deviceSerialHex: '022025001955',
      timewave_meterNo: REAL,
    }),
    REAL
  );
  assert.equal(tw.normalizeTimewaveMeterNo12('004a7701240c107c'), null);
  assert.equal(tw.normalizeTimewaveMeterNo12(REAL), REAL);
});
