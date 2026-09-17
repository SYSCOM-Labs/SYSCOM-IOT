'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDb() {
  return path.join(
    os.tmpdir(),
    `syscom-deferred-dl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

if (!process.env.SYSCOM_SQLITE_PATH) {
  process.env.SYSCOM_SQLITE_PATH = tmpDb();
}

const { Store } = require('../store');

const DEV_EUI = '004a7701240c107c';
const HEX = 'fefefefe6818360026200268140e35dd9337353333333636363eeee9a16a';

function unlinkDb(filePath) {
  for (const p of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function seedUser(store, id, role) {
  store.insertUser({
    id,
    email: `${id}@test.local`,
    password: 'x',
    role,
    ingestToken: `tok-${id}`,
    createdAt: new Date().toISOString(),
  });
}

function upsertSession(store, { userId, devAddr, updatedAt }) {
  store.st.lnsUpsertSession.run(
    userId,
    DEV_EUI,
    String(devAddr).toUpperCase(),
    '11'.repeat(16),
    '22'.repeat(16),
    -1,
    -1,
    '24e124fffefaf79f',
    1,
    904.1,
    'SF9BW125',
    '4/5',
    0,
    'A',
    Date.now(),
    -1,
    null,
    5,
    0,
    updatedAt
  );
}

test('flush clase A: HEX encolado por SYSCOM se ve en el uplink de otra cuenta', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    seedUser(store, 'daniel', 'admin');
    const ins = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 2, HEX, { confirmed: false });
    assert.equal(ins.ok, true);
    assert.equal(store.lnsPeekOldestDeferredAppDownlink('syscom', DEV_EUI).id, ins.id);
    const peeked = store.lnsPeekOldestDeferredAppDownlink('daniel', DEV_EUI);
    assert.ok(peeked);
    assert.equal(peeked.id, ins.id);
    assert.equal(peeked.userId, 'syscom');
    assert.equal(store.lnsCountDeferredAppDownlinks('daniel', DEV_EUI), 1);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('OTAA join borra sesión vieja de otra cuenta y el HEX diferido permanece', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    seedUser(store, 'daniel', 'admin');
    upsertSession(store, { userId: 'syscom', devAddr: '384A726A', updatedAt: '2026-09-17T20:00:00.000Z' });
    store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 2, HEX, {});
    store.lnsUpsertSessionJoin({
      userId: 'daniel',
      devEui: DEV_EUI,
      devAddr: '9F15F60B',
      nwkSKeyHex: '11'.repeat(16),
      appSKeyHex: '22'.repeat(16),
      lastGatewayEui: '24e124fffefaf79f',
      lastRxTmst: 2,
      lastRxFreq: 904.1,
      lastRxDatr: 'SF9BW125',
      lastRxCodr: '4/5',
      lastRxRfch: 0,
      deviceClass: 'A',
      lastUplinkWallMs: Date.now(),
      rxDelaySec: 5,
    });
    assert.equal(store.lnsGetSessionByDevEui('syscom', DEV_EUI), null);
    assert.ok(store.lnsGetSessionByDevEui('daniel', DEV_EUI));
    const peeked = store.lnsPeekOldestDeferredAppDownlink('daniel', DEV_EUI);
    assert.ok(peeked);
    assert.equal(peeked.userId, 'syscom');
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('superadmin encola contra la sesión OTAA más reciente, no contra DevAddr obsoleto', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    seedUser(store, 'daniel', 'admin');
    upsertSession(store, { userId: 'syscom', devAddr: '384A726A', updatedAt: '2026-09-17T20:00:00.000Z' });
    upsertSession(store, { userId: 'daniel', devAddr: '9F15F60B', updatedAt: '2026-09-17T21:30:00.000Z' });
    const uid = store.lnsResolveSessionUserIdForDevice('004a7701240c107c', 'syscom', DEV_EUI, {
      allowGlobalSessionFallback: true,
    });
    assert.equal(uid, 'daniel');
  } finally {
    store.close();
    unlinkDb(file);
  }
});
