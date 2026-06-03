'use strict';

/**
 * Pruebas de seguridad de la capa LoRaWAN/red (UDP Semtech GWMP, puerto 1700).
 *
 * Ejecutar:  node --test server/test/security-lorawan.test.cjs
 *
 * Arranca server/server.js como proceso hijo con un puerto UDP de prueba y un
 * puerto HTTP de prueba, crea un superadmin y comprueba el comportamiento del
 * listener UDP frente a paquetes no autenticados.
 *
 * Hallazgo central (SEC): el listener UDP no autentica al emisor y, con
 * SYSCOM_LNS_AUTO_REGISTER_GATEWAY=1 (DEFECTO), un PUSH_DATA con un EUI
 * arbitrario AUTO-REGISTRA un gateway en la cuenta superadmin. Cualquiera que
 * alcance el puerto 1700 puede contaminar la flota e inyectar telemetría.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildPushData(euiHex, jsonStr = '{}') {
  // version(1) token(2) id(1)=0x00 MAC(8) JSON
  const header = Buffer.from([0x02, 0x12, 0x34, 0x00]);
  const mac = Buffer.from(euiHex, 'hex');
  assert.equal(mac.length, 8, 'EUI debe ser 8 bytes');
  return Buffer.concat([header, mac, Buffer.from(jsonStr, 'utf8')]);
}

async function bootServer(extraEnv) {
  const httpPort = 43000 + Math.floor(Math.random() * 1000);
  const udpPort = 47000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${httpPort}`;
  const dbPath = path.join(os.tmpdir(), `syscom-secudp-${httpPort}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const proc = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(httpPort),
      SYSCOM_SQLITE_PATH: dbPath,
      SYSCOM_LNS_MAC: '0',
      LNS_UDP_PORT: String(udpPort),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => (stderr += c.toString()));

  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) break;
    try {
      const r = await fetch(`${base}/api/setup/status`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* ignore */
    }
    await wait(100);
  }
  return {
    base,
    httpPort,
    udpPort,
    proc,
    ready,
    getStderr: () => stderr,
    async stop() {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      await wait(100);
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function jsonReq(base, method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  const txt = await r.text();
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  return { status: r.status, data };
}

function sendUdp(udpPort, buf) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.send(buf, udpPort, '127.0.0.1', (err) => {
      s.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

async function setupSuper(base) {
  await jsonReq(base, 'POST', '/api/setup', {
    body: { email: 'udp-super@test.local', password: 'UdpPass1!', profileName: 'UDP Super' },
  });
  const login = await jsonReq(base, 'POST', '/api/auth/login', {
    body: { email: 'udp-super@test.local', password: 'UdpPass1!' },
  });
  return login.data?.token;
}

test('UDP 1700: PUSH_DATA no autenticado AUTO-REGISTRA gateway arbitrario (auto-register ON por defecto)', async (t) => {
  const srv = await bootServer({}); // auto-register por defecto = ON
  t.after(() => srv.stop());
  assert.ok(srv.ready, `servidor no arrancó: ${srv.getStderr().slice(-300)}`);

  const token = await setupSuper(srv.base);
  assert.ok(token, 'login superadmin');

  const before = await jsonReq(srv.base, 'GET', '/api/lorawan-gateways', { token });
  const countBefore = Array.isArray(before.data) ? before.data.length : (before.data?.length || 0);

  // EUI arbitrario, jamás registrado por el administrador.
  const attackerEui = 'aa11bb22cc33dd44';
  await sendUdp(srv.udpPort, buildPushData(attackerEui, '{}'));
  await wait(600);

  const after = await jsonReq(srv.base, 'GET', '/api/lorawan-gateways', { token });
  const list = Array.isArray(after.data) ? after.data : after.data?.gateways || [];
  const found = JSON.stringify(list).toLowerCase().includes(attackerEui.toLowerCase());

  // Documenta el comportamiento: con auto-register ON, el gateway aparece.
  assert.ok(
    found,
    `[SEC] Esperado: un PUSH_DATA UDP no autenticado registró el EUI ${attackerEui} ` +
      `(gateways antes=${countBefore}, después=${JSON.stringify(list).slice(0, 200)}). ` +
      `Mitigación: SYSCOM_LNS_AUTO_REGISTER_GATEWAY=0 + firewall en UDP 1700.`
  );
});

test('UDP 1700: con auto-register OFF, un EUI desconocido NO se registra', async (t) => {
  const srv = await bootServer({ SYSCOM_LNS_AUTO_REGISTER_GATEWAY: '0' });
  t.after(() => srv.stop());
  assert.ok(srv.ready, `servidor no arrancó: ${srv.getStderr().slice(-300)}`);

  const token = await setupSuper(srv.base);
  const attackerEui = 'bb22cc33dd44ee55';
  await sendUdp(srv.udpPort, buildPushData(attackerEui, '{}'));
  await wait(500);

  const after = await jsonReq(srv.base, 'GET', '/api/lorawan-gateways', { token });
  const list = Array.isArray(after.data) ? after.data : after.data?.gateways || [];
  const found = JSON.stringify(list).toLowerCase().includes(attackerEui.toLowerCase());
  assert.equal(found, false, 'con auto-register OFF el EUI desconocido no debe registrarse');
});

test('UDP 1700: paquetes basura/malformados no tumban el listener (robustez DoS)', async (t) => {
  const srv = await bootServer({ SYSCOM_LNS_AUTO_REGISTER_GATEWAY: '0' });
  t.after(() => srv.stop());
  assert.ok(srv.ready, `servidor no arrancó: ${srv.getStderr().slice(-300)}`);

  // Ráfaga de basura: truncados, JSON inválido, id desconocido.
  await sendUdp(srv.udpPort, Buffer.from([0x02, 0x00])); // truncado
  await sendUdp(srv.udpPort, buildPushData('1122334455667788', '{not-json')); // JSON inválido
  await sendUdp(srv.udpPort, Buffer.from([0x02, 0x12, 0x34, 0x09, 0xff, 0xff])); // id no manejado
  await sendUdp(srv.udpPort, Buffer.alloc(2000, 0x41)); // grande
  await wait(400);

  // El proceso sigue vivo y la API responde.
  assert.equal(srv.proc.exitCode, null, 'el proceso no debe haber terminado');
  const r = await jsonReq(srv.base, 'GET', '/api/setup/status');
  assert.equal(r.status, 200, 'la API HTTP sigue respondiendo tras la basura UDP');
});

test('UDP: LNS_UDP_PORT=0 desactiva el listener', async (t) => {
  const srv = await bootServer({ LNS_UDP_PORT: '0' });
  t.after(() => srv.stop());
  assert.ok(srv.ready, 'servidor arranca aunque el UDP esté desactivado');
  // No hay forma directa de comprobar el bind desde aquí; basta con que el
  // arranque HTTP sea correcto con el UDP deshabilitado (no EADDRINUSE, no crash).
  const r = await jsonReq(srv.base, 'GET', '/api/setup/status');
  assert.equal(r.status, 200);
});
