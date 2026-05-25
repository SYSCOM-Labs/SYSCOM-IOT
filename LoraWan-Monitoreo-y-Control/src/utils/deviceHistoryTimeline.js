/**
 * Combina telemetría y downlinks para la pestaña Historial del modal de dispositivo.
 */

/**
 * @param {unknown[]} telemetryRows
 * @param {unknown[]} downlinkRows
 * @returns {Array<{ kind: 'telemetry' | 'downlink', histId: string, timestamp: number, properties?: object, downlink?: object }>}
 */
export function mergeDeviceHistoryTimeline(telemetryRows, downlinkRows) {
  const tel = (Array.isArray(telemetryRows) ? telemetryRows : []).map((row, i) => ({
    kind: 'telemetry',
    histId: row.histId || `tel-${row.timestamp ?? 0}-${i}`,
    timestamp: row.timestamp != null ? Number(row.timestamp) : 0,
    properties: row.properties && typeof row.properties === 'object' ? row.properties : {},
  }));
  const dl = (Array.isArray(downlinkRows) ? downlinkRows : []).map((row, i) => {
    const ts = row.timestamp != null ? Number(row.timestamp) : 0;
    return {
      kind: 'downlink',
      histId: row.id != null ? `dl-${row.id}` : `dl-${ts}-${i}`,
      timestamp: ts,
      downlink: {
        id: row.id,
        payloadHex: row.payloadHex != null ? String(row.payloadHex) : '',
        source: row.source != null ? String(row.source) : 'user',
        ruleId: row.ruleId != null ? String(row.ruleId) : null,
        ruleName: row.ruleName != null ? String(row.ruleName) : null,
        actorUserName: row.actorUserName != null ? String(row.actorUserName) : null,
        deferred: Boolean(row.deferred),
      },
    };
  });
  return [...tel, ...dl].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * @param {{ source?: string, ruleName?: string | null, ruleId?: string | null, actorUserName?: string | null }} downlink
 */
export function formatDownlinkHistoryLabel(downlink) {
  if (!downlink || typeof downlink !== 'object') return 'Downlink';
  const src = String(downlink.source || 'user').toLowerCase();
  if (src === 'automation') {
    const name =
      (downlink.ruleName != null && String(downlink.ruleName).trim()) ||
      (downlink.ruleId != null && String(downlink.ruleId).trim()) ||
      'Regla';
    return `Downlink recibido por la regla (${name})`;
  }
  const user =
    (downlink.actorUserName != null && String(downlink.actorUserName).trim()) || 'Usuario';
  return `Downlink recibido por el usuario (${user})`;
}
