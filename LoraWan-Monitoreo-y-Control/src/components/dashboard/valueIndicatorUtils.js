/** @param {string | undefined} t */
export function normalizeIndicatorType(t) {
  const x = String(t || 'numeric').toLowerCase();
  if (x === 'fill_level' || x === 'filllevel') return 'fill';
  return x;
}
