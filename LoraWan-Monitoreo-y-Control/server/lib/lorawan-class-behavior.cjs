'use strict';

const { normalizeDeviceClass } = require('./resolve-downlink-class.cjs');

/**
 * Comportamiento de downlinks según clase LoRaWAN (definida en plantilla / decode-config).
 * C: TX inmediata (`imme`), no esperar uplink.
 * A/B: ventana RX tras uplink; si falla, cola diferida hasta próximo uplink.
 */

/**
 * @param {unknown} raw
 * @returns {'A'|'B'|'C'}
 */
function normalizeLorawanClassLetter(raw) {
  return normalizeDeviceClass(raw);
}

/**
 * @param {'A'|'B'|'C'|string} cls
 * @returns {boolean}
 */
function downlinkDeferUntilUplink(cls) {
  return normalizeLorawanClassLetter(cls) !== 'C';
}

/**
 * @param {'A'|'B'|'C'|string} cls
 * @returns {boolean}
 */
function downlinkUsesClassCImme(cls) {
  return normalizeLorawanClassLetter(cls) === 'C';
}

/**
 * ¿Aún da tiempo de programar RX1/RX2 en el futuro?
 * La ventana RF de clase A es RECEIVE_DELAY (1–5 s) tras el uplink, no 35 s.
 * Encolar después hace que el gateway reciba un `tmst` en el pasado → TOO_LATE y el nodo no aplica el comando.
 *
 * @param {number} elapsedMs milisegundos desde `lastUplinkWallMs`
 * @param {number|null|undefined} rxDelaySec RECEIVE_DELAY_1 de la sesión (Join-Accept)
 * @param {{ windowMode?: string, rx2AfterRx1Sec?: number, slackMs?: number }} [opts]
 * @returns {boolean}
 */
function classARxStillOpen(elapsedMs, rxDelaySec, opts = {}) {
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  const delaySec = Math.max(1, Math.min(15, Number(rxDelaySec) > 0 ? Number(rxDelaySec) : 1));
  const afterRx1 = Math.max(0, Number(opts.rx2AfterRx1Sec) > 0 ? Number(opts.rx2AfterRx1Sec) : 1);
  const slackRaw = opts.slackMs;
  const slack =
    slackRaw != null && Number.isFinite(Number(slackRaw)) ? Math.max(0, Number(slackRaw)) : 300;
  const rx1Ms = delaySec * 1000;
  const mode = String(opts.windowMode || 'RX1').trim().toUpperCase();
  const targetMs = mode === 'RX2' || mode === 'SCHED_RX2' || mode === 'WINDOW2' ? rx1Ms + afterRx1 * 1000 : rx1Ms;
  return elapsed + slack < targetMs;
}

module.exports = {
  normalizeLorawanClassLetter,
  downlinkDeferUntilUplink,
  downlinkUsesClassCImme,
  classARxStillOpen,
};
