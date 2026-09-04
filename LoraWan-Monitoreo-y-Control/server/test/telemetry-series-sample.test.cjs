'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDb() {
  return path.join(
    os.tmpdir(),
    `syscom-telemetry-sample-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
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

test('getTelemetrySeries con bucketMs cubre el inicio del rango (no solo las últimas N filas)', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    store.insertUser({
      id: 'owner',
      email: 'owner@test.local',
      password: 'x',
      role: 'admin',
      ingestToken: 'tok-owner',
      createdAt: new Date().toISOString(),
    });
    const end = Date.now();
    const start = end - 24 * 3600000;
    const n = 2000;
    for (let i = 0; i < n; i += 1) {
      const ts = start + Math.floor((i / (n - 1)) * (end - start));
      store.appendTelemetry('owner', 'dev-hist', 'Sensor', { temperature: 20 + (i % 5), seq: i }, ts);
    }

    const recentOnly = store.getTelemetrySeries('owner', 'dev-hist', start, end, null, 100);
    assert.equal(recentOnly.length, 100);
    assert.ok(
      recentOnly[0].timestamp > start + 12 * 3600000,
      'sin muestreo, LIMIT 100 solo trae la tarde/noche'
    );

    const sampled = store.getTelemetrySeries('owner', 'dev-hist', start, end, null, 100, 15 * 60 * 1000);
    assert.ok(sampled.length >= 80, `esperaba ~96 cubos de 15 min, llegó ${sampled.length}`);
    assert.ok(
      sampled[0].timestamp - start < 20 * 60 * 1000,
      'el primer cubo debe estar cerca del inicio de las 24 h'
    );
    assert.ok(
      end - sampled[sampled.length - 1].timestamp < 20 * 60 * 1000,
      'el último cubo debe estar cerca de ahora'
    );
  } finally {
    store.close();
    unlinkDb(file);
  }
});

test('getTelemetrySeries con propKey prefiere la fila del cubo que trae esa propiedad', () => {
  const file = tmpDb();
  const store = new Store(file);
  try {
    store.insertUser({
      id: 'owner',
      email: 'owner@test.local',
      password: 'x',
      role: 'admin',
      ingestToken: 'tok-owner',
      createdAt: new Date().toISOString(),
    });
    const bucket = 15 * 60 * 1000;
    const t0 = Math.floor(Date.now() / bucket) * bucket;
    store.appendTelemetry('owner', 'wt201', 'Termostato', { temperature: 24 }, t0 + 60 * 1000);
    store.appendTelemetry(
      'owner',
      'wt201',
      'Termostato',
      { temperature_control_status: 'heat', fPort: 85 },
      t0 + 10 * 60 * 1000
    );

    const withoutKey = store.getTelemetrySeries('owner', 'wt201', t0, t0 + bucket - 1, null, 50, bucket);
    assert.equal(withoutKey.length, 1);
    assert.equal(withoutKey[0].properties.temperature, undefined);

    const withKey = store.getTelemetrySeries('owner', 'wt201', t0, t0 + bucket - 1, 'temperature', 50, bucket);
    assert.equal(withKey.length, 1);
    assert.equal(withKey[0].properties.temperature, 24);
  } finally {
    store.close();
    unlinkDb(file);
  }
});
