/**
 * Verificación de integración API: BD SQLite, dispositivos, widgets, ingesta,
 * downlink (501 LNS_DISABLED con SYSCOM_LNS_MAC=0), automatizaciones, gateways, historial y permisos.
 *
 * Uso: npm run verify
 * Requisitos: Node 22+, no debe haber otro proceso usando el mismo PORT de prueba.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const port = 39990 + Math.floor(Math.random() * 30);
const base = `http://127.0.0.1:${port}`;
const dbPath = path.join(os.tmpdir(), `syscom-verify-${Date.now()}.db`);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function req(method, url, { token, body, json = true } = {}) {
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

async function main() {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const proc = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SYSCOM_SQLITE_PATH: dbPath,
      /** Sin LNS MAC: downlink HTTP devuelve 501 (prueba “solo ingesta”). */
      SYSCOM_LNS_MAC: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  let ready = false;
  for (let i = 0; i < 80; i++) {
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
  assert(ready, `Servidor no arrancó en ${base}. stderr: ${stderr.slice(-500)}`);

  const results = [];

  try {
    // ── Setup + superadmin ─────────────────────────────────────────────
    let st = await req('GET', `${base}/api/setup/status`);
    assert(st.status === 200, `setup/status ${st.status}`);
    assert(st.data.needsSetup === true, 'needsSetup debe ser true en BD vacía');

    const stSetup = await req('POST', `${base}/api/setup`, {
      body: {
        email: 'verify-super@test.local',
        password: 'VerifyPass1',
        profileName: 'Verify Super',
      },
    });
    assert(stSetup.status === 201, `setup ${stSetup.status} ${JSON.stringify(st.data)}`);

    st = await req('GET', `${base}/api/setup/status`);
    assert(st.data.needsSetup === false, 'needsSetup false tras crear admin raíz');

    let login = await req('POST', `${base}/api/auth/login`, {
      body: { email: 'verify-super@test.local', password: 'VerifyPass1' },
    });
    assert(login.status === 200 && login.data.token, 'login super');
    const superToken = login.data.token;
    const superUser = login.data.user;
    assert(superUser.role === 'superadmin', 'rol superadmin');

    // ── Alta dispositivo (solo super) + telemetría vía ingesta ─────────
    const ud = await req('POST', `${base}/api/user-devices`, {
      token: superToken,
      body: {
        deviceId: 'aabbccddeeff0011',
        displayName: 'Verify Sensor',
        devEUI: 'aabbccddeeff0011',
        appEUI: '1122334455667788',
        appKey: '0123456789abcdef0123456789abcdef',
      },
    });
    assert(ud.status === 201 || ud.status === 200, `user-devices ${ud.status} ${JSON.stringify(ud.data)}`);

    const ingestUrl = `${base}/api/ingest/${superUser.id}/${superUser.ingestToken}`;
    const ing = await req('POST', ingestUrl, {
      body: {
        deviceId: 'aabbccddeeff0011',
        data: { temperature: 21.5, humidity: 60, battery: 95 },
      },
    });
    assert(ing.status === 200, `ingest ${ing.status} ${JSON.stringify(ing.data)}`);

    const devices = await req('GET', `${base}/api/devices`, { token: superToken });
    assert(devices.status === 200, 'GET devices');
    assert(devices.data.status === 'Success', 'devices Success');
    const content = devices.data.data?.content || [];
    const dev1 = content.find((d) => String(d.deviceId) === 'aabbccddeeff0011');
    assert(dev1, 'dispositivo en listado');
    assert(
      dev1.gateway_eui === undefined || !String(dev1.deviceId || '').startsWith('gateway-'),
      'no debe ser fila gateway- pseudo'
    );

    // ── Propiedades / TSL / historial (datos para reportes en cliente) ─
    const props = await req('GET', `${base}/api/devices/aabbccddeeff0011/properties`, { token: superToken });
    assert(props.status === 200 && props.data.status === 'Success', 'properties');
    assert(
      props.data.data?.properties?.temperature !== undefined ||
        props.data.data?.properties?.humidity !== undefined,
      'propiedades con telemetría'
    );

    const tsl = await req('GET', `${base}/api/devices/aabbccddeeff0011/thing-specification`, { token: superToken });
    assert(tsl.status === 200, 'TSL');

    const now = Date.now();
    const hist = await req(
      'GET',
      `${base}/api/devices/aabbccddeeff0011/properties/history?startTime=${now - 3600000}&endTime=${now + 60000}&pageSize=50`,
      { token: superToken }
    );
    assert(hist.status === 200 && hist.data.status === 'Success', 'history');
    assert(Array.isArray(hist.data.list) && hist.data.list.length >= 1, 'historial con al menos un punto');

    // ── Widgets dashboard (persistencia SQLite) ───────────────────────
    const widgets = [
      {
        id: 'w1',
        type: 'value',
        title: 'Temp',
        propertyKey: 'temperature',
        unit: '°C',
        accent: 'blue',
        gaugeMin: 0,
        gaugeMax: 100,
        historyHours: 24,
      },
    ];
    const putW = await req('PUT', `${base}/api/devices/aabbccddeeff0011/dashboard-widgets`, {
      token: superToken,
      body: { widgets },
    });
    assert(putW.status === 200 && putW.data.status === 'Success', `widgets PUT ${JSON.stringify(putW.data)}`);
    const getW = await req('GET', `${base}/api/devices/aabbccddeeff0011/dashboard-widgets`, { token: superToken });
    assert(getW.status === 200 && getW.data.widgets?.length === 1, 'widgets GET');
    assert(getW.data.widgets[0].propertyKey === 'temperature', 'widget propertyKey');

    // ── Downlink: con SYSCOM_LNS_MAC=0 → 501 LNS desactivado ────────────
    const dl = await req('POST', `${base}/api/devices/aabbccddeeff0011/downlink`, {
      token: superToken,
      body: { data: '0102' },
    });
    assert(dl.status === 501, `downlink debe ser 501, fue ${dl.status}`);
    assert(dl.data?.code === 'LNS_DISABLED', 'downlink LNS_DISABLED');

    // ── Automatizaciones ───────────────────────────────────────────────
    const rules = [
      {
        id: 'r1',
        name: 'Test rule',
        active: true,
        deviceId: 'aabbccddeeff0011',
        propertyKey: 'temperature',
        operator: '>',
        value: 0,
        action: 'notify',
      },
    ];
    const putA = await req('PUT', `${base}/api/automations`, { token: superToken, body: { rules } });
    assert(putA.status === 200, `automations PUT ${JSON.stringify(putA.data)}`);
    const getA = await req('GET', `${base}/api/automations`, { token: superToken });
    assert(getA.status === 200 && getA.data.rules?.length === 1, 'automations GET');

    // ── Gateway LoRaWAN (catálogo) ─────────────────────────────────────
    const postG = await req('POST', `${base}/api/lorawan-gateways`, {
      token: superToken,
      body: {
        name: 'GW test',
        gatewayEui: '1122334455667788',
        frequencyBand: 'EU868-RX2-SF9',
      },
    });
    assert(postG.status === 201, `lorawan-gateways POST ${JSON.stringify(postG.data)}`);
    const listG = await req('GET', `${base}/api/lorawan-gateways`, { token: superToken });
    assert(listG.status === 200 && Array.isArray(listG.data) && listG.data.length === 1, 'lorawan-gateways GET');
    assert(typeof listG.data[0].online === 'boolean', 'gateway.online');

    // ── Dispositivo → aplicación: lista sin gateway- pseudo ─────────────
    const hasPseudo = content.some((d) => /^gateway-[0-9a-f]{8,32}$/i.test(String(d.deviceId)));
    assert(!hasPseudo, 'Dispositivos: no debe incluir ids gateway-*');

    // ── Cuentas: Admin y Usuario + permisos ────────────────────────────
    const createAdmin = await req('POST', `${base}/api/users`, {
      token: superToken,
      body: {
        email: 'verify-admin@test.local',
        password: 'VerifyPass1',
        role: 'admin',
        profileName: 'Verify Admin',
      },
    });
    assert(createAdmin.status === 201, `create admin ${JSON.stringify(createAdmin.data)}`);

    const createUser = await req('POST', `${base}/api/users`, {
      token: superToken,
      body: {
        email: 'verify-user@test.local',
        password: 'VerifyPass1',
        role: 'user',
        profileName: 'Verify User',
      },
    });
    assert(createUser.status === 201, `create user ${JSON.stringify(createUser.data)}`);

    login = await req('POST', `${base}/api/auth/login`, {
      body: { email: 'verify-admin@test.local', password: 'VerifyPass1' },
    });
    const adminToken = login.data.token;

    login = await req('POST', `${base}/api/auth/login`, {
      body: { email: 'verify-user@test.local', password: 'VerifyPass1' },
    });
    const userToken = login.data.token;

    const assign = await req('POST', `${base}/api/devices/assign`, {
      token: superToken,
      body: { deviceId: 'aabbccddeeff0011', assigneeEmail: 'verify-user@test.local' },
    });
    assert(assign.status === 200 || assign.status === 201, `assign ${JSON.stringify(assign.data)}`);

    // Usuario: ve dispositivo asignado
    const devUser = await req('GET', `${base}/api/devices`, { token: userToken });
    const uContent = devUser.data.data?.content || [];
    assert(uContent.some((d) => String(d.deviceId) === 'aabbccddeeff0011'), 'usuario ve dispositivo');

    // Usuario: no puede guardar automatizaciones
    const userAuto = await req('PUT', `${base}/api/automations`, {
      token: userToken,
      body: { rules: [] },
    });
    assert(userAuto.status === 403, 'usuario no PUT automations');

    // Usuario: no puede listar todos los usuarios
    const userListUsers = await req('GET', `${base}/api/users`, { token: userToken });
    assert(userListUsers.status === 403, 'usuario no GET users');

    // Admin: puede PUT widgets en dispositivo propio tras asignación desde super…
    // Primero asignar dispositivo al admin (super tiene el device)
    const assignAdm = await req('POST', `${base}/api/devices/assign`, {
      token: superToken,
      body: { deviceId: 'aabbccddeeff0011', assigneeEmail: 'verify-admin@test.local' },
    });
    assert(assignAdm.status === 200 || assignAdm.status === 201, 'assign admin');

    const adminWidgets = await req('PUT', `${base}/api/devices/aabbccddeeff0011/dashboard-widgets`, {
      token: adminToken,
      body: { widgets },
    });
    assert(adminWidgets.status === 200, 'admin PUT widgets');

    // Admin: no puede crear superadmin
    const badSuper = await req('POST', `${base}/api/users`, {
      token: adminToken,
      body: {
        email: 'bad-super@test.local',
        password: 'VerifyPass1',
        role: 'superadmin',
        profileName: 'X',
      },
    });
    assert(badSuper.status === 403, 'admin no crea superadmin');

    // Super: purge opcional no ejecutamos (borra datos); user-devices delete staff
    results.push('OK: integración API, BD, widgets, ingesta, historial, automations, gateways, roles');
  } finally {
    proc.kill('SIGTERM');
    await wait(400);
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }

  console.log('\n✅ verify-integration: todas las comprobaciones pasaron.');
  console.log('   Notas: downlink HTTP devuelve 501 en modo ingesta local (esperado).');
  console.log('   Reporte especial / PDF / exportación: lógica en cliente (jsPDF); historial API verificado.\n');
  return results;
}

main().catch((e) => {
  console.error('\n❌ verify-integration falló:', e.message || e);
  process.exit(1);
});
