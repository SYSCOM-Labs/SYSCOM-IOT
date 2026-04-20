/**
 * Genera certificados TLS autofirmados para desarrollo local (Vite HTTPS).
 * SAN: localhost, 127.0.0.1, ::1
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const certsDir = path.join(root, 'certs');
const keyPath = path.join(certsDir, 'localhost.key');
const crtPath = path.join(certsDir, 'localhost.crt');

function findOpenssl() {
  const candidates = ['openssl'];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe'
    );
  }
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'pipe' });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

const openssl = findOpenssl();
if (!openssl) {
  console.error(
    '[certs] No se encontró OpenSSL. En Windows suele venir con Git for Windows, o instale OpenSSL y añádalo al PATH.'
  );
  process.exit(1);
}

mkdirSync(certsDir, { recursive: true });

const args = [
  'req',
  '-x509',
  '-newkey',
  'rsa:4096',
  '-sha256',
  '-days',
  '825',
  '-nodes',
  '-keyout',
  keyPath,
  '-out',
  crtPath,
  '-subj',
  '/CN=localhost/O=SYSCOM-IOT/OU=Development',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
];

execFileSync(openssl, args, { stdio: 'inherit', cwd: root });
console.log('[certs] Listo:');
console.log(' ', crtPath);
console.log(' ', keyPath);
