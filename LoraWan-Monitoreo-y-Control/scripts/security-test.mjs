/**
 * Suite de pruebas de seguridad dinámicas (API/web) para SYSCOM IoT.
 *
 * Reutiliza el patrón de scripts/verify-integration.mjs: arranca server/server.js
 * con una BD SQLite temporal, ejecuta casos de abuso y registra hallazgos con
 * severidad y evidencia. NO modifica el servidor; solo lo prueba como atacante.
 *
 * Uso:
 *   node scripts/security-test.mjs            # ejecuta todo, imprime catálogo
 *   node scripts/security-test.mjs --json     # además escribe el catálogo JSON
 *
 * Cada hallazgo: { id, title, severity, status, evidence }
 *   status = 'VULNERABLE' | 'OK' | 'INFO'  (VULNERABLE = comportamiento a corregir)
 *
 * Salida con código 0 siempre (es una auditoría, no un gate); el resumen indica
 * cuántos hallazgos VULNERABLE se encontraron.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

/** Secreto de desarrollo embebido en server.js cuando JWT_SECRET no está definido. */
const DEV_JWT_SECRET = 'syscom-iot-dev-insecure-jwt-secret-change-me';

const findings = [];
function record(id, title, severity, status, evidence) {
  findings.push({ id, title, severity, status, evidence: String(evidence ?? '') });
  const tag = status === 'VULNERABLE' ? 'VULN' : status === 'OK' ? ' OK ' : 'INFO';
  console.log(`  [${tag}] ${id} ${title}${evidence ? ` — ${evidence}` : ''}`);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function req(base, method, urlPath, { token, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${urlPath}`, {
    method,
    headers: h,
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  let data;
  const text = await r.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}

/** Arranca server/server.js con env dado y espera a que /api/setup/status responda. */
async function bootServer(extraEnv = {}) {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  const dbPath = path.join(os.tmpdir(), `syscom-sec-${port}-${process.pid}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const proc = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SYSCOM_SQLITE_PATH: dbPath,
      SYSCOM_LNS_MAC: '0',
      LNS_UDP_PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  proc.stdout.on('data', (c) => (stdout += c.toString()));

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
    dbPath,
    proc,
    ready,
    getStderr: () => stderr,
    getStdout: () => stdout,
    async stop() {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      await wait(150);
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

/** Crea superadmin + token, devuelve {token, user}. */
async function setupSuperadmin(base, email = 'sec-super@test.local', password = 'SecurePass1!') {
  await req(base, 'POST', '/api/setup', { body: { email, password, profileName: 'Sec Super' } });
  const login = await req(base, 'POST', '/api/auth/login', { body: { email, password } });
  return { token: login.data?.token, user: login.data?.user, status: login.status };
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 1 — Autenticación y sesión
// ───────────────────────────────────────────────────────────────────────────
async function phaseAuth(srv) {
  console.log('\n── Fase 1: Autenticación y sesión ──');
  const { base } = srv;
  const { token: superToken, user: superUser } = await setupSuperadmin(base);

  // F1.1 — Forjado de JWT con el secreto de desarrollo por defecto (suplantación)
  // authMiddleware re-lee rol/nav de la BD, así que forjar el id del superadmin = takeover total.
  {
    const forged = signJwt({ id: superUser.id, email: superUser.email }, DEV_JWT_SECRET, 3600);
    const r = await req(base, 'GET', '/api/users', { token: forged });
    if (r.status === 200) {
      record('AUTH-01', 'JWT forjable con secreto dev por defecto (suplantación total)', 'ALTA', 'VULNERABLE',
        `GET /api/users con token forjado (secreto '${DEV_JWT_SECRET}') → 200. Sin JWT_SECRET, cualquiera con el id de un usuario obtiene su sesión. Prod sí bloquea el arranque (server.js:129).`);
    } else {
      record('AUTH-01', 'JWT forjable con secreto dev por defecto', 'ALTA', 'OK',
        `token forjado rechazado (${r.status})`);
    }
  }

  // F1.2 — Ventana de gracia de refresh. Tras SEC-10 el defecto es 7 días.
  // NOTA: este test usa el secreto dev conocido; tras SEC-02 (secreto aleatorio
  // por arranque) el token forjado ya no es válido, así que el refresh se
  // rechaza (comportamiento deseado). Reportamos según lo observado.
  {
    const expired1d = signJwt({ id: superUser.id, email: superUser.email }, DEV_JWT_SECRET, -24 * 3600);
    const r = await req(base, 'POST', '/api/auth/refresh', { token: expired1d });
    if (r.status === 200 && r.data?.token) {
      record('AUTH-02', 'Refresh dentro de la ventana de gracia (7d)', 'INFO', 'INFO',
        `token expirado 24h → 200 (dentro de la ventana de 7d, por diseño kiosco)`);
    } else {
      record('AUTH-02', 'Refresh de token caducado', 'INFO', 'OK',
        `token expirado 24h → ${r.status} (secreto dev aleatorio tras SEC-02 → no forjable)`);
    }
    // Límite: más allá de la gracia (8 días) debe rechazar (si el token es válido).
    const expired8d = signJwt({ id: superUser.id }, DEV_JWT_SECRET, -8 * 24 * 3600);
    const r2 = await req(base, 'POST', '/api/auth/refresh', { token: expired8d });
    record('AUTH-02b', 'Refresh rechaza más allá de la ventana de gracia', 'INFO',
      r2.status === 401 ? 'OK' : 'INFO', `token expirado 8d → ${r2.status} (esperado 401)`);
  }

  // F1.3 — alg=none / firma vacía
  {
    const headerNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: superUser.id, email: superUser.email })).toString('base64url');
    const noneToken = `${headerNone}.${payload}.`;
    const r = await req(base, 'GET', '/api/users', { token: noneToken });
    if (r.status === 200) {
      record('AUTH-03', 'Acepta JWT con alg=none', 'ALTA', 'VULNERABLE', `GET /api/users con alg=none → 200`);
    } else {
      record('AUTH-03', 'JWT alg=none rechazado', 'BAJA', 'OK', `→ ${r.status} (jsonwebtoken exige HS256 con secreto)`);
    }
  }

  // F1.4 — Rate limit de login (instancia DEDICADA con límite bajo, para no
  // contaminar el resto de pruebas que hacen login en la instancia principal).
  {
    const rl = await bootServer({ SYSCOM_LOGIN_RATE_MAX: '10' });
    if (rl.ready) {
      await setupSuperadmin(rl.base, 'rl@test.local', 'RatePass1!');
      let got429 = false;
      let attempts = 0;
      for (let i = 0; i < 30; i++) {
        attempts++;
        const r = await req(rl.base, 'POST', '/api/auth/login', {
          body: { email: 'rl@test.local', password: 'wrong-password' },
        });
        if (r.status === 429) {
          got429 = true;
          break;
        }
      }
      record('AUTH-04', 'Rate limit en /api/auth/login', 'INFO', got429 ? 'OK' : 'VULNERABLE',
        got429 ? `429 tras ${attempts} intentos (límite=10)` : 'no se alcanzó 429 en 30 intentos');
    } else {
      record('AUTH-04', 'Rate limit en /api/auth/login', 'INFO', 'INFO', 'instancia dedicada no arrancó');
    }
    await rl.stop();
  }

  // F1.5 — Política de contraseña (rechazo de débiles)
  {
    const r = await req(base, 'POST', '/api/users', {
      token: superToken,
      body: { email: 'weak@test.local', password: '123', profileName: 'Weak', role: 'user' },
    });
    record('AUTH-05', 'Política de contraseña rechaza débiles', 'INFO',
      r.status >= 400 ? 'OK' : 'VULNERABLE', `crear usuario con password '123' → ${r.status}`);
  }

  // F1.6 — Endpoints legacy sin auth (cuando SYSCOM_LEGACY_ADMIN_SECRET no está)
  {
    const r = await req(base, 'POST', '/api/reset-password', {
      body: { email: 'sec-super@test.local', newPassword: 'Hacked123!' },
    });
    record('AUTH-06', '/api/reset-password exige superadmin (sin secreto legacy)', 'INFO',
      r.status === 401 || r.status === 403 ? 'OK' : 'VULNERABLE',
      `sin token → ${r.status}`);
  }

  // F1.7 — Idempotencia de setup (no recrear superadmin)
  {
    const r = await req(base, 'POST', '/api/setup', {
      body: { email: 'attacker@test.local', password: 'Attacker1!', profileName: 'X' },
    });
    record('AUTH-07', 'POST /api/setup bloqueado tras inicializar', 'INFO',
      r.status >= 400 ? 'OK' : 'VULNERABLE', `segundo setup → ${r.status}`);
  }

  return { superToken, superUser };
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 2 — Autorización / IDOR
// ───────────────────────────────────────────────────────────────────────────
async function phaseAuthz(srv, superToken, superUser) {
  console.log('\n── Fase 2: Autorización / IDOR ──');
  const { base } = srv;

  // Crear dos usuarios normales
  const mkUser = async (email) => {
    const r = await req(base, 'POST', '/api/users', {
      token: superToken,
      body: { email, password: 'UserPass1!', profileName: email, role: 'user' },
    });
    return r.data;
  };
  await mkUser('alice@test.local');
  await mkUser('bob@test.local');
  const aliceLogin = await req(base, 'POST', '/api/auth/login', {
    body: { email: 'alice@test.local', password: 'UserPass1!' },
  });
  const bobLogin = await req(base, 'POST', '/api/auth/login', {
    body: { email: 'bob@test.local', password: 'UserPass1!' },
  });
  const aliceTok = aliceLogin.data?.token;
  const bobTok = bobLogin.data?.token;

  // F2.1 — Cobertura: endpoints protegidos sin token → 401
  {
    const protectedPaths = [
      ['GET', '/api/users'],
      ['GET', '/api/devices'],
      ['GET', '/api/user-devices'],
      ['GET', '/api/automations'],
      ['GET', '/api/downlinks'],
      ['GET', '/api/admin/syscom-metrics'],
    ];
    let unprotected = 0;
    const details = [];
    for (const [m, p] of protectedPaths) {
      const r = await req(base, m, p);
      if (r.status !== 401) {
        unprotected++;
        details.push(`${m} ${p}→${r.status}`);
      }
    }
    record('AUTHZ-01', 'Endpoints protegidos exigen token', 'INFO',
      unprotected === 0 ? 'OK' : 'VULNERABLE',
      unprotected === 0 ? `${protectedPaths.length} endpoints → 401 sin token` : details.join(', '));
  }

  // F2.2 — Escalada vertical: user normal no puede crear usuarios
  {
    const r = await req(base, 'POST', '/api/users', {
      token: aliceTok,
      body: { email: 'evil@test.local', password: 'EvilPass1!', profileName: 'E', role: 'superadmin' },
    });
    record('AUTHZ-02', 'Usuario normal no puede crear usuarios/superadmin', 'INFO',
      r.status === 403 ? 'OK' : 'VULNERABLE', `POST /api/users como user → ${r.status}`);
  }

  // F2.3 — Escalada vertical: user no puede importar BD / endpoints superadmin
  {
    const r = await req(base, 'POST', '/api/user-devices', {
      token: aliceTok,
      body: { deviceId: 'ffeeddccbbaa0011', displayName: 'X' },
    });
    record('AUTHZ-03', 'Usuario normal no puede crear user-devices (superadmin only)', 'INFO',
      r.status === 403 ? 'OK' : 'VULNERABLE', `POST /api/user-devices como user → ${r.status}`);
  }

  // F2.4 — IDOR horizontal: crear device, asignar a alice, bob intenta leer telemetría
  {
    const devId = 'a1b2c3d4e5f60011';
    await req(base, 'POST', '/api/user-devices', {
      token: superToken,
      body: {
        deviceId: devId,
        displayName: 'Alice Device',
        devEUI: devId,
        appEUI: '1122334455667788',
        appKey: '0123456789abcdef0123456789abcdef',
      },
    });
    // asignar a alice
    const aliceId = aliceLogin.data?.user?.id;
    await req(base, 'POST', '/api/devices/assign', {
      token: superToken,
      body: { userId: aliceId, deviceId: devId },
    });
    // bob intenta acceder
    const endpoints = [
      ['GET', `/api/devices/${devId}/properties`],
      ['GET', `/api/telemetry/${devId}`],
      ['GET', `/api/devices/${devId}/dashboard-widgets`],
      ['POST', `/api/devices/${devId}/downlink`],
    ];
    let leaks = 0;
    const det = [];
    for (const [m, p] of endpoints) {
      const r = await req(base, m, p, { token: bobTok, body: m === 'POST' ? { payload: 'AA' } : undefined });
      // 403/404 = bien aislado; 200 con datos = IDOR
      if (r.status === 200) {
        leaks++;
        det.push(`${m} ${p}→200`);
      }
    }
    record('AUTHZ-04', 'Aislamiento horizontal de dispositivos (IDOR)', 'ALTA',
      leaks === 0 ? 'OK' : 'VULNERABLE',
      leaks === 0 ? 'bob no accede a dispositivos de alice (403/404)' : det.join(', '));
  }

  return { aliceTok, bobTok, aliceId: aliceLogin.data?.user?.id };
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 3 — Inyección / validación de entrada
// ───────────────────────────────────────────────────────────────────────────
async function phaseInjection(srv, superToken, superUser) {
  console.log('\n── Fase 3: Inyección / validación ──');
  const { base } = srv;

  // F3.1 — SQLi en campos de texto (nombre de dispositivo)
  {
    const payloads = [
      `Robert'); DROP TABLE users; --`,
      `" OR "1"="1`,
      `'; SELECT * FROM users; --`,
    ];
    let broke = false;
    for (let i = 0; i < payloads.length; i++) {
      const devId = `dead00000000000${i}`;
      const r = await req(base, 'POST', '/api/user-devices', {
        token: superToken,
        body: { deviceId: devId, displayName: payloads[i], devEUI: devId },
      });
      if (r.status >= 500) broke = true;
    }
    // verificar que users sigue intacto (login funciona)
    const stillWorks = await req(base, 'POST', '/api/auth/login', {
      body: { email: 'sec-super@test.local', password: 'SecurePass1!' },
    });
    record('INJ-01', 'SQLi en campos de texto (parametrización)', 'BAJA',
      !broke && stillWorks.status === 200 ? 'OK' : 'VULNERABLE',
      !broke && stillWorks.status === 200
        ? 'payloads SQLi no rompen ni alteran la BD (db.prepare parametrizado)'
        : `broke500=${broke} loginPost=${stillWorks.status}`);
  }

  // F3.2 — XSS almacenado: el backend no escapa, pero ¿devuelve tal cual? (riesgo en frontend)
  {
    const devId = 'cafe000000000001';
    const xss = `<img src=x onerror=alert(1)>`;
    await req(base, 'POST', '/api/user-devices', {
      token: superToken,
      body: { deviceId: devId, displayName: xss, devEUI: devId },
    });
    const list = await req(base, 'GET', '/api/user-devices', { token: superToken });
    const stored = JSON.stringify(list.data || '').includes('onerror=alert');
    record('INJ-02', 'Payload XSS se almacena sin sanitizar (riesgo en cliente)', 'MEDIA',
      stored ? 'INFO' : 'OK',
      stored ? 'displayName con <img onerror> se guarda y devuelve crudo; depende del render del frontend' : 'no se reflejó');
  }

  // F3.3 — Validación de payload de downlink (hex inválido). Con LNS_MAC=0 puede dar 501.
  {
    const devId = 'a1b2c3d4e5f60011';
    const r = await req(base, 'POST', `/api/devices/${devId}/downlink`, {
      token: superToken,
      body: { payload: 'ZZZZ-not-hex', fPort: 99999 },
    });
    record('INJ-03', 'Validación de payload de downlink', 'INFO',
      r.status === 400 || r.status === 501 ? 'OK' : 'INFO',
      `downlink hex inválido → ${r.status} (501=LNS deshabilitado en prueba)`);
  }

  // F3.4 — Body gigante (DoS por tamaño)
  {
    const big = 'A'.repeat(2 * 1024 * 1024); // 2MB
    const r = await req(base, 'POST', '/api/auth/login', {
      body: { email: big, password: 'x' },
    }).catch((e) => ({ status: 'ERR', data: String(e) }));
    record('INJ-04', 'Límite de tamaño de body en JSON', 'INFO',
      r.status === 413 || r.status === 400 ? 'OK' : 'INFO',
      `body 2MB en /api/auth/login → ${r.status}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 4 — Ingesta (token, replay)
// ───────────────────────────────────────────────────────────────────────────
async function phaseIngest(srv, superToken, superUser) {
  console.log('\n── Fase 4: Ingesta / replay ──');
  const { base } = srv;

  // F4.1 — Token de ingesta inválido / de otro usuario
  {
    const wrong = await req(base, 'POST', `/api/ingest/${superUser.id}/deadbeefdeadbeef`, {
      body: { deviceId: 'a1b2c3d4e5f60011', data: { t: 1 } },
    });
    record('INGEST-01', 'Token de ingesta inválido rechazado', 'INFO',
      wrong.status === 401 ? 'OK' : 'VULNERABLE', `token erróneo → ${wrong.status}`);
  }

  // F4.2 — Replay de uplink. El servidor solo deduplica payload IDÉNTICO dentro
  // de una ventana de 8s (SYSCOM_TELEMETRY_DEDUP_MS, store.js:1986); NO valida
  // frame counter (fCnt) ni nonce, así que un uplink capturado y reenviado con
  // cualquier variación —o pasada la ventana— se persiste como dato nuevo.
  const ingestUrl = `/api/ingest/${superUser.id}/${superUser.ingestToken}`;
  const histList = async (devId) => {
    const now = Date.now();
    const r = await req(base, 'GET',
      `/api/devices/${devId}/properties/history?startTime=${now - 3600000}&endTime=${now + 60000}&pageSize=100`,
      { token: superToken });
    if (Array.isArray(r.data)) return r.data;
    if (Array.isArray(r.data?.list)) return r.data.list;
    return [];
  };
  {
    const devId = 'beef000000000001';
    await req(base, 'POST', '/api/user-devices', {
      token: superToken,
      body: { deviceId: devId, displayName: 'Replay Dev', devEUI: devId,
        appEUI: '1122334455667788', appKey: '0123456789abcdef0123456789abcdef' },
    });
    // Sanity: una ingesta debe persistir.
    await req(base, 'POST', ingestUrl, { body: { deviceId: devId, data: { temperature: 10 } } });
    await wait(250);
    const props = await req(base, 'GET', `/api/devices/${devId}/properties`, { token: superToken });
    const persisted = props.data?.data?.properties?.temperature !== undefined ||
      (await histList(devId)).length >= 1;
    if (!persisted) {
      record('INGEST-02', 'Anti-replay de uplinks (fCnt)', 'MEDIA', 'INFO',
        'no se pudo verificar persistencia de telemetría en el entorno de prueba');
    } else {
      // SEC-05: replay real = reenviar el MISMO fCnt. fCnt a nivel raíz para que
      // normalizeLorawanUplink lo capte. Distintos `temperature` para que el
      // dedup de payload (<8s) NO sea el que actúe — debe actuar el guard fCnt.
      const send = (fcnt, temp) =>
        req(base, 'POST', ingestUrl, { body: { deviceId: devId, fCnt: fcnt, data: { temperature: temp } } });
      await send(200, 21);            // primer uplink con fCnt=200
      await send(201, 22);            // avance legítimo
      const before = (await histList(devId)).length;
      await send(200, 23);            // REPLAY: fCnt=200 reenviado (payload distinto)
      await wait(300);
      const after = (await histList(devId)).length;
      // Con el guard activo, el replay (fCnt no avanza) NO debe crear registro nuevo.
      record('INGEST-02', 'Anti-replay por frame counter (fCnt)', 'MEDIA',
        after === before ? 'OK' : 'VULNERABLE',
        after === before
          ? `replay de fCnt=200 (tras 201) rechazado: history se mantuvo en ${after} (guard SEC-05)`
          : `replay de fCnt=200 creó registro nuevo (${before}→${after}); el guard no actuó`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 5 — Cabeceras de seguridad y CORS (dev) + comportamiento prod
// ───────────────────────────────────────────────────────────────────────────
async function phaseHeaders(srv) {
  console.log('\n── Fase 5: Cabeceras de seguridad y CORS ──');
  const { base } = srv;

  // F5.1 — Cabeceras de seguridad ausentes
  {
    const r = await req(base, 'GET', '/api/setup/status');
    const want = {
      'x-frame-options': 'X-Frame-Options',
      'x-content-type-options': 'X-Content-Type-Options (nosniff)',
      'strict-transport-security': 'HSTS',
      'content-security-policy': 'CSP',
      'referrer-policy': 'Referrer-Policy',
    };
    const missing = Object.entries(want)
      .filter(([k]) => !r.headers.get(k))
      .map(([, label]) => label);
    record('HDR-01', 'Cabeceras de seguridad (helmet)', 'MEDIA',
      missing.length === 0 ? 'OK' : 'VULNERABLE',
      missing.length === 0 ? 'todas presentes' : `faltan: ${missing.join(', ')} (no se usa helmet)`);
  }

  // F5.2 — CORS reflectivo con credenciales en dev
  {
    const r = await req(base, 'GET', '/api/setup/status', { headers: { Origin: 'https://evil.example' } });
    const acao = r.headers.get('access-control-allow-origin');
    const reflects = acao === '*' || acao === 'https://evil.example';
    record('CORS-01', 'CORS abierto en desarrollo (dev: *)', 'INFO',
      reflects ? 'INFO' : 'OK',
      `Access-Control-Allow-Origin con Origin atacante = ${acao || '(ninguno)'} — esperado solo en desarrollo; en prod ahora exige SYSCOM_CORS_ORIGINS (SEC-03)`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 5b — Arranque en producción: gate de JWT y CORS
// ───────────────────────────────────────────────────────────────────────────
async function phaseProdBoot() {
  console.log('\n── Fase 5b: Arranque en producción ──');

  // Sin JWT_SECRET en producción → debe salir (exit 1)
  {
    const srv = await bootServer({ NODE_ENV: 'production', JWT_SECRET: '' });
    const exited = srv.proc.exitCode != null && srv.proc.exitCode !== 0;
    record('PROD-01', 'Producción bloquea arranque sin JWT_SECRET', 'INFO',
      !srv.ready && exited ? 'OK' : 'VULNERABLE',
      !srv.ready && exited
        ? `proceso terminó (exit ${srv.proc.exitCode}) sin JWT_SECRET`
        : `ready=${srv.ready} exit=${srv.proc.exitCode} — debería abortar`);
    await srv.stop();
  }

  // SEC-03: producción sin SYSCOM_CORS_ORIGINS debe ABORTAR el arranque
  // (antes reflejaba cualquier Origin con origin:true).
  {
    const srv = await bootServer({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48) });
    const exited = !srv.ready && srv.proc.exitCode != null && srv.proc.exitCode !== 0;
    if (exited) {
      record('CORS-02', 'Producción sin SYSCOM_CORS_ORIGINS aborta el arranque', 'MEDIA', 'OK',
        `prod sin lista CORS → exit ${srv.proc.exitCode} (no refleja Origin)`);
    } else if (srv.ready) {
      const r = await req(srv.base, 'GET', '/api/setup/status', { headers: { Origin: 'https://evil.example' } });
      const acao = r.headers.get('access-control-allow-origin');
      record('CORS-02', 'Producción sin SYSCOM_CORS_ORIGINS refleja Origin', 'MEDIA',
        acao && acao !== '' ? 'VULNERABLE' : 'OK',
        `prod sin lista CORS → Access-Control-Allow-Origin=${acao || '(ninguno)'}`);
    } else {
      record('CORS-02', 'Producción sin SYSCOM_CORS_ORIGINS', 'MEDIA', 'INFO',
        `no arrancó (motivo no concluyente): ${srv.getStderr().slice(-160)}`);
    }
    await srv.stop();
  }
}

// ── util: firmar JWT HS256 manualmente (sin dependencias) ───────────────────
function signJwt(claims, secret, expiresInSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now };
  if (typeof expiresInSec === 'number') payload.exp = now + expiresInSec;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('SYSCOM IoT — Suite de pruebas de seguridad dinámicas\n');
  // Límite de login alto en la instancia principal para no throttlear los
  // logins funcionales de las pruebas (el rate limit se valida aparte: AUTH-04).
  const srv = await bootServer({ SYSCOM_LOGIN_RATE_MAX: '200' });
  if (!srv.ready) {
    console.error('Servidor no arrancó. stderr:', srv.getStderr().slice(-600));
    await srv.stop();
    process.exit(2);
  }
  try {
    const { superToken, superUser } = await phaseAuth(srv);
    await phaseAuthz(srv, superToken, superUser);
    await phaseInjection(srv, superToken, superUser);
    await phaseIngest(srv, superToken, superUser);
    await phaseHeaders(srv);
  } finally {
    await srv.stop();
  }
  await phaseProdBoot();

  // Resumen
  const vuln = findings.filter((f) => f.status === 'VULNERABLE');
  const bySev = (s) => vuln.filter((f) => f.severity === s).length;
  console.log('\n══════════════════════════════════════════════');
  console.log(`Hallazgos VULNERABLE: ${vuln.length}  (ALTA=${bySev('ALTA')} MEDIA=${bySev('MEDIA')} BAJA=${bySev('BAJA')})`);
  console.log(`Total de comprobaciones: ${findings.length}`);
  console.log('══════════════════════════════════════════════');

  if (process.argv.includes('--json')) {
    const out = path.join(root, 'docs', 'security-findings.json');
    fs.writeFileSync(out, JSON.stringify(findings, null, 2));
    console.log(`\nCatálogo JSON escrito en ${out}`);
  }
}

main().catch((e) => {
  console.error('Error en la suite:', e);
  process.exit(2);
});
