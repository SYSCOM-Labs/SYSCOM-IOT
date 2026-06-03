#!/usr/bin/env node
/**
 * Genera un certificado TLS autofirmado para servir la API por HTTPS.
 *
 * Útil en deployments por IP (p. ej. EC2 sin dominio) donde no se puede emitir
 * un cert de Let's Encrypt. El navegador mostrará un aviso de "no seguro" la
 * primera vez (cert no confiable por una CA), pero el origen pasa a ser un
 * *secure context* HTTPS, lo que elimina los avisos de COOP / Origin-Agent-Cluster
 * y permite `upgrade-insecure-requests` sin romper la carga del SPA.
 *
 * Uso:
 *   node scripts/generate-self-signed-cert.mjs [host1] [host2] ...
 *   SYSCOM_TLS_HOSTS=18.227.111.16,iot.ejemplo.com node scripts/generate-self-signed-cert.mjs
 *
 * Si no se pasan hosts, usa 18.227.111.16, localhost y 127.0.0.1.
 * Genera server/certs/syscom-selfsigned.{key,crt} (ignorados por git).
 *
 * Luego, en el .env del servidor:
 *   SYSCOM_TLS_KEY=server/certs/syscom-selfsigned.key
 *   SYSCOM_TLS_CERT=server/certs/syscom-selfsigned.crt
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const certsDir = resolve(projectRoot, 'server', 'certs');
const keyPath = resolve(certsDir, 'syscom-selfsigned.key');
const certPath = resolve(certsDir, 'syscom-selfsigned.crt');

const DEFAULT_HOSTS = ['18.227.111.16', 'localhost', '127.0.0.1'];
const cliHosts = process.argv.slice(2).filter(Boolean);
const envHosts = String(process.env.SYSCOM_TLS_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const hosts = (cliHosts.length ? cliHosts : envHosts.length ? envHosts : DEFAULT_HOSTS);

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
// CN = primer host (compatibilidad con clientes viejos); la validación real va por SAN.
const cn = hosts[0];
// subjectAltName en formato openssl: "IP:1.2.3.4,DNS:host"
const altNames = hosts.map((h) => `${isIp(h) ? 'IP' : 'DNS'}:${h}`).join(',');

if (!existsSync(certsDir)) mkdirSync(certsDir, { recursive: true });

try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '3650',
      '-subj',
      `/C=MX/O=SYSCOM/CN=${cn}`,
      '-addext',
      `subjectAltName=${altNames}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
} catch (e) {
  console.error('❌ Falló openssl. ¿Está instalado y en el PATH?');
  console.error(e.message);
  process.exit(1);
}

console.log('🔒 Certificado autofirmado generado:');
console.log(`   key:  ${keyPath}`);
console.log(`   cert: ${certPath}`);
console.log(`   SAN:  ${altNames}`);
console.log('   validez: 3650 días');
console.log('');
console.log('Active HTTPS en el .env del servidor:');
console.log(`   SYSCOM_TLS_KEY=server/certs/syscom-selfsigned.key`);
console.log(`   SYSCOM_TLS_CERT=server/certs/syscom-selfsigned.crt`);
