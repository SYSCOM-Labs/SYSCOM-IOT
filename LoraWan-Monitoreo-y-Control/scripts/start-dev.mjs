/**
 * Arranque unificado de desarrollo: API Express + Vite dev en un solo proceso padre.
 * - Logs combinados con prefijo [api]/[front]
 * - Ctrl+C / SIGTERM detiene ambos hijos
 * - Si un hijo muere, el padre tumba al otro y sale con su mismo código
 *
 * Para producción seguir usando `npm run start:prod` (solo API sirviendo dist/).
 * Para arrancar solo la API en desarrollo: `npm run start:api`.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
const serverJs = join(root, 'server', 'server.js');
const viteJs = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

if (!existsSync(viteJs)) {
  console.error(
    '[start-dev] No se encontró node_modules/vite/bin/vite.js. Ejecute `npm install` en LoraWan-Monitoreo-y-Control antes de `npm start`.'
  );
  process.exit(1);
}

const apiArgs = ['--experimental-sqlite'];
if (existsSync(envFile)) apiArgs.push(`--env-file=${envFile}`);
apiArgs.push(serverJs);

const COLORS = { api: '36', front: '35' };

function streamWithPrefix(stream, label) {
  const tag = `\x1b[${COLORS[label]}m[${label}]\x1b[0m`;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${tag} ${line}\n`);
  });
  stream.on('end', () => {
    if (buf) process.stdout.write(`${tag} ${buf}\n`);
  });
}

const children = [];
let shuttingDown = false;
let firstExitCode = null;

function stopAll(signal = 'SIGTERM') {
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode == null && !child.killed) {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }
}

function launch(label, cmd, args) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  streamWithPrefix(child.stdout, label);
  streamWithPrefix(child.stderr, label);
  child.on('exit', (code, signal) => {
    const tag = `\x1b[${COLORS[label]}m[${label}]\x1b[0m`;
    process.stdout.write(`${tag} terminó (code=${code} signal=${signal ?? '-'})\n`);
    if (firstExitCode == null) firstExitCode = code ?? (signal ? 0 : 1);
    if (!shuttingDown) stopAll();
    if (children.every((c) => c.child.exitCode != null || c.child.signalCode != null)) {
      process.exit(firstExitCode ?? 0);
    }
  });
  children.push({ label, child });
  return child;
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));

launch('api', process.execPath, apiArgs);
launch('front', process.execPath, [viteJs]);
