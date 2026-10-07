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

test('purgeQueuedAppDownlinksForDevice borra HEX diferido y marca el historial', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    const ins = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 2, HEX, {});
    store.appendDownlinkLog('syscom', {
      deviceId: DEV_EUI,
      devEUI: DEV_EUI,
      deferred: true,
      pendingId: ins.id,
      payloadHex: HEX,
    });
    const r = store.purgeQueuedAppDownlinksForDevice(DEV_EUI, DEV_EUI);
    assert.equal(r.deferredRemoved, 1);
    assert.equal(store.lnsPeekOldestDeferredAppDownlink('syscom', DEV_EUI), null);
    assert.equal(r.logsCancelled, 1);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('Join-Accept caducado se descarta y no tapa el HEX de aplicación', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    store.lnsEnqueuePullResp(
      'syscom',
      '24e124fffefaf79f',
      { txpk: { imme: false }, _syscomLnsKind: 'join_accept' },
      0,
      255,
      { devEui: DEV_EUI }
    );
    store.db.prepare('UPDATE lorawan_lns_downlink SET created_at = ?').run(Date.now() - 60_000);
    assert.equal(store.lnsDropStalePendingJoinAccepts(8000) > 0, true);
    const left = store.db.prepare('SELECT COUNT(*) AS n FROM lorawan_lns_downlink WHERE status = ?').get('pending').n;
    assert.equal(Number(left), 0);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('TOO_LATE clase A devuelve el HEX a la cola diferida, no lo pasa a imme', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    const hex = 'fefefefe6818360026200268140e35dd93373533333363636363eeee9a16';
    const pull = {
      txpk: { imme: false, tmst: 99, freq: 923.3, datr: 'SF10BW500' },
      _syscomAppRestore: {
        fPort: 2,
        payloadHex: hex,
        deviceClass: 'A',
        confirmed: false,
        devEui: DEV_EUI,
      },
    };
    const restored = store._lnsRestoreClassAAppDownlink({
      user_id: 'syscom',
      tx_dev_eui: DEV_EUI,
      pull_resp_json: JSON.stringify(pull),
    });
    assert.equal(restored, true);
    const peeked = store.lnsPeekOldestDeferredAppDownlink('syscom', DEV_EUI);
    assert.ok(peeked);
    assert.equal(peeked.payloadHex, hex);
    assert.equal(peeked.fPort, 2);
    assert.ok(peeked.priority >= 254);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('TOO_LATE no duplica el HEX si la cola sticky ya lo tiene', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    const hex = 'fefefefe6818360026200268140e35dd93373533333363636363eeee9a16';
    const ins = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 2, hex, { deviceClass: 'A' });
    assert.equal(ins.ok, true);
    const pull = {
      txpk: { imme: false, tmst: 1 },
      _syscomAppRestore: {
        fPort: 2,
        payloadHex: hex,
        deviceClass: 'A',
        confirmed: false,
        devEui: DEV_EUI,
      },
    };
    assert.equal(
      store._lnsRestoreClassAAppDownlink({
        user_id: 'syscom',
        tx_dev_eui: DEV_EUI,
        pull_resp_json: JSON.stringify(pull),
      }),
      true
    );
    assert.equal(store.lnsCountDeferredAppDownlinks('syscom', DEV_EUI), 1);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('uplink de datos cancela Join-Accept pendiente del mismo DevEUI', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    store.lnsEnqueuePullResp(
      'syscom',
      '24e124fffefaf79f',
      { txpk: { imme: false }, _syscomLnsKind: 'join_accept' },
      0,
      255,
      { devEui: DEV_EUI }
    );
    assert.equal(store.lnsCancelPendingJoinAcceptsForDevEui(DEV_EUI) > 0, true);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('no duplica la misma acción diferida; otra acción sí se encola', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    const first = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 85, 'ff01', { deviceClass: 'C' });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, undefined);
    const again = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 85, 'ff01', { deviceClass: 'C' });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(again.kind, 'deferred');
    assert.equal(store.lnsCountDeferredAppDownlinks('syscom', DEV_EUI), 1);
    const other = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 85, 'ff00', { deviceClass: 'C' });
    assert.equal(other.ok, true);
    assert.equal(other.duplicate, undefined);
    assert.equal(store.lnsCountDeferredAppDownlinks('syscom', DEV_EUI), 2);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('misma acción en PULL_RESP pendiente bloquea otra copia; al enviarse se puede volver a encolar', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    const hex = 'ff01';
    store.lnsEnqueuePullResp(
      'syscom',
      '24e124fffefaf79f',
      {
        txpk: { imme: true },
        _syscomAppAction: { fPort: 85, payloadHex: hex, devEui: DEV_EUI },
      },
      0,
      200,
      { devEui: DEV_EUI }
    );
    const queued = store.lnsFindQueuedSameAppAction(DEV_EUI, 85, hex);
    assert.ok(queued);
    assert.equal(queued.kind, 'pending');
    const dup = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 85, hex, { deviceClass: 'C' });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.kind, 'pending');
    assert.equal(store.lnsCountDeferredAppDownlinks('syscom', DEV_EUI), 0);
    store.db.prepare(`UPDATE lorawan_lns_downlink SET status = 'sent'`).run();
    assert.equal(store.lnsFindQueuedSameAppAction(DEV_EUI, 85, hex), null);
    const fresh = store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 85, hex, { deviceClass: 'C' });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.duplicate, undefined);
    assert.equal(store.lnsCountDeferredAppDownlinks('syscom', DEV_EUI), 1);
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('soltar radio de un DevEUI sin alta borra sesión y cola', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'syscom', 'superadmin');
    upsertSession(store, { userId: 'syscom', devAddr: '384A726A', updatedAt: '2026-10-07T15:00:00.000Z' });
    store.lnsInsertDeferredAppDownlink('syscom', DEV_EUI, 2, HEX, { deviceClass: 'A' });
    assert.equal(store.userDeviceExistsForDevEui(DEV_EUI), false);
    const dropped = store.lnsDropRadioStateForDevEui(DEV_EUI);
    assert.equal(dropped.sessions, 1);
    assert.equal(dropped.deferred, 1);
    assert.equal(store.lnsGetSessionByDevEui('syscom', DEV_EUI), null);
    assert.equal(store.lnsPeekOldestDeferredAppDownlink('syscom', DEV_EUI), null);
  } finally {
    store.close();
    unlinkDb(file);
  }
});
