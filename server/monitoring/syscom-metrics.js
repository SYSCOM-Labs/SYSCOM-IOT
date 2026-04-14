/**
 * Métricas operativas en memoria (sin Prometheus ni servicios externos).
 * Expuestas vía GET /api/admin/syscom-metrics (solo personal autorizado).
 */
'use strict';

const startedAt = Date.now();

const counters = {
  telemetry_saved: 0,
  telemetry_duplicate_skipped: 0,
  ingest_test_no_device: 0,
  login_attempt: 0,
  login_success: 0,
  login_fail: 0,
  rate_limit_reject: 0,
  lns_ui_events: 0,
  sse_broadcast_telemetry: 0,
  sse_broadcast_lns: 0,
};

function inc(key, n = 1) {
  if (!Object.prototype.hasOwnProperty.call(counters, key)) return;
  counters[key] += n;
}

function snapshot() {
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    counters: { ...counters },
  };
}

module.exports = {
  inc,
  snapshot,
  counters,
};
