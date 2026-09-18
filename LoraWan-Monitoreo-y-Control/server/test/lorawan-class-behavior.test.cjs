'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downlinkDeferUntilUplink, downlinkUsesClassCImme } = require('../lib/lorawan-class-behavior.cjs');

test('clase C: downlink inmediato sin esperar uplink', () => {
  assert.equal(downlinkDeferUntilUplink('C'), false);
  assert.equal(downlinkUsesClassCImme('C'), true);
});

test('clase A: esperar ventana / cola tras uplink', () => {
  assert.equal(downlinkDeferUntilUplink('A'), true);
  assert.equal(downlinkUsesClassCImme('A'), false);
});

test('classARxStillOpen: RX1 de 1 s no admite un click 2 s después del uplink', () => {
  const { classARxStillOpen } = require('../lib/lorawan-class-behavior.cjs');
  assert.equal(classARxStillOpen(50, 1, { slackMs: 300 }), true);
  assert.equal(classARxStillOpen(2000, 1, { slackMs: 300 }), false);
  assert.equal(classARxStillOpen(2000, 5, { slackMs: 300 }), true);
  assert.equal(classARxStillOpen(4800, 5, { slackMs: 300 }), false);
  assert.equal(classARxStillOpen(1500, 1, { windowMode: 'RX2', rx2AfterRx1Sec: 1, slackMs: 300 }), true);
  assert.equal(classARxStillOpen(2500, 1, { windowMode: 'RX2', rx2AfterRx1Sec: 1, slackMs: 300 }), false);
});

test('hueco clase C post-uplink + GAP retrasa PULL_RESP más allá de RX1 US915 (5 s)', () => {
  const {
    classCGwFloorMissesClassARx1,
    downlinkPullRespUsesClassCGwFloor,
  } = require('../lib/lorawan-class-behavior.cjs');
  const postUplinkQuietMs = Math.max(1600, Math.floor(4500 * 0.55));
  assert.equal(classCGwFloorMissesClassARx1(postUplinkQuietMs, 4500, 5, 300), true);
  assert.equal(classCGwFloorMissesClassARx1(0, 0, 5, 300), false);
  assert.equal(downlinkPullRespUsesClassCGwFloor('A'), false);
  assert.equal(downlinkPullRespUsesClassCGwFloor('B'), false);
  assert.equal(downlinkPullRespUsesClassCGwFloor('C'), true);
});

test('resolveClassARxDelaySec: US915 no transmite a +1 s si la sesión quedó en default 1', () => {
  const { resolveClassARxDelaySec } = require('../lib/lorawan-class-behavior.cjs');
  assert.equal(resolveClassARxDelaySec(1, true), 5);
  assert.equal(resolveClassARxDelaySec(null, true), 5);
  assert.equal(resolveClassARxDelaySec(5, true), 5);
  assert.equal(resolveClassARxDelaySec(1, false), 1);
  assert.equal(resolveClassARxDelaySec(null, false), 1);
});

test('shouldSuppressOtaaJoinForLiveSession: no rotar claves si hay fcntUp reciente', () => {
  const { shouldSuppressOtaaJoinForLiveSession } = require('../lib/lorawan-class-behavior.cjs');
  const now = 1_789_745_324_126;
  const win = 3 * 60 * 60 * 1000;
  assert.equal(
    shouldSuppressOtaaJoinForLiveSession(
      { fcntUp: 2, lastUplinkWallMs: now - 60 * 60 * 1000 },
      now,
      win
    ),
    true
  );
  assert.equal(
    shouldSuppressOtaaJoinForLiveSession({ fcntUp: -1, lastUplinkWallMs: now - 1000 }, now, win),
    false
  );
  assert.equal(
    shouldSuppressOtaaJoinForLiveSession(
      { fcntUp: 2, lastUplinkWallMs: now - 4 * 60 * 60 * 1000 },
      now,
      win
    ),
    false
  );
  assert.equal(shouldSuppressOtaaJoinForLiveSession({ fcntUp: 2, lastUplinkWallMs: now }, now, 0), false);
});

test('ACK-only FPort 0: MIC válido con NwkSKey', () => {
  const lora_packet = require('lora-packet');
  const nwk = Buffer.alloc(16, 1);
  const app = Buffer.alloc(16, 2);
  const pkt = lora_packet.fromFields(
    {
      MType: 'Unconfirmed Data Down',
      DevAddr: Buffer.from('2412B410', 'hex'),
      FCtrl: { ADR: false, ACK: true, FPending: false },
      FCnt: 0,
      FPort: 0,
      payload: Buffer.alloc(0),
    },
    app,
    nwk,
    null
  );
  assert.equal(pkt.getFPort(), 0);
  assert.equal(pkt.getFCtrlACK(), true);
  const mic = pkt.MIC;
  assert.ok(Buffer.isBuffer(mic) && mic.length === 4);
  assert.notEqual(mic.toString('hex').toLowerCase(), 'eeeeeeee');
  assert.equal(lora_packet.verifyMIC(pkt, nwk, undefined, Buffer.from('0000', 'hex')), true);
});
