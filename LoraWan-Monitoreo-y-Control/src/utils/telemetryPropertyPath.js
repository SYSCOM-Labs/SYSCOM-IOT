/**
 * Misma semántica que `server/lib/telemetryPropertyPath.js` (claves planas, rutas con puntos, fallback snake_case).
 */
export function getTelemetryPropertyValue(props, key) {
  if (!props || key == null || key === '') return undefined;
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];

  if (k.includes('.')) {
    const parts = k.split('.');
    let cur = props;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) {
        cur = undefined;
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(cur, p)) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (cur !== undefined) return cur;

    const snake = k.replace(/\./g, '_');
    if (snake !== k && Object.prototype.hasOwnProperty.call(props, snake)) return props[snake];
  }

  const want = k.toLowerCase();
  for (const pk of Object.keys(props)) {
    if (String(pk).toLowerCase() === want) return props[pk];
  }
  return undefined;
}
