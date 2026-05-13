/**
 * Arranque con NODE_ENV=production (JWT_SECRET obligatorio; CORS recomendado).
 * Carga `.env` con la misma lógica que `start-with-env.mjs`.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
const serverJs = join(root, 'server', 'server.js');

const nodeArgs = ['--experimental-sqlite'];
if (existsSync(envFile)) {
  nodeArgs.push(`--env-file=${envFile}`);
}
nodeArgs.push(serverJs);

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
  windowsHide: true,
});

process.exit(result.status === null ? 1 : result.status);
