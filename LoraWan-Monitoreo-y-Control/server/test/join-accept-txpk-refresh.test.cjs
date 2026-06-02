'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLorawanLnsEngine } = require('../lorawan-lns-engine');

const DEV_EUI = '0123456789abcdef';

function mockStoreForJoinRefresh(deviceClass) {
  const session = {
    userId: 'u1',
    devEui: DEV_EUI,
    devAddr: 'AABBCCDD',
    nwkSKey: Buffer.alloc(16, 1),
    appSKey: Buffer.alloc(16, 2),
    fcntUp: -1,
    fcntDown: -1,
    lastGatewayEui: '0011223344556677',
    lastRxTmst: 1_000_000,
    lastRxFreq: 904.6,
    lastRxDatr: 'SF10BW125',
    lastRxCodr: '4/5',
    lastRxRfch: 0,
    deviceClass,
    lastUplinkWallMs: Date.now(),
    rxDelaySec: 5,
  };
  return {
    db: { prepare: () => ({ get: () => null }) },
    lnsGetSessionByDevEui: () => session,
    lnsGetGatewayByEui: () => ({ frequencyBand: 'US915 FSB2' }),
    getUserDeviceByDevEuiNorm: () => ({ deviceId: 'dev-1', productModel: 'Milesight' }),
    getDeviceDecodeConfig: () => ({ lorawanClass: deviceClass }),
    getLorawanGatewayEuiNormForUser: (_uid, mac) => mac.toString('hex'),
  };
}

function refreshJoinAccept(eng, extraRow) {
  const joinTxpk = {
    _syscomLnsKind: 'join_accept',
    txpk: {
      imme: false,
      tmst: 6_000_000,
      freq: 923.3,
      datr: 'SF12BW500',
      rfch: 0,
      powe: 14,
      modu: 'LORA',
      ipol: true,
      size: 33,
      data: 'AA==',
    },
  };
  return JSON.parse(
    eng.refreshPullRespJsonBeforeSend({
      userId: 'u1',
      json: JSON.stringify(joinTxpk),
      txDevEui: DEV_EUI,
      priority: 255,
      txNewFcnt: null,
      joinSessionJson: null,
      ...extraRow,
    })
  );
}

for (const cls of ['A', 'B', 'C']) {
  test(`Join-Accept clase ${cls}: refresh mantiene tmst RX1, no imme (todos los modelos)`, () => {
    const eng = createLorawanLnsEngine({
      store: mockStoreForJoinRefresh(cls),
      saveIngestEntry: () => {},
      runLegacyUplink: () => {},
      insertUiEvent: () => {},
    });
    const out = refreshJoinAccept(eng);
    assert.equal(out._syscomLnsKind, 'join_accept');
    assert.equal(out.txpk.imme, false, `clase ${cls}: Join-Accept no debe ser imme`);
    assert.equal(Number(out.txpk.tmst), 6_000_000, `clase ${cls}: tmst = JR + RxDelay`);
    assert.equal(out.txpk.datr, 'SF10BW500', `clase ${cls}: DR RX1 US915`);
  });
}

test('Join-Accept: detecta marca _syscomLnsKind sin prioridad 255', () => {
  const eng = createLorawanLnsEngine({
    store: mockStoreForJoinRefresh('C'),
    saveIngestEntry: () => {},
    runLegacyUplink: () => {},
    insertUiEvent: () => {},
  });
  const out = refreshJoinAccept(eng, { priority: 200 });
  assert.equal(out.txpk.imme, false);
});

test('Join-Accept diferido (join_session_json, sin sesión en BD)', () => {
  const upsert = {
    userId: 'u1',
    devEui: DEV_EUI,
    devAddr: 'AABBCCDD',
    lastGatewayEui: '0011223344556677',
    lastRxTmst: 2_000_000,
    lastRxFreq: 904.6,
    lastRxDatr: 'SF10BW125',
    lastRxCodr: '4/5',
    lastRxRfch: 0,
    deviceClass: 'A',
    rxDelaySec: 5,
    lastUplinkWallMs: Date.now(),
  };
  const eng = createLorawanLnsEngine({
    store: {
      db: { prepare: () => ({ get: () => null }) },
      lnsGetSessionByDevEui: () => null,
      lnsGetGatewayByEui: () => ({ frequencyBand: 'US915 FSB2' }),
      getLorawanGatewayEuiNormForUser: (_uid, mac) => mac.toString('hex'),
    },
    saveIngestEntry: () => {},
    runLegacyUplink: () => {},
    insertUiEvent: () => {},
  });
  const out = refreshJoinAccept(eng, {
    joinSessionJson: JSON.stringify({ upsert, telemetry: null }),
  });
  assert.equal(out.txpk.imme, false);
  assert.equal(Number(out.txpk.tmst), 7_000_000);
});
