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

test('HEX de plantilla (medidor 022026003618) coinciden con válvula e intervalos operativos', () => {
  assert.equal(
    tw.buildValveCommand(REAL, false).toString('hex'),
    'fefefefe6818360026200268140e35dd93373533333363636363eeee9a16'
  );
  assert.equal(
    tw.buildValveCommand(REAL, true).toString('hex'),
    'fefefefe6818360026200268140e35dd93373533333363636363dddd7816'
  );
  assert.equal(
    tw.buildIntervalCommand(REAL, 1440).toString('hex'),
    'fefefefe6818360026200268140e3534a33735333333636363637347df16'
  );
  assert.equal(
    tw.buildIntervalCommand(REAL, 720).toString('hex'),
    'fefefefe6818360026200268140e3534a3373533333363636363533ab216'
  );
  assert.equal(
    tw.buildIntervalCommand(REAL, 60).toString('hex'),
    'fefefefe6818360026200268140e3534a33735333333636363639333eb16'
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

test('resolveTimewaveMeterNoFromHints: DevEUI en serial no tapa el medidor del body', () => {
  assert.equal(
    tw.resolveTimewaveMeterNoFromHints({
      deviceSerialHex: '004a7701240c107c',
      timewaveMeterNo: REAL,
    }),
    REAL
  );
});

test('resolveTimewaveMeterNoFromHints lee el medidor desde payload_hex DLT/645', () => {
  const payloadHex = tw.buildValveCommand(REAL, true).toString('hex');
  assert.equal(tw.resolveTimewaveMeterNoFromHints({ payloadHex }), REAL);
  assert.equal(
    tw.resolveTimewaveMeterNoFromHints({
      deviceSerialHex: '004a7701240c107c',
      payload_hex: payloadHex,
    }),
    REAL
  );
});

test('resolveTimewaveContextFromSources usa historial si el último uplink no es Timewave', () => {
  const readingHex = tw.buildIntervalCommand(REAL, 60).toString('hex');
  const ctx = tw.resolveTimewaveContextFromSources({
    latestProps: { fPort: 0, payload_hex: '03010a' },
    historyPropsList: [{ fPort: 2, payload_hex: readingHex, timewave_meterNo: REAL }],
    deviceSerialHex: '004a7701240c107c',
  });
  assert.equal(ctx.meter, REAL);
  assert.equal(ctx.lastAppFPort, 2);
});

test('resolveTimewaveMeterNoFromHints lee 14 hex ultrasónico desde payload', () => {
  const payloadHex = '6811404100262002000404a01700999a16';
  assert.equal(tw.resolveTimewaveMeterNoFromHints({ payloadHex }), '00022026004140');
});

test('resolveTimewaveDownlinkFPort no hereda el 85 de Milesight', () => {
  assert.equal(tw.resolveTimewaveDownlinkFPort({ explicitFPort: 85, configChannel: 85 }), 2);
  assert.equal(tw.resolveTimewaveDownlinkFPort({ lastUplinkFPort: 2, configChannel: 85 }), 2);
  assert.equal(tw.resolveTimewaveDownlinkFPort({ explicitFPort: 1 }), 1);
  assert.equal(tw.resolveTimewaveDownlinkFPort({ configChannel: '2' }), 2);
});

test('cierre de válvula es sticky; intervalo no; valve_ack libera', () => {
  const closeHex = tw.buildValveCommand(REAL, false).toString('hex');
  const intervalHex = tw.buildIntervalCommand(REAL, 1440).toString('hex');
  assert.equal(tw.isStickyTimewaveValveHex(closeHex), true);
  assert.equal(tw.isStickyTimewaveValveHex(intervalHex), false);
  assert.equal(tw.uplinkConfirmsValveCommand({ timewave_frame: 'valve_ack' }), true);
  assert.equal(tw.uplinkConfirmsValveCommand({ timewave_status: { valveClosed: true } }), true);
  assert.equal(tw.uplinkConfirmsValveCommand({ timewave_status: { valveClosed: false } }), false);
  assert.equal(tw.uplinkConfirmsValveCommand({ payload_hex: '0D' }), false);
});
