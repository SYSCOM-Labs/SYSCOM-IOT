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

/**
 * Tras un uplink, `processDataUp` reserva silencio clase C (`postUplinkQuietMs`).
 * Un segundo `scheduleClassCNotBeforeMs(now)` avanza `prev + classCTxGapMs`.
 * Ese floor no debe aplicarse a PULL_RESP clase A: RX1 (1–5 s) ya habría cerrado
 * y el gateway rechaza el `tmst` con TOO_LATE.
 *
 * @param {number} postUplinkQuietMs
 * @param {number} classCTxGapMs
 * @param {number|null|undefined} rxDelaySec
 * @param {number} [slackMs]
 * @returns {boolean}
 */
function classCGwFloorMissesClassARx1(postUplinkQuietMs, classCTxGapMs, rxDelaySec, slackMs) {
  const quiet = Number(postUplinkQuietMs);
  const gap = Number(classCTxGapMs);
  if (!Number.isFinite(quiet) || !Number.isFinite(gap) || quiet < 0 || gap < 0) return false;
  const floorDelayMs = quiet + gap;
  const delaySec = Math.max(1, Math.min(15, Number(rxDelaySec) > 0 ? Number(rxDelaySec) : 1));
  const slack =
    slackMs != null && Number.isFinite(Number(slackMs)) ? Math.max(0, Number(slackMs)) : 300;
  return floorDelayMs + slack >= delaySec * 1000;
}

/**
 * Solo clase C usa el hueco `imme` por gateway al encolar PULL_RESP.
 * Clase A/B deben salir de inmediato con `tmst` de RX1/ping; el uplink ya reservó el silencio clase C.
 *
 * @param {'A'|'B'|'C'|string} cls
 * @returns {boolean}
 */
function downlinkPullRespUsesClassCGwFloor(cls) {
  return normalizeLorawanClassLetter(cls) === 'C';
}

/**
 * RxDelay de TX clase A. Join-Accept US915 anuncia 5 s; una sesión con 1 (default SQL)
 * programa RX1 a +1 s y el nodo escucha a +5 s.
 * @param {number|null|undefined} sessionRxDelaySec
 * @param {boolean} isUs915
 * @returns {number}
 */
function resolveClassARxDelaySec(sessionRxDelaySec, isUs915) {
  const raw = sessionRxDelaySec != null ? Number(sessionRxDelaySec) : NaN;
  if (isUs915) {
    if (!Number.isFinite(raw) || raw < 1 || raw === 1) return 5;
    return Math.max(1, Math.min(15, raw));
  }
  if (Number.isFinite(raw) && raw >= 1) return Math.max(1, Math.min(15, raw));
  return 1;
}

/**
 * Evita rotar claves por un Join-Request **inmediato** tras un uplink de datos
 * (el Join-Accept ocuparía RX1 y no llevaría el HEX de válvula).
 *
 * No debe bloquear un rejoin real: Timewave hace AT+Link confirmado; si no hay ACK,
 * entra en OTAA. Un veto de horas deja al medidor mudo (y el botón de 5 s tampoco
 * reporta). Tampoco vetar si `pendingMacAck` sigue true: el nodo no vio el ACK.
 *
 * @param {{ fcntUp?: number, lastUplinkWallMs?: number, pendingMacAck?: boolean } | null | undefined} session
 * @param {number} nowMs
 * @param {number} suppressMs 0 = no suprimir
 */
function shouldSuppressOtaaJoinForLiveSession(session, nowMs, suppressMs) {
  const win = Number(suppressMs);
  if (!Number.isFinite(win) || win <= 0 || !session) return false;
  if (session.pendingMacAck === true) return false;
  const fcntUp = Number(session.fcntUp);
  if (!Number.isFinite(fcntUp) || fcntUp < 0) return false;
  const t = Number(session.lastUplinkWallMs);
  if (!Number.isFinite(t) || t <= 0) return false;
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now <= 0) return false;
  const age = now - t;
  return age >= 0 && age < win;
}

module.exports = {
  normalizeLorawanClassLetter,
  downlinkDeferUntilUplink,
  downlinkUsesClassCImme,
  classARxStillOpen,
  classCGwFloorMissesClassARx1,
  downlinkPullRespUsesClassCGwFloor,
  resolveClassARxDelaySec,
  shouldSuppressOtaaJoinForLiveSession,
};
