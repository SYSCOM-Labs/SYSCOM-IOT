/**
 * Corrige texto donde UTF-8 válido se interpretó como Latin-1 (p. ej. "GÃ¼ereque" → "Güereque").
 */
export function fixUtf8Mojibake(str) {
  if (str == null || typeof str !== 'string') return str;
  if (!str.includes('Ã') && !str.includes('Â')) return str;
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xff;
    }
    const fixed = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (fixed === str) return str;
    if (!/Ã/.test(fixed)) return fixed;
    if (/[äöüÄÖÜßñáéíóúÁÉÍÓÚÑ]/.test(fixed)) return fixed;
    return str;
  } catch {
    return str;
  }
}
