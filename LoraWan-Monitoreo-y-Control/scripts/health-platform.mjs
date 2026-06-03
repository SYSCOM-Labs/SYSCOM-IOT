/**
 * Comprueba GET /api/health/platform (no requiere JWT).
 * Uso: node scripts/health-platform.mjs [baseUrl]
 */
const base = (process.argv[2] || process.env.SYSCOM_HEALTH_URL || 'http://127.0.0.1:3001').replace(
  /\/$/,
  ''
);
const url = `${base}/api/health/platform`;

try {
  const res = await fetch(url);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok || !body.ok) process.exit(1);
  const s = body.services || {};
  if (!s.lnsEngine && s.lnsMac) {
    console.error('Advertencia: lnsMac activo pero lnsEngine=false');
    process.exit(1);
  }
} catch (e) {
  console.error('No se pudo contactar', url, '-', e.message || e);
  console.error('¿Está corriendo npm run production o la tarea SyscomIoT-Production?');
  process.exit(1);
}
