'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDb() {
  return path.join(os.tmpdir(), `syscom-device-latest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

if (!process.env.SYSCOM_SQLITE_PATH) {
  process.env.SYSCOM_SQLITE_PATH = tmpDb();
}

const { Store } = require('../store');

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

function assign(store, userId, deviceId) {
  const now = new Date().toISOString();
  store.upsertUserDevice({
    id: `${userId}-${deviceId}`,
    userId,
    deviceId,
    displayName: `Nodo ${deviceId}`,
    createdAt: now,
    updatedAt: now,
  });
}

test('device_latest: una fila de historial y listado visible para asignado (sin réplica)', () => {
  delete process.env.SYSCOM_TELEMETRY_MIRROR;
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'owner', 'admin');
    seedUser(store, 'peer', 'user');
    assign(store, 'owner', 'dev1');
    assign(store, 'peer', 'dev1');

    const sseUsers = [];
    store.setTelemetryBroadcastHook((ev) => {
      sseUsers.push(...(ev.userIds || []));
    });

    const ts = Date.now();
    store.appendTelemetry('owner', 'dev1', 'Nodo 1', { temperature: 21.5, payload_hex: 'AABB' }, ts);

    const histCount = store.db.prepare('SELECT COUNT(*) AS c FROM telemetry WHERE device_id = ?').get('dev1').c;
    assert.equal(histCount, 1);

    const snap = store.st.getDeviceLatest.get('dev1');
    assert.ok(snap);
    assert.equal(String(snap.user_id), 'owner');
    assert.equal(Number(snap.ts), ts);

    const peerHist = store.db
      .prepare('SELECT COUNT(*) AS c FROM telemetry WHERE user_id = ? AND device_id = ?')
      .get('peer', 'dev1').c;
    assert.equal(peerHist, 0);

    const listPeer = store.getLatestMapForDevices('peer', ['dev1']);
    assert.ok(listPeer.dev1);
    assert.equal(listPeer.dev1.properties.temperature, 21.5);

    assert.equal(store.resolveTelemetryUserId('peer', 'dev1', { role: 'user' }), 'owner');
    const hist = store.getTelemetryHistory('peer', 'dev1', { limit: 10 });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].properties.temperature, 21.5);

    assert.ok(sseUsers.includes('owner'));
    assert.ok(sseUsers.includes('peer'));
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('device_latest: SYSCOM_TELEMETRY_MIRROR=1 restaura copias por usuario', () => {
  process.env.SYSCOM_TELEMETRY_MIRROR = '1';
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'owner', 'admin');
    seedUser(store, 'peer', 'user');
    assign(store, 'owner', 'dev2');
    assign(store, 'peer', 'dev2');
    store.appendTelemetry('owner', 'dev2', 'Nodo 2', { humidity: 40 }, Date.now());
    const n = store.db.prepare('SELECT COUNT(*) AS c FROM telemetry WHERE device_id = ?').get('dev2').c;
    assert.equal(n, 2);
  } finally {
    delete process.env.SYSCOM_TELEMETRY_MIRROR;
    store.close();
    unlinkDb(file);
  }
});

test('device_latest: backfill perezoso desde telemetry indexada', () => {
  delete process.env.SYSCOM_TELEMETRY_MIRROR;
  const file = tmpDb();
  const store = new Store(file);
  try {
    seedUser(store, 'owner', 'admin');
    assign(store, 'owner', 'dev3');
    store.db
      .prepare(
        `INSERT INTO telemetry (user_id, device_id, device_name, properties_json, ts)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('owner', 'dev3', 'Nodo 3', JSON.stringify({ rssi: -80 }), Date.now());
    store.db.prepare('DELETE FROM device_latest WHERE device_id = ?').run('dev3');
    const n = store.ensureDeviceLatestBackfill(50);
    assert.equal(n, 1);
    const snap = store.st.getDeviceLatest.get('dev3');
    assert.ok(snap);
    assert.equal(JSON.parse(snap.properties_json).rssi, -80);
  } finally {
    store.close();
    unlinkDb(file);
  }
});
