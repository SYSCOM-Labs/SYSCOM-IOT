'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const us = require('../timewave-ultrasonic-water-meter.js');
const tw = require('../timewave-water-meter.js');

const EXAMPLE = '00022026004140';
const OTHER = '00022026009999';

const SPEC_CLOSE = '6811404100262002000404a01700999a16';
const SPEC_OPEN = '6811404100262002000404a01700555616';
const SPEC_CANCEL = '6811404100262002000404a01700777816';
const SPEC_READ_REQ = '68114041002620020001039097006d16';
const SPEC_UPLOAD_24H = '681140410026200200020ca119009097180190983c0800b616';
const SPEC_READING =
  '681140410026200200811f9097002b00000000000000000000000000000000360000a00a0000000000001416';

test('HEX de la ficha V1.0.2: cerrar / abrir / cancelar válvula', () => {
  assert.equal(us.buildCloseValveCommand(EXAMPLE).toString('hex'), SPEC_CLOSE);
  assert.equal(us.buildOpenValveCommand(EXAMPLE).toString('hex'), SPEC_OPEN);
  assert.equal(us.buildValveCommand(EXAMPLE, us.VALVE_CANCEL_CONTROL).toString('hex'), SPEC_CANCEL);
});

test('HEX de la ficha V1.0.2: parámetros de subida 24 h', () => {
  assert.equal(us.buildUploadParamsCommand(EXAMPLE, { reportIntervalHours: 24 }).toString('hex'), SPEC_UPLOAD_24H);
});

test('decodeFrame lectura 9097 del ejemplo V1.0.2', () => {
  const d = us.decodeFrame(Buffer.from(SPEC_READING, 'hex'));
  assert.ok(d);
  assert.equal(d.timewave_family, 'ultrasonic_cjt188');
  assert.equal(d.timewave_meterNo, EXAMPLE);
  assert.equal(d.timewave_frame, 'reading');
  assert.equal(d.timewave_di, '9097');
  assert.equal(d.timewave_checksum_ok, true);
  assert.equal(d.water_cumulative_m3, 0);
  assert.equal(d.temperature_c, 27.2);
  assert.equal(d.timewave_status.valveOpen, true);
});

test('rewriteDownlinkHex sustituye address 14 hex y recálcula CS', () => {
  const rewritten = us.rewriteDownlinkHex(SPEC_CLOSE, OTHER);
  const d = us.decodeFrame(Buffer.from(rewritten, 'hex'));
  assert.equal(d.timewave_meterNo, OTHER);
  assert.equal(d.timewave_checksum_ok, true);
  assert.match(rewritten, /^6811999900262002000404a0170099/);
});

test('no rellena 12 hex a 14: el mecánico no se convierte en ultrasónico', () => {
  assert.equal(us.normalizeMeterNo14('022026003618'), null);
  assert.equal(us.normalizeMeterNo14(EXAMPLE), EXAMPLE);
});

test('el dispatcher mecánico no reescribe CJ/T 188 como DLT/645', () => {
  const out = tw.rewriteDownlinkHex(SPEC_CLOSE, EXAMPLE);
  assert.equal(out, SPEC_CLOSE);
  assert.equal(tw.decodeFrame(Buffer.from(SPEC_CLOSE, 'hex')), null);
});

test('el dispatcher mecánico sigue reescribiendo DLT/645', () => {
  const real = '022026003618';
  const legacyOpen = 'fefefefe6855190025200268140e35dd93373533333363636363aaaa3116';
  const rewritten = tw.rewriteDownlinkHex(legacyOpen, real);
  assert.equal(rewritten, tw.buildValveCommand(real, true).toString('hex'));
  assert.equal(tw.decodeFrame(Buffer.from(rewritten, 'hex')).timewave_family, 'mechanical_dlt645');
});

test('looksLikeTimewaveHex reconoce ambas familias', () => {
  assert.equal(tw.looksLikeTimewaveHex(SPEC_CLOSE), true);
  assert.equal(tw.looksLikeTimewaveHex(tw.buildValveCommand('022026003618', false).toString('hex')), true);
  assert.equal(us.looksLikeUltrasonicHex(tw.buildValveCommand('022026003618', false).toString('hex')), false);
});

test('solicitud de lectura 9097 de la ficha', () => {
  const built = us.buildFrame(EXAMPLE, us.METER_TYPE_ULTRASONIC, 0x01, Buffer.concat([us.DI_CUMULATIVE, Buffer.from([0])]));
  assert.equal(built.toString('hex'), SPEC_READ_REQ);
});
