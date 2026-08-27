'use strict';

/**
 * Alta con clave temporal 123456 y login con esa misma clave.
 * node --test server/test/provisional-login.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = path.join(__dirname, '..', '..');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
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

async function bootServer() {
  const httpPort = await getFreeTcpPort();
  const base = `http://127.0.0.1:${httpPort}`;
  const dbPath = path.join(os.tmpdir(), `syscom-prov-login-${httpPort}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const proc = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(httpPort),
      SYSCOM_SQLITE_PATH: dbPath,
      SYSCOM_LNS_MAC: '0',
      LNS_UDP_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c.toString();
  });

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

test('usuario creado con 123456 puede iniciar sesión con 123456', async (t) => {
  const srv = await bootServer();
  t.after(() => srv.stop());
  assert.ok(srv.ready, `servidor no arrancó: ${srv.getStderr().slice(-400)}`);

  const setup = await jsonReq(srv.base, 'POST', '/api/setup', {
    body: { email: 'admin-prov@test.local', password: 'AdminPass1!', profileName: 'Admin' },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));

  const adminLogin = await jsonReq(srv.base, 'POST', '/api/auth/login', {
    body: { email: 'admin-prov@test.local', password: 'AdminPass1!' },
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data));
  const token = adminLogin.data?.token;
  assert.ok(token);

  const created = await jsonReq(srv.base, 'POST', '/api/users', {
    token,
    body: {
      email: 'temporal@test.local',
      password: '123456',
      profileName: 'Temporal',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data?.mustChangePassword, true);

  const userLogin = await jsonReq(srv.base, 'POST', '/api/auth/login', {
    body: { email: 'temporal@test.local', password: '123456' },
  });
  assert.equal(userLogin.status, 200, JSON.stringify(userLogin.data));
  assert.ok(userLogin.data?.token);
  assert.equal(userLogin.data?.user?.mustChangePassword, true);

  const numericLogin = await jsonReq(srv.base, 'POST', '/api/auth/login', {
    body: { email: 'temporal@test.local', password: 123456 },
  });
  assert.equal(numericLogin.status, 200, JSON.stringify(numericLogin.data));

  const firstPw = await jsonReq(srv.base, 'POST', '/api/auth/first-password', {
    token: userLogin.data.token,
    body: { newPassword: '123456' },
  });
  assert.equal(firstPw.status, 400);
  assert.match(String(firstPw.data?.error || ''), /8 caracteres|minúscula|mayúscula|especial/i);
});
