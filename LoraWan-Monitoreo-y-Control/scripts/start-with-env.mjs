/**
 * Arranque del servidor: carga `--env-file` solo si existe `.env` en la raíz del repo.
 * Así `npm start` no falla en máquinas nuevas sin `.env` (el código usa valores por defecto).
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
  env: process.env,
  windowsHide: true,
});

process.exit(result.status === null ? 1 : result.status);
