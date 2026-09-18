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

/**
 * Prioridad PULL_RESP al vaciar un HEX clase A en RX1.
 * La cola diferida guardaba 0 y el ACK MAC / clase C (128) salían antes → TOO_LATE.
 */
const CLASS_A_UPLINK_FLUSH_PRIORITY = 254;

function classAUplinkFlushPriority(rowPriority) {
  const p = Number(rowPriority);
  const base = Number.isFinite(p) ? Math.max(0, Math.min(255, Math.floor(p))) : 0;
  return Math.max(base, CLASS_A_UPLINK_FLUSH_PRIORITY);
}

/**
 * Un uplink confirmado exige ACK, pero no si eso tapa el HEX de aplicación (válvula).
 * Solo ACK FPort 0 cuando no hay comando encolado ni flush hecho (el flush ya lleva el bit ACK).
 * DeviceTimeAns / LinkCheckAns ya llevan el bit ACK: no mandar un segundo FPort 0 vacío.
 */
function shouldSendMacAckOnlyAfterUplink({ flushed, deferredStillQueued, pendingMacAck, macAnsSent }) {
  if (!pendingMacAck) return false;
  if (flushed) return false;
  if (deferredStillQueued) return false;
  if (macAnsSent) return false;
  return true;
}

/** CID DeviceTimeReq / DeviceTimeAns (LoRaWAN 1.0.3). */
const DEVICE_TIME_CID = 0x0d;
/** Unix 1980-01-06 00:00:00 UTC; GPS time del ANS suma leap seconds. */
const GPS_UNIX_OFFSET_SEC = 315964800;
const GPS_LEAP_SECONDS = 18;

/**
 * DeviceTimeAns: CID + GPS seconds LE + fracción 1/256 s.
 * @param {number} [nowMs]
 * @returns {Buffer}
 */
function buildDeviceTimeAnsMac(nowMs) {
  const t = Number(nowMs);
  const ms = Number.isFinite(t) && t > 0 ? t : Date.now();
  const unixSec = Math.floor(ms / 1000);
  const gpsSec = (unixSec - GPS_UNIX_OFFSET_SEC + GPS_LEAP_SECONDS) >>> 0;
  const frac = Math.floor(((ms % 1000) / 1000) * 256) & 0xff;
  const buf = Buffer.alloc(6);
  buf[0] = DEVICE_TIME_CID;
  buf.writeUInt32LE(gpsSec, 1);
  buf[5] = frac;
  return buf;
}

/**
 * Timewave (y otros) mandan DeviceTimeReq en FPort 0 (`0D`) o en FOpts.
 * Sin DeviceTimeAns el nodo reintenta OTAA y el HEX de RX1 queda en una sesión muerta.
 * @param {number|null|undefined} fPort
 * @param {Buffer|null|undefined} plainFrmpayload
 * @param {Buffer|null|undefined} fopts
 */
function uplinkHasDeviceTimeReq(fPort, plainFrmpayload, fopts) {
  const plain = Buffer.isBuffer(plainFrmpayload) ? plainFrmpayload : Buffer.alloc(0);
  const opts = Buffer.isBuffer(fopts) ? fopts : Buffer.alloc(0);
  if (Number(fPort) === 0 && plain.length >= 1 && (plain[0] & 0xff) === DEVICE_TIME_CID) return true;
  if (opts.length >= 1 && (opts[0] & 0xff) === DEVICE_TIME_CID) return true;
  return false;
}

/**
 * Si el concentrador rechaza un TX clase A (TOO_LATE), hay que devolver el HEX a la cola
 * diferida: reintentar el mismo `tmst` o pasarlo a `imme` no lo oye un nodo a pilas.
 * @returns {{ fPort: number, payloadHex: string, deviceClass: string, confirmed: boolean, devEui: string } | null}
 */
function parseClassAAppRestoreFromPullJson(pullRespJson) {
  let o = pullRespJson;
  if (typeof pullRespJson === 'string') {
    try {
      o = JSON.parse(pullRespJson);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;
  if (o._syscomLnsKind === 'join_accept') return null;
  const r = o._syscomAppRestore;
  if (!r || typeof r !== 'object') return null;
  const hex = String(r.payloadHex || '')
    .replace(/\s/g, '')
    .toLowerCase();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const cls = normalizeLorawanClassLetter(r.deviceClass);
  if (cls === 'C') return null;
  if (o.txpk && o.txpk.imme === true) return null;
  const fPort = Math.floor(Number(r.fPort));
  if (!Number.isFinite(fPort) || fPort < 1 || fPort > 223) return null;
  const deui = String(r.devEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  return {
    fPort,
    payloadHex: hex,
    deviceClass: cls,
    confirmed: Boolean(r.confirmed),
    devEui: deui.length === 16 ? deui : '',
  };
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
  CLASS_A_UPLINK_FLUSH_PRIORITY,
  classAUplinkFlushPriority,
  shouldSendMacAckOnlyAfterUplink,
  parseClassAAppRestoreFromPullJson,
  DEVICE_TIME_CID,
  buildDeviceTimeAnsMac,
  uplinkHasDeviceTimeReq,
};
