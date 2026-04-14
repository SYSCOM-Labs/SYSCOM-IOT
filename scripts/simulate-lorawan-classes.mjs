/**
 * Simulación: dispositivos clase A / B / C, ingesta HTTP en tiempo casi real,
 * downlink LNS (cola) y eventos UI (downlink confirmado + ACK simulado).
 *
 * Requiere: Node 20+, BD temporal o vacía.
 * Entorno: SYSCOM_LNS_SIM=1 (habilita /api/lns/sim/*).
 *
 * Uso: npm run simulate:lns
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const port = 39870 + Math.floor(Math.random() * 40);
const base = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `syscom-lns-sim-${Date.now()}.db`);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function req(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await r.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const APP_KEY = '0123456789abcdef0123456789abcdef';

async function main() {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const proc = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SYSCOM_SQLITE_PATH: dbPath,
      SYSCOM_LNS_SIM: '1',
      /** Sin gateway UDP real, el FCnt y el “awaiting ACK” deben resolverse sin GW_TX_ACK. */
      SYSCOM_LNS_TX_ACK: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  let ready = false;
  for (let i = 0; i < 100; i++) {
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
  assert(ready, `Servidor no arrancó. stderr: ${stderr.slice(-600)}`);

  try {
    let st = await req('GET', `${base}/api/setup/status`);
    if (st.data?.needsSetup) {
      const up = await req('POST', `${base}/api/setup`, {
        body: {
          email: 'lns-sim@test.local',
          password: 'SimPass123',
          profileName: 'LNS Sim',
        },
      });
      assert(up.status === 201, `setup ${up.status}`);
    }

    let token;
    let user;
    const login = await req('POST', `${base}/api/auth/login`, {
      body: { email: 'lns-sim@test.local', password: 'SimPass123' },
    });
    if (login.status === 200 && login.data.token) {
      token = login.data.token;
      user = login.data.user;
    } else {
      const login2 = await req('POST', `${base}/api/auth/login`, {
        body: { email: 'verify-super@test.local', password: 'VerifyPass1' },
      });
      assert(login2.status === 200 && login2.data.token, 'login');
      token = login2.data.token;
      user = login2.data.user;
    }

    const devicesSpec = [
      { id: 'aabbccddeeff0a01', cls: 'A' },
      { id: 'aabbccddeeff0b01', cls: 'B' },
      { id: 'aabbccddeeff0c01', cls: 'C' },
    ];

    for (let idx = 0; idx < devicesSpec.length; idx++) {
      const { id, cls } = devicesSpec[idx];
      const reg = await req('POST', `${base}/api/user-devices`, {
        token,
        body: {
          deviceId: id,
          displayName: `Sim class ${cls}`,
          devEUI: id,
          appEUI: '1122334455667788',
          appKey: APP_KEY,
          lorawanClass: cls,
        },
      });
      assert(
        reg.status === 201 || reg.status === 200,
        `Alta ${id}: ${reg.status} ${JSON.stringify(reg.data)}`
      );

      const ingestUrl = `${base}/api/ingest/${user.id}/${user.ingestToken}`;
      const ing = await req('POST', ingestUrl, {
        body: {
          deviceId: id,
          data: {
            temperature: 20 + idx,
            cls_marker: cls,
            lastUpdateTime: Date.now(),
          },
        },
      });
      assert(ing.status === 200, `Ingesta ${id}: ${ing.status}`);

      const seed = await req('POST', `${base}/api/lns/sim/seed-session`, {
        token,
        body: { devEui: id, deviceClass: cls, gatewayEui: 'aa11bb22cc33dd44' },
      });
      assert(seed.status === 200, `seed-session ${id}: ${seed.status} ${JSON.stringify(seed.data)}`);
      assert(
        String(seed.data?.deviceClass || '').toUpperCase() === cls,
        `Clase de sesión ${seed.data?.deviceClass} !== ${cls}`
      );

      const dl = await req('POST', `${base}/api/devices/${encodeURIComponent(id)}/downlink`, {
        token,
        body: { payloadHex: '01', fPort: 1, confirmed: cls === 'C' },
      });
      assert(dl.status === 200, `Downlink ${id}: ${dl.status} ${JSON.stringify(dl.data)}`);
      assert(
        String(dl.data?.deviceClass || '').toUpperCase() === cls,
        `downlink deviceClass ${dl.data?.deviceClass}`
      );
      if (cls === 'C') {
        assert(dl.data?.imme === true, 'Clase C debe usar txpk inmediato (imme)');
      }
    }

    const ev = await req('GET', `${base}/api/lns/ui-events?afterId=0`, { token });
    assert(ev.status === 200, 'ui-events');
    const list = ev.data?.events || [];
    const sent = list.filter((e) => e.eventType === 'downlink_sent');
    assert(sent.length >= 3, `Se esperaban ≥3 downlink_sent, hay ${sent.length}`);

    const cDev = 'aabbccddeeff0c01';
    const ack = await req('POST', `${base}/api/lns/sim/ack-confirmed-downlink`, {
      token,
      body: { devEui: cDev },
    });
    assert(ack.status === 200, `ack simulado: ${ack.status} ${JSON.stringify(ack.data)}`);

    const ev2 = await req('GET', `${base}/api/lns/ui-events?afterId=0`, { token });
    const acks = (ev2.data?.events || []).filter((e) => e.eventType === 'downlink_device_acked');
    assert(acks.length >= 1, 'Debe existir downlink_device_acked tras sim ACK');

    // Downlinks A/B no confirmados: sim ACK debe fallar
    const badAck = await req('POST', `${base}/api/lns/sim/ack-confirmed-downlink`, {
      token,
      body: { devEui: 'aabbccddeeff0a01' },
    });
    assert(badAck.status === 400, 'ACK sim sin awaiting debe ser 400');

    console.log('OK: simulación clases A/B/C, ingesta, downlinks y eventos UI.');
  } finally {
    proc.kill('SIGTERM');
    await wait(200);
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
