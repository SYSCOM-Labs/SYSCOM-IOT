'use strict';

/**
 * Alias legibles para telemetría Milesight VS133 / VS135 tras el payload decoder.
 * Los widgets pueden usar `people_count` en lugar de `line_1_total_in`, etc.
 */

const VS133_MODEL_RE = /vs\s*13[35]|vs135/i;

function numericValue(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isVs133ProductModel(productModel) {
  return VS133_MODEL_RE.test(String(productModel || ''));
}

function looksLikeVs133Decoded(props) {
  if (!props || typeof props !== 'object') return false;
  if (
    props.line_1_total_in !== undefined ||
    props.line_1_total_out !== undefined ||
    props.line_1_period_in !== undefined ||
    props.line_1_period_out !== undefined
  ) {
    return true;
  }
  const hist = props.history;
  if (!Array.isArray(hist) || !hist.length) return false;
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const row = hist[i];
    if (row && typeof row === 'object' && row.line_1_total_in !== undefined) return true;
  }
  return false;
}

/** Promueve conteos del último bloque `history` si no vienen en la raíz del uplink. */
function promoteLatestHistoryCounts(props) {
  const hist = props.history;
  if (!Array.isArray(hist) || !hist.length) return;
  const keys = [
    'line_1_total_in',
    'line_1_total_out',
    'line_1_period_in',
    'line_1_period_out',
    'line_1_child_total_in',
    'line_1_child_total_out',
  ];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const row = hist[i];
    if (!row || typeof row !== 'object') continue;
    let any = false;
    for (const k of keys) {
      if (props[k] !== undefined) continue;
      const n = numericValue(row[k]);
      if (n === null) continue;
      props[k] = n;
      any = true;
    }
    if (any) break;
  }
}

function mirrorAlias(props, alias, sourceKey) {
  const n = numericValue(props[sourceKey]);
  if (n === null) return;
  props[alias] = n;
}

function sumRegionCounts(props) {
  let sum = 0;
  let any = false;
  for (let r = 1; r <= 4; r += 1) {
    const n = numericValue(props[`region_${r}_count`]);
    if (n === null) continue;
    sum += n;
    any = true;
  }
  return any ? sum : null;
}

/**
 * @param {Record<string, unknown>} properties Telemetría ya fusionada con salida del decoder.
 * @param {{ productModel?: string }} [opts]
 * @returns {boolean} Si se aplicaron alias VS133.
 */
function applyVs133TelemetryAliases(properties, opts = {}) {
  if (!properties || typeof properties !== 'object') return false;

  const productModel = opts.productModel != null ? String(opts.productModel) : '';
  if (!isVs133ProductModel(productModel) && !looksLikeVs133Decoded(properties)) {
    return false;
  }

  promoteLatestHistoryCounts(properties);

  mirrorAlias(properties, 'people_count', 'line_1_total_in');
  mirrorAlias(properties, 'people_count_out', 'line_1_total_out');
  mirrorAlias(properties, 'people_in_period', 'line_1_period_in');
  mirrorAlias(properties, 'people_out_period', 'line_1_period_out');
  mirrorAlias(properties, 'total_in', 'line_1_total_in');
  mirrorAlias(properties, 'total_out', 'line_1_total_out');

  mirrorAlias(properties, 'conteo_personas', 'line_1_total_in');
  mirrorAlias(properties, 'conteo_personas_salida', 'line_1_total_out');
  mirrorAlias(properties, 'conteo_periodo', 'line_1_period_in');
  mirrorAlias(properties, 'conteo_periodo_salida', 'line_1_period_out');

  const tin = numericValue(properties.line_1_total_in);
  const tout = numericValue(properties.line_1_total_out);
  if (tin !== null && tout !== null) {
    properties.people_inside = Math.max(0, tin - tout);
    properties.personas_dentro = properties.people_inside;
  }

  const regionSum = sumRegionCounts(properties);
  if (regionSum !== null) {
    properties.people_in_regions = regionSum;
    properties.personas_en_zonas = regionSum;
  }

  return true;
}

module.exports = {
  applyVs133TelemetryAliases,
  isVs133ProductModel,
  looksLikeVs133Decoded,
};
