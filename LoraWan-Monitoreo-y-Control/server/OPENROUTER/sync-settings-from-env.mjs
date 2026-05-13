/**
 * Genera settings.json leyendo .env en esta carpeta.
 * Uso (desde la raíz del proyecto LoraWan-Monitoreo-y-Control): npm run openrouter:sync
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
const examplePath = join(__dirname, 'settings.example.json');
const outPath = join(__dirname, 'settings.json');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

if (!existsSync(envPath)) {
  console.error('Falta server/OPENROUTER/.env — copia .env.example a .env y pon ANTHROPIC_AUTH_TOKEN.');
  process.exit(1);
}

const env = parseEnv(readFileSync(envPath, 'utf8'));
const tpl = JSON.parse(readFileSync(examplePath, 'utf8'));

const token = env.ANTHROPIC_AUTH_TOKEN ?? '';
if (!token) {
  console.warn('AVISO: ANTHROPIC_AUTH_TOKEN está vacío en .env (rellénalo para usar la API).');
}

tpl.env.ANTHROPIC_BASE_URL =
  env.ANTHROPIC_BASE_URL || tpl.env.ANTHROPIC_BASE_URL;
tpl.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || tpl.env.ANTHROPIC_API_KEY;
tpl.env.ANTHROPIC_AUTH_TOKEN = token;

writeFileSync(outPath, JSON.stringify(tpl, null, 4) + '\n', 'utf8');
console.log('Listo: server/OPENROUTER/settings.json actualizado desde .env');
