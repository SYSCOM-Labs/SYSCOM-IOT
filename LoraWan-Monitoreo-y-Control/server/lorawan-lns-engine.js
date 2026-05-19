'use strict';

const crypto = require('crypto');
const lora_packet = require('lora-packet');
const { deriveSessionKeys10x, parseKeyHex32 } = require('./lorawan-lns-crypto');
const { lorawanUs915Only } = require('./lorawan-us915-region');

const LORAWAN_US915_ONLY = lorawanUs915Only();

/** Seguimiento en memoria de downlinks app con `track_tx_ack` (libera `setTimeout` al llegar GW_TX_ACK). */
const pendingDownlinks = new Map();

function normGwPendingKey(gw) {
  return String(gw || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

// ========== Defaults LNS (US915 / UG65; sobreescribibles por env) ==========
const RX1_DELAY_US_DEFAULT = 5_000_000;
const RX2_AFTER_RX1_SEC_DEFAULT = 1;
/** Espacio mínimo entre downlinks al mismo GW (clase C `imme` + Join-Accept); equilibrio UG65 / Botón OTAA. */
const CLASS_C_TX_GAP_MS_DEFAULT = 1200;
const TX_ACK_TIMEOUT_MS_DEFAULT = 5000;

function getRx2AfterRx1Sec() {
  return envInt('SYSCOM_LNS_RX2_AFTER_RX1_SEC', RX2_AFTER_RX1_SEC_DEFAULT);
}

function getClassCTxGapMs() {
  return Math.max(0, envInt('SYSCOM_LNS_CLASS_C_TX_GAP_MS', CLASS_C_TX_GAP_MS_DEFAULT));
}

/** Alineado con `store.readLnsTxAckPruneSilenceMs` (timeout sin GW_TX_ACK). */
function getTxAckTimeoutMs() {
  for (const key of ['SYSCOM_LNS_TX_ACK_TIMEOUT_MS', 'SYSCOM_LNS_TX_ACK_SILENCE_MS']) {
    const raw = process.env[key];
    if (raw != null && String(raw).trim() !== '') {
      const n = parseInt(String(raw).trim(), 10);
      if (Number.isFinite(n)) return Math.max(3000, n);
    }
  }
  return TX_ACK_TIMEOUT_MS_DEFAULT;
}

/** Retardo RX1 en µs: override por env o RxDelay de sesión (seg) alineado al Join-Accept. */
function classARx1DelayUs(rxDelaySec) {
  if (process.env.SYSCOM_LNS_RX1_DELAY_US != null && String(process.env.SYSCOM_LNS_RX1_DELAY_US).trim() !== '') {
    return Math.max(1_000_000, envInt('SYSCOM_LNS_RX1_DELAY_US', RX1_DELAY_US_DEFAULT));
  }
  /** Si no hay `rxDelaySec` de sesión (p. ej. `null` en `buildTxpk`), US915 típico usa 5 s; con Join-Accept sigue viniendo 1–15 s explícitos. */
  const s = rxDelaySec != null ? Math.max(1, Math.min(15, Number(rxDelaySec))) : 5;
  return s * 1000000;
}

function classARxWindowMode() {
  const m = String(process.env.SYSCOM_LNS_CLASS_A_RX_WINDOW || 'RX1')
    .trim()
    .toUpperCase();
  if (m === 'RX2' || m === 'SCHED_RX2' || m === 'WINDOW2') return 'RX2';
  return 'RX1';
}

/**
 * Si es false (`SYSCOM_LNS_TX_ACK=0`), el FCnt down se confirma al encolar (sin esperar GW_TX_ACK).
 * `SYSCOM_LNS_TX_ACK_ENABLED` (si está definido) tiene prioridad sobre `SYSCOM_LNS_TX_ACK`.
 * Pruebas con gateways que no envían `txpk_ack` (p. ej. algunos UG65): use `SYSCOM_LNS_TX_ACK=0` o `SYSCOM_LNS_APP_DOWNLINK_TX_ACK=0`.
 * Los downlinks de aplicación en **clase C** ya no esperan GW_TX_ACK por defecto (ver `appDownlinkTxAckWanted`).
 */
function txAckTrackingEnabled() {
  const en = process.env.SYSCOM_LNS_TX_ACK_ENABLED;
  if (en != null && String(en).trim() !== '') {
    const v = String(en).trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off';
  }
  return String(process.env.SYSCOM_LNS_TX_ACK || '1').trim() !== '0';
}

/** Alias explícito (`SYSCOM_LNS_TX_ACK_ENABLED` / `SYSCOM_LNS_TX_ACK`). */
function isTxAckEnabled() {
  return txAckTrackingEnabled();
}

/**
 * Downlinks de **aplicación** (API / UI): si `SYSCOM_LNS_APP_DOWNLINK_TX_ACK` está definido,
 * `0`/`off` = no esperar GW_TX_ACK; cualquier otro valor = sí (si el tracking global `SYSCOM_LNS_TX_ACK` está activo).
 * Si **no** está definido: **clase C** → no esperar GW_TX_ACK (muchas instalaciones UG65/Semtech: ACK tarde o token no correlacionado;
 * el nodo clase C recibe en ventana continua). Clase A/B → hereda `SYSCOM_LNS_TX_ACK` (defecto sí).
 */
function appDownlinkTxAckWanted(deviceClassNorm) {
  const raw = process.env.SYSCOM_LNS_APP_DOWNLINK_TX_ACK;
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off') return false;
    return true;
  }
  if (deviceClassNorm === 'C') return false;
  return true;
}

/**
 * Si true: la fila `lorawan_lns_sessions` solo tras GW_TX_ACK del Join-Accept (útil si el GW puede rechazar TX).
 * Si false: `lnsUpsertSessionJoin` al encolar Join-Accept (**por defecto**): muchos forwarders no envían TX_ACK y sin fila el nodo queda “offline”.
 * `SYSCOM_LNS_JOIN_COMMIT_ON_TX_ACK=1` fuerza diferido; `=0` fuerza inmediato.
 */
function joinSessionCommitDeferred() {
  const raw = process.env.SYSCOM_LNS_JOIN_COMMIT_ON_TX_ACK;
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'immediate') return false;
    if (v === '1' || v === 'true' || v === 'on' || v === 'tx_ack' || v === 'deferred') return true;
  }
  return false;
}

/**
 * Tras un join, el nodo puede reenviar Join Request varias veces (RX perdido, etc.).
 * Si cada vez asignamos un DevAddr nuevo, la BD y el firmware se desalinean → MIC inválido.
 * Reutilizar el mismo DevAddr durante unos segundos mantiene la dirección estable; las claves se derivan
 * con `lora-packet.generateSessionKeys10` (LoRaWAN 1.0.x), igual que el Join-Accept.
 * Desactivar: SYSCOM_LNS_JOIN_REUSE_DEVADDR_MS=0
 */
function joinReuseDevAddrWindowMs() {
  return Math.max(0, envInt('SYSCOM_LNS_JOIN_REUSE_DEVADDR_MS', 45000));
}

function txPower() {
  return envInt('SYSCOM_LNS_TX_POWER', 14);
}

function classARx1WindowMs() {
  return envInt('SYSCOM_LNS_CLASS_A_RX1_WINDOW_MS', 35000);
}

/** Clase C: si `SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1`, programar TX con `tmst` del reloj del GW (último uplink), no `imme`. */
function classCUseGatewayTmst() {
  return String(process.env.SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST || '').trim() === '1';
}

/** µs a sumar a `rxpk.tmst` para downlink clase C programado (defecto 500 ms). No usar wall-clock: el GW ignora Date.now. */
function classCTmstOffsetUs() {
  return Math.max(50_000, envInt('SYSCOM_LNS_CLASS_C_TMST_OFFSET_US', 500_000));
}

function netIdBuf() {
  const hex = String(process.env.SYSCOM_LNS_NET_ID || '000001').replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return Buffer.from('000001', 'hex');
  return Buffer.from(hex, 'hex');
}

/** LoRaWAN US902-928 (US915): RX2 por defecto RP001 — 923.3 MHz, DR8 = SF12BW500. */
const US915_RX2_DEFAULT_FREQ = 923.3;
const US915_RX2_DEFAULT_DATR = 'SF12BW500';

/**
 * Join-Accept `DLSettings` (1.0.x): nibble bajo = Rx2DR, bits altos = Rx1DROffset.
 * US915 exige Rx2DR = 8 (SF12BW500) para alinear con `rx2Defaults` / `txpk.datr` del LNS.
 * Con 0x00 el dispositivo escucha Rx2 en DR0 (SF10BW125) y no decodifica downlinks a SF12BW500.
 * Override: `SYSCOM_LNS_JOIN_DL_SETTINGS_US` (0–255). Otros planes: `SYSCOM_LNS_JOIN_DL_SETTINGS`.
 */
const US915_JOIN_DL_SETTINGS_RX2_DR8 = 0x08;

/**
 * US915 Join-Accept CFList (16 B, RP001): ChMask0..4 en LE (10 B) + RFU (5 B) + CFListType 0x01.
 * FSB `n`: 8 canales 125 kHz + un 500 kHz (p. ej. FSB2 → índices 8–15 y 65).
 * Desactivar: `SYSCOM_LNS_JOIN_US915_CFLIST=0`.
 * Subbanda si el alta no trae `FSB` en el texto: `SYSCOM_LNS_JOIN_US915_FSB` (1–8), por defecto **2** (8–15 + 65).
 */
function buildUs915JoinCfList16ForFsb(fsbN) {
  const fsb = Math.max(1, Math.min(8, Math.floor(Number(fsbN)) || 2));
  const idx = Math.floor((fsb - 1) / 2);
  const useHighBlock = (fsb - 1) % 2 === 1;
  const chMask125 = useHighBlock ? 0xff00 : 0x00ff;
  const chMask4 = (1 << (fsb - 1)) & 0xff;
  const out = Buffer.alloc(16, 0);
  out.writeUInt16LE(chMask125, idx * 2);
  out.writeUInt16LE(chMask4, 8);
  out[15] = 0x01;
  return out;
}

function resolveUs915JoinFsbFromGatewayBand(gwBandUpper) {
  const b = String(gwBandUpper || '').toUpperCase();
  const m = b.match(/FSB\s*(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 8) return n;
  }
  return Math.max(1, Math.min(8, envInt('SYSCOM_LNS_JOIN_US915_FSB', 2)));
}

function us915JoinCfListForJoin(gwBandUpper) {
  if (String(process.env.SYSCOM_LNS_JOIN_US915_CFLIST || '').trim() === '0') {
    return Buffer.alloc(0);
  }
  const fsb = resolveUs915JoinFsbFromGatewayBand(gwBandUpper);
  return buildUs915JoinCfList16ForFsb(fsb);
}

function isUs915Plan(opts, rxpk) {
  if (LORAWAN_US915_ONLY) return true;
  const band = (opts && opts.band != null ? String(opts.band) : '').trim().toUpperCase();
  if (band.startsWith('US902') || band.includes('US915')) return true;
  return upFreqInUs915Range(rxpk && rxpk.freq);
}

/**
 * RX2 / downlink inmediato: US915 por defecto en despliegue (SYSCOM_LNS_US915_ONLY distinto de 0).
 * Si define `SYSCOM_LNS_RX2_FREQ` (y opcionalmente `SYSCOM_LNS_RX2_DATR`), aplica como override global.
 * Sin override: US915 → 923.3 MHz + SF12BW500; con US915_ONLY=0 y plan EU → 869.525 + SF12BW125.
 * Opcional solo US: `SYSCOM_LNS_RX2_FREQ_US`, `SYSCOM_LNS_RX2_DATR_US`.
 */
function rx2Defaults(isUs915) {
  const codr = process.env.SYSCOM_LNS_RX2_CODR || '4/5';
  const rawFreq = process.env.SYSCOM_LNS_RX2_FREQ;
  const hasGlobalFreq = rawFreq != null && String(rawFreq).trim() !== '';
  const rawDatr = process.env.SYSCOM_LNS_RX2_DATR;
  const hasGlobalDatr = rawDatr != null && String(rawDatr).trim() !== '';

  if (hasGlobalFreq) {
    return {
      freq: envFloat('SYSCOM_LNS_RX2_FREQ', isUs915 ? US915_RX2_DEFAULT_FREQ : 869.525),
      datr: hasGlobalDatr ? String(rawDatr).trim() : (isUs915 ? US915_RX2_DEFAULT_DATR : 'SF12BW125'),
      codr,
    };
  }
  if (isUs915) {
    const fUs = process.env.SYSCOM_LNS_RX2_FREQ_US;
    const hasUsFreq = fUs != null && String(fUs).trim() !== '';
    const dUs = process.env.SYSCOM_LNS_RX2_DATR_US;
    const hasUsDatr = dUs != null && String(dUs).trim() !== '';
    return {
      freq: hasUsFreq ? envFloat('SYSCOM_LNS_RX2_FREQ_US', US915_RX2_DEFAULT_FREQ) : US915_RX2_DEFAULT_FREQ,
      datr: hasUsDatr ? String(dUs).trim() : US915_RX2_DEFAULT_DATR,
      codr,
    };
  }
  return {
    freq: envFloat('SYSCOM_LNS_RX2_FREQ', 869.525),
    datr: process.env.SYSCOM_LNS_RX2_DATR || 'SF12BW125',
    codr,
  };
}

function normalizeDeviceClass(v) {
  const u = String(v || 'A')
    .trim()
    .toUpperCase();
  return u === 'B' || u === 'C' ? u : 'A';
}

/**
 * Cálculo de frecuencia RX1 para US915 (RP001).
 * 923.3 + (canal_subida % 8) * 0.6 MHz.
 * Los centros 500 kHz (903.0 + n·1.6, p. ej. 904.6 MHz = canal 65 en UG65/FSB2) deben resolverse **antes** que la
 * rejilla 125 kHz: 904.6 también cae en [902.3, 914.9] y `round((f-902.3)/0.2)` daría un canal erróneo (p. ej. 12).
 */
function getUs915Rx1Freq(upFreqMhz) {
  const f = Number(upFreqMhz);
  if (!Number.isFinite(f)) return upFreqMhz;
  const tol500 = 0.081;
  const tol125 = 0.051;
  for (let n = 0; n <= 7; n += 1) {
    const c = 903.0 + n * 1.6;
    if (Math.abs(f - c) <= tol500) {
      const ch = 64 + n;
      const downCh = ch % 8;
      return parseFloat((923.3 + downCh * 0.6).toFixed(1));
    }
  }
  if (f >= 902.25 && f <= 915.05) {
    const n125 = Math.round((f - 902.3) / 0.2);
    if (n125 >= 0 && n125 <= 63) {
      const c125 = 902.3 + n125 * 0.2;
      if (Math.abs(f - c125) <= tol125) {
        const downCh = n125 % 8;
        return parseFloat((923.3 + downCh * 0.6).toFixed(1));
      }
    }
  }
  return upFreqMhz;
}

/**
 * Mapeo de DataRate RX1 para US915.
 * Uplink DR0..DR4 -> Downlink DR10..DR13 (500kHz).
 */
function getUs915Rx1Datr(upDatr) {
  const drMap = {
    SF10BW125: 'SF10BW500', // DR0 -> DR10
    SF9BW125: 'SF11BW500',  // DR1 -> DR11
    SF8BW125: 'SF12BW500',  // DR2 -> DR12
    SF7BW125: 'SF13BW500',  // DR3 -> DR13
    SF8BW500: 'SF13BW500',  // DR4 -> DR13
  };
  return drMap[upDatr] || 'SF12BW500';
}

/**
 * @param {Buffer} phy
 * @param {{ tmst?: number, freq?: number, datr?: string, codr?: string, rfch?: number }} rxpk
 * @param {{ imme?: boolean, rxDelaySec?: number, classAWindow?: 'RX1'|'RX2', band?: string, classCScheduledTmst?: boolean }} [opts]
 */
function buildTxpk(phy, rxpk, opts) {
  const useImme = opts && opts.imme === true;
  const scheduleClassCTmst = Boolean(opts && opts.classCScheduledTmst);
  const useGatewayTmstClassC =
    scheduleClassCTmst &&
    rxpk &&
    Number.isFinite(Number(rxpk.tmst)) &&
    Number(rxpk.tmst) > 0;
  const rxDelaySec =
    opts && opts.rxDelaySec != null ? Math.max(1, Math.min(15, Number(opts.rxDelaySec))) : null;
  const classAWindow = (opts && opts.classAWindow) || 'RX1';
  const isUs915 = isUs915Plan(opts, rxpk);

  const r2 = rx2Defaults(isUs915);
  let rfch = rxpk && rxpk.rfch != null ? Number(rxpk.rfch) : 0;
  /** TX RX2 US915 (~923 MHz): `imme`, clase C por `tmst`, o cadena distinta al uplink. Defecto **rfch 0** (Milesight UG65 típico con `SYSCOM_LNS_TX_RFCH_IMME_US915=0`). */
  if ((useImme || useGatewayTmstClassC) && isUs915 && Number(r2.freq) >= 920) {
    const rawRf = process.env.SYSCOM_LNS_TX_RFCH_IMME_US915;
    if (rawRf != null && String(rawRf).trim() !== '') {
      const forced = parseInt(String(rawRf).trim(), 10);
      if (Number.isFinite(forced) && forced >= 0 && forced <= 7) rfch = forced;
    } else {
      rfch = 0;
    }
  }
  const omitCodr500 =
    String(process.env.SYSCOM_LNS_TXPK_OMIT_CODR_BW500 || '').trim() === '1' &&
    String(r2.datr || '').includes('BW500');
  const base = {
    rfch,
    powe: txPower(),
    modu: 'LORA',
    ipol: true,
    size: phy.length,
    data: phy.toString('base64'),
  };

  if (useGatewayTmstClassC) {
    base.imme = false;
    base.tmst = (Number(rxpk.tmst) + classCTmstOffsetUs()) >>> 0;
    base.freq = r2.freq;
    base.datr = r2.datr;
    if (!omitCodr500) base.codr = r2.codr;
    return { txpk: base };
  }

  /** Clase A / B (y join): siempre `tmst` respecto al reloj del concentrador (`rxpk.tmst`). */
  if (!useImme) {
    base.imme = false;
    if (classAWindow === 'RX2') {
      const afterRx1Sec = getRx2AfterRx1Sec();
      const secOffset = (rxDelaySec != null ? rxDelaySec : 1) + afterRx1Sec;
      base.tmst = (Number(rxpk.tmst) + secOffset * 1_000_000) >>> 0;
      base.freq = r2.freq;
      base.datr = r2.datr;
      if (!omitCodr500) base.codr = r2.codr;
    } else {
      base.tmst = (Number(rxpk.tmst) + classARx1DelayUs(rxDelaySec)) >>> 0;
      if (isUs915) {
        base.freq = getUs915Rx1Freq(Number(rxpk.freq));
        base.datr = getUs915Rx1Datr(rxpk.datr);
      } else {
        base.freq = Number(rxpk.freq);
        base.datr = String(rxpk.datr || r2.datr);
      }
      if (
        !(
          String(process.env.SYSCOM_LNS_TXPK_OMIT_CODR_BW500 || '').trim() === '1' &&
          String(base.datr || '').includes('BW500')
        )
      ) {
        base.codr = String(rxpk.codr || '4/5');
      }
    }
    return { txpk: base };
  }

  base.imme = true;
  base.freq = r2.freq;
  base.datr = r2.datr;
  if (!omitCodr500) base.codr = r2.codr;
  return { txpk: base };
}

function upFreqInUs915Range(freq) {
  if (!Number.isFinite(Number(freq))) return false;
  const f = Number(freq);
  // Heurística sin banda de gateway: US915 vs AU915 se solapan arriba de ~915 MHz; límite 915 evita AU915.
  return f >= 902.0 && f <= 915.0;
}

/** Métricas de radio desde rxpk Semtech (GWMP) para telemetría / ingesta. */
function radioMetaFromRxpk(rxpk) {
  if (!rxpk || typeof rxpk !== 'object') return {};
  const out = {};
  if (rxpk.rssi != null && Number.isFinite(Number(rxpk.rssi))) out.rssi = Number(rxpk.rssi);
  if (rxpk.lsnr != null && Number.isFinite(Number(rxpk.lsnr))) {
    const sn = Number(rxpk.lsnr);
    out.lsnr = sn;
    out.snr = sn;
  }
  if (rxpk.freq != null && Number.isFinite(Number(rxpk.freq))) out.freq = Number(rxpk.freq);
  if (rxpk.datr != null && String(rxpk.datr).trim() !== '') {
    const d = String(rxpk.datr).trim();
    out.datr = d;
    out.datarate = d;
    out.dr = d;
  }
  return out;
}

/**
 * Retardo wall-time antes de devolver Join-Accept en PULL_RESP.
 * Debe ser **0** por defecto: el `txpk.tmst` ya apunta a JR+RxDelay en reloj del GW; retrasar aquí
 * hacía que el forwarder recibiera el downlink **tarde** → `TX_ACK` TOO_LATE y el nodo nunca completaba OTAA.
 * Solo diagnóstico: `SYSCOM_LNS_JOIN_QUEUE_NOT_BEFORE_MS` > 0.
 */
function joinPullQueueNotBeforeMs() {
  return Math.max(0, envInt('SYSCOM_LNS_JOIN_QUEUE_NOT_BEFORE_MS', 0));
}

/** PingSlotInfoAns (LoRaWAN 1.0.x): CID 0x11 + 3 B freq + 1 B (DR|Periodicity). */
function tryParsePingSlotInfoAns(plainBuf) {
  if (!plainBuf || plainBuf.length < 5) return null;
  for (let i = 0; i <= plainBuf.length - 5; i += 1) {
    if (plainBuf[i] !== 0x11) continue;
    const periodicity = plainBuf[i + 4] & 0x07;
    const dr = (plainBuf[i + 4] >> 3) & 0x07;
    return { periodicity, dr };
  }
  return null;
}

function estimateClassBNotBeforeMs(session) {
  const now = Date.now();
  const bp = envInt('SYSCOM_LNS_CLASSB_BEACON_PERIOD_MS', 128000);
  const p = session.classBPingPeriodicity;
  if (p >= 0 && p <= 7) {
    const slotMs = Math.max(30, 2 ** p * 30);
    let w = slotMs - (now % slotMs);
    if (w < 15) w += slotMs;
    return now + w;
  }
  let w = bp - (now % bp);
  if (w < 20) w += bp;
  return now + Math.min(w, bp);
}

function buf8ToHex16(buf) {
  return buf.toString('hex').toLowerCase();
}

/**
 * LoRaWAN 1.0.x: el MIC y el AES del payload usan un FCnt de **32 bits**; en el aire solo van los 16 bits bajos.
 * Hay que reconstruir los 16 bits altos con el último FCnt guardado en sesión (igual que ChirpStack / NS).
 * @param {number} sessionFcntUp último FCnt confirmado (32 bits, o -1 si aún no hubo uplink)
 * @param {number} wireFcnt16 valor de `p.getFCnt()` (16 bits del PHYPayload)
 * @returns {{ fcnt32: number, fCntMSBytes: Buffer }}
 */
function resolveFcnt32ForMic(sessionFcntUp, wireFcnt16) {
  const lo = Number(wireFcnt16) & 0xffff;
  const msb = Buffer.alloc(2);
  if (!Number.isFinite(lo)) {
    msb.writeUInt16BE(0, 0);
    return { fcnt32: 0, fCntMSBytes: msb };
  }
  if (sessionFcntUp == null || sessionFcntUp < 0) {
    msb.writeUInt16BE(0, 0);
    return { fcnt32: lo >>> 0, fCntMSBytes: msb };
  }
  const prev = sessionFcntUp >>> 0;
  const prevHi = (prev >>> 16) & 0xffff;
  let cand = (((prevHi & 0xffff) << 16) >>> 0) + (lo & 0xffff);
  if (cand <= prev) cand = (cand + 0x10000) >>> 0;
  msb.writeUInt16BE((cand >>> 16) & 0xffff, 0);
  return { fcnt32: cand >>> 0, fCntMSBytes: msb };
}

/**
 * Orden de prueba de FCnt MSB (2 B) para verifyMIC/decrypt cuando la sesión SQLite
 * quedó desalineada respecto al contador real del nodo (solo este LNS, sin otro NS).
 * @returns {Buffer[]}
 */
function listFcntMsbCandidatesForMic(sessionFcntUp, wireFcnt16) {
  const lo = Number(wireFcnt16) & 0xffff;
  if (!Number.isFinite(lo)) return [Buffer.from([0, 0])];
  const primary = resolveFcnt32ForMic(sessionFcntUp, wireFcnt16).fCntMSBytes;
  const out = [];
  const push = (buf) => {
    if (!buf || buf.length !== 2) return;
    const k = buf.toString('hex');
    if (out.some((b) => b.toString('hex') === k)) return;
    out.push(Buffer.from(buf));
  };
  push(primary);
  const z = Buffer.alloc(2);
  z.writeUInt16BE(0, 0);
  push(z);
  /** Primer uplink tras join (fcnt_up = -1 en BD): probar algunos MSB altos por si el stack envía FCnt ya en bloque alto. */
  if (sessionFcntUp == null || sessionFcntUp < 0) {
    for (const hi of [1, 2, 0xffff, 0xfffe, 0xfffd]) {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(hi & 0xffff, 0);
      push(b);
    }
  }
  if (sessionFcntUp != null && sessionFcntUp >= 0) {
    const prevHi = (sessionFcntUp >>> 16) & 0xffff;
    const spread = Math.min(
      32,
      Math.max(8, parseInt(process.env.SYSCOM_LNS_FCNT_MSB_SEARCH || '16', 10) || 16)
    );
    for (let d = -spread; d <= spread; d += 1) {
      const b = Buffer.alloc(2);
      b.writeUInt16BE((prevHi + d + 65536) % 65536, 0);
      push(b);
    }
  }
  const ph = primary.readUInt16BE(0);
  for (let d = -3; d <= 3; d += 1) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE((ph + d + 65536) % 65536, 0);
    push(b);
  }
  return out;
}

function fcnt32FromMsbAndWireLo(msbBuf, wireFcnt16) {
  const lo = Number(wireFcnt16) & 0xffff;
  const hi = msbBuf.readUInt16BE(0) & 0xffff;
  return (((hi & 0xffff) << 16) >>> 0) | (lo & 0xffff);
}

/**
 * Longitud del payload MAC en uplink (end-device → NS), LoRaWAN 1.0.x.
 * @returns {number} bytes tras el CID; -1 = CID desconocido (se aborta el barrido).
 */
function uplinkMacPayloadLenAfterCid(cid) {
  switch (cid & 0xff) {
    case 0x02:
      return 0; // LinkCheckReq
    case 0x03:
      return 1; // LinkADRAns
    case 0x04:
      return 0; // DutyCycleAns
    case 0x05:
      return 1; // RXParamSetupAns
    case 0x06:
      return 2; // DevStatusAns
    case 0x07:
      return 1; // NewChannelAns
    case 0x08:
    case 0x09:
      return 0; // RXTimingSetupAns, TXParamSetupAns
    case 0x0a:
      return 1; // DlChannelAns
    default:
      return -1;
  }
}

function macBufferContainsLinkCheckReq(buf) {
  if (!buf || !buf.length) return false;
  let i = 0;
  while (i < buf.length) {
    const cid = buf[i] & 0xff;
    const plen = uplinkMacPayloadLenAfterCid(cid);
    if (plen < 0) return false;
    if (cid === 0x02) return true;
    i += 1 + plen;
  }
  return false;
}

/**
 * Milesight WS101 (manual): en OTAA con «rejoin mode» manda LinkCheckReq; si no hay respuesta, re-join.
 * Los MAC pueden ir en FOpts (p. ej. con FPort 85) o en FRMPayload con FPort 0.
 */
function otaaUplinkHasLinkCheckReq(packet, fPort, plainFrmpayload) {
  const fopts = packet && packet.FOpts && Buffer.isBuffer(packet.FOpts) ? packet.FOpts : Buffer.alloc(0);
  if (macBufferContainsLinkCheckReq(fopts)) return true;
  if (fPort === 0 && plainFrmpayload && plainFrmpayload.length) {
    return macBufferContainsLinkCheckReq(plainFrmpayload);
  }
  return false;
}

function linkCheckAnsToDeviceEnabled() {
  return String(process.env.SYSCOM_LNS_LINK_CHECK_ANS || '1').trim() !== '0';
}

/**
 * @param {{
 *   store: object,
 *   saveIngestEntry: (userId: string, data: object) => void,
 *   runLegacyUplink: (userId: string, body: object) => void,
 *   insertUiEvent?: (userId: string, devEui: string, eventType: string, metaJson: string | null) => void,
 * }} ctx
 */
function createLorawanLnsEngine(ctx) {
  const { store, saveIngestEntry, runLegacyUplink } = ctx;
  const insertUiEvent =
    typeof ctx.insertUiEvent === 'function'
      ? ctx.insertUiEvent
      : (uid, deui, type, meta) => store.lnsInsertUiEvent(uid, deui, type, meta);

  function storePendingDownlink(userId, gatewayEui, devEui, fCnt, timeoutMs) {
    const g = normGwPendingKey(gatewayEui);
    const d = String(devEui || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (g.length !== 16 || d.length !== 16) return;
    const key = `${g}:${d}`;
    const prev = pendingDownlinks.get(key);
    if (prev && prev.timeout) clearTimeout(prev.timeout);
    const uid = String(userId || '').trim();
    const timeout = setTimeout(() => {
      pendingDownlinks.delete(key);
      console.warn('[LNS] Timeout txpk_ack (memoria)', key);
      try {
        if (typeof store.lnsDeletePendingAppDownlinksForDev === 'function') {
          store.lnsDeletePendingAppDownlinksForDev(uid, d);
        }
      } catch (e) {
        console.warn('[LNS] timeout cola app:', e.message);
      }
      if (typeof store.lnsHandleTxAck === 'function') {
        try {
          store.lnsHandleTxAck(g, 'TIMEOUT', { devEui: d });
        } catch {
          /* ignore */
        }
      }
      try {
        insertUiEvent(
          uid,
          d,
          'downlink_gateway_ack',
          JSON.stringify({
            ok: false,
            error: 'TIMEOUT_NO_GW_TX_ACK',
            fCnt: fCnt != null ? Number(fCnt) : null,
            gatewayEui: g,
            timeout: true,
            source: 'memory_timer',
          })
        );
      } catch (e2) {
        console.warn('[LNS] timeout UI event:', e2.message);
      }
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();
    pendingDownlinks.set(key, { userId: uid, devEui: d, fCnt, timeout, gatewayEui: g });
  }

  function resolvePendingDownlink(gatewayEui, devEui, error) {
    const g = normGwPendingKey(gatewayEui);
    const d =
      devEui != null
        ? String(devEui)
            .replace(/[^0-9a-fA-F]/g, '')
            .toLowerCase()
        : '';
    if (d.length === 16) {
      const key = `${g}:${d}`;
      const entry = pendingDownlinks.get(key);
      if (entry) {
        clearTimeout(entry.timeout);
        pendingDownlinks.delete(key);
        console.log('[LNS] Downlink memoria resuelto', key, 'error=', error);
        return true;
      }
    }
    for (const [key, entry] of pendingDownlinks.entries()) {
      if (key.startsWith(`${g}:`)) {
        clearTimeout(entry.timeout);
        pendingDownlinks.delete(key);
        console.log('[LNS] Downlink memoria resuelto (primer gw)', key, 'error=', error);
        return true;
      }
    }
    return false;
  }

  function handleTxAck(gatewayEui, error, ackPayload) {
    const p = ackPayload && typeof ackPayload === 'object' ? ackPayload : {};
    const devFromAck =
      p.devEui != null
        ? String(p.devEui)
            .replace(/[^0-9a-fA-F]/g, '')
            .toLowerCase()
        : '';
    if (devFromAck.length === 16) {
      resolvePendingDownlink(gatewayEui, devFromAck, error);
    } else {
      resolvePendingDownlink(gatewayEui, null, error);
    }
  }

  /** Contador de MIC inválidos solo para diagnóstico (la sesión ya no se purga por esto). */
  const micFailStreak = new Map();
  /** Data up sin sesión: evitar spam en consola (DevAddr tras purga / nodo sin rejoin). */
  const dataUpNoSessionLogAt = new Map();
  /** Máximo un aviso de «sin sesión» por usuario en este intervalo (varios DevAddr distintos / radio vecina). */
  const dataUpNoSessionAnyLogAt = new Map();
  /** Join OTAA de nodos no dados de alta en la cuenta (radio vecina / otro tenant). */
  const joinUnknownLogAt = new Map();
  /** MIC datos inválido: mismo DevAddr puede spamear cada uplink. */
  const micDataInvalidLogAt = new Map();
  /** Tras un join OTAA, el nodo puede seguir unos segundos con el DevAddr viejo; aquí anotamos el par user+addr viejo → dev_eui (TTL). */
  const supersededDevAddrHint = new Map();
  /**
   * Siguiente `not_before_ms` (epoch) para downlinks clase C al mismo GW+usuario.
   * Sin esto, varios `imme` seguidos → GW_TX_ACK **TOO_LATE** o **TOO_EARLY** (SX130x aún TX, cola HW o guard time tras RX).
   * Ajuste típico UG65 / ráfagas si hay **TOO_LATE / TOO_EARLY**: `SYSCOM_LNS_CLASS_C_TX_GAP_MS=1200`–`2200`.
   * Predeterminado **0** (máxima inmediatez); suba el valor si el concentrador rechaza TX en ráfaga.
   */
  const classCNextEligibleMsByGw = new Map();

  function scheduleClassCNotBeforeMs(userId, gatewayEuiNorm16, wallFloorMs) {
    const gap = getClassCTxGapMs();
    const k = `${String(userId)}:${String(gatewayEuiNorm16 || '').toLowerCase()}`;
    const now = Date.now();
    const floor = Math.max(now, wallFloorMs || 0);
    if (gap <= 0) return floor;
    const prev = classCNextEligibleMsByGw.get(k) || 0;
    const eligible = prev > 0 ? Math.max(floor, prev + gap) : floor;
    classCNextEligibleMsByGw.set(k, eligible);
    return eligible;
  }

  function micFailStreakKey(userId, devAddrHex) {
    return `${userId}:${String(devAddrHex || '').toUpperCase()}`;
  }

  function clearMicFailStreak(userId, devAddrHex) {
    micFailStreak.delete(micFailStreakKey(userId, devAddrHex));
  }

  function pruneSupersededDevAddrHints() {
    const t = Date.now();
    for (const [key, v] of supersededDevAddrHint) {
      if (!v || v.exp <= t) supersededDevAddrHint.delete(key);
    }
  }

  /** `SYSCOM_LNS_LOG_UNKNOWN_JOIN=0` silencia joins de EUI no registrados. Si no, intervalo ms entre avisos (def. 5 min). */
  function unknownJoinLogPolicy() {
    const off = String(process.env.SYSCOM_LNS_LOG_UNKNOWN_JOIN || '').trim() === '0';
    if (off) return { silent: true, intervalMs: 0 };
    return { silent: false, intervalMs: Math.max(60_000, envInt('SYSCOM_LNS_UNKNOWN_JOIN_LOG_MS', 300_000)) };
  }

  /** Uplinks sin sesión que no son “hint” de rejoin: suelen ser otro nodo; log más espaciado (def. 5 min). */
  function guestNoSessionLogMs() {
    return Math.max(120_000, envInt('SYSCOM_LNS_GUEST_UPLINK_LOG_MS', 300_000));
  }

  /** Entre dos avisos «Data up sin sesión» del mismo usuario (cualquier DevAddr), def. 2 min. Silencia ráfagas de muchos nodos ajenos. */
  function dataUpNoSessionAnyLogMs() {
    return Math.max(30_000, envInt('SYSCOM_LNS_NO_SESSION_ANY_LOG_MS', 120_000));
  }

  function micDataInvalidLogMs() {
    return Math.max(30_000, envInt('SYSCOM_LNS_MIC_FAIL_LOG_MS', 90_000));
  }

  function recordMicFailureAndMaybePurgeSession(userId, devAddrHex, devEuiNorm) {
    const key = micFailStreakKey(userId, devAddrHex);
    const now = Date.now();
    const windowMs = Math.max(30_000, envInt('SYSCOM_LNS_MIC_FAIL_WINDOW_MS', 180_000));
    let e = micFailStreak.get(key);
    if (!e || now - e.firstTs > windowMs) {
      e = { count: 0, firstTs: now };
    }
    e.count += 1;
    micFailStreak.set(key, e);
    const streakNeed = Math.max(1, Math.min(20, envInt('SYSCOM_LNS_MIC_FAIL_STREAK', 12)));
    if (e.count === 1 || e.count % streakNeed === 0) {
      console.warn(
        '[LNS] MIC inválido acumulado',
        e.count,
        'para DevAddr',
        String(devAddrHex).toUpperCase(),
        'dev_eui',
        devEuiNorm,
        '(la sesión en esta cuenta NO se borra; suele ser tráfico de otra red o claves distintas en el aire).'
      );
    }
  }

  /**
   * DevAddr para este Join-Accept: reutiliza el de la sesión reciente del mismo DevEUI (anti-tormenta de joins).
   */
  function pickOtaaJoinDevAddrBuf(userId, devEuiHex16) {
    const reuseMs = joinReuseDevAddrWindowMs();
    if (reuseMs <= 0) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const d = String(devEuiHex16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (d.length !== 16) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const sess = store.lnsGetSessionByDevEui(userId, d);
    if (!sess || !sess.devAddr) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const tWall = sess.lastUplinkWallMs != null ? Number(sess.lastUplinkWallMs) : 0;
    if (!Number.isFinite(tWall) || tWall <= 0) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const age = Date.now() - tWall;
    if (age < 0 || age >= reuseMs) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const hex = String(sess.devAddr || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (hex.length !== 8) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 4) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    const other = store.lnsGetSessionByDevAddr(userId, hex);
    if (other && String(other.devEui).toLowerCase() !== d) {
      return store.lnsAllocateDevAddrBuf(userId);
    }
    console.log(
      '[LNS] OTAA: mismo DevAddr en join repetido',
      hex,
      'dev_eui',
      d,
      `(sesión actualizada hace ~${Math.round(age / 1000)} s; ventana ${Math.round(reuseMs / 1000)} s — SYSCOM_LNS_JOIN_REUSE_DEVADDR_MS)`
    );
    return buf;
  }

  function processJoin(gatewayUserId, gatewayEuiNorm, p, rxpk) {
    const joinEui = buf8ToHex16(p.AppEUI);
    const devEui = buf8ToHex16(p.DevEUI);
    let row = store.lnsFindOtaaDeviceRow(gatewayUserId, joinEui, devEui);
    let ownerUserId = gatewayUserId;
    if (!row && typeof store.lnsFindOtaaDeviceRowInSuperadminPool === 'function') {
      const pool = store.lnsFindOtaaDeviceRowInSuperadminPool(joinEui, devEui);
      if (pool) {
        row = pool.row;
        ownerUserId = pool.userId;
        console.log('[LNS] OTAA join: pool superadmin unificado →', ownerUserId, 'devEUI', devEui);
      }
    }
    if (!row && typeof store.lnsFindOtaaDeviceRowGlobal === 'function') {
      const global = store.lnsFindOtaaDeviceRowGlobal(joinEui, devEui);
      if (global) {
        row = global.row;
        ownerUserId = global.userId;
        console.log(
          '[LNS] OTAA join: dispositivo en cuenta',
          ownerUserId,
          'recibido por gateway de cuenta',
          gatewayUserId,
          'devEUI',
          devEui
        );
      }
    }
    if (!row) {
      const pol = unknownJoinLogPolicy();
      if (!pol.silent) {
        const jk = `${gatewayUserId}:${devEui}:${joinEui}`;
        const now = Date.now();
        const last = joinUnknownLogAt.get(jk) || 0;
        if (now - last >= pol.intervalMs) {
          joinUnknownLogAt.set(jk, now);
          console.warn(
            '[LNS] Join sin dispositivo OTAA en app (no es su alta; suele ser radio vecina): devEUI',
            devEui,
            'JoinEUI',
            joinEui,
            `— próximo aviso en ~${Math.round(pol.intervalMs / 60000)} min o SYSCOM_LNS_LOG_UNKNOWN_JOIN=0 para silenciar.`
          );
        }
      }
      return false;
    }
    const appKeyBuf = parseKeyHex32(row.app_key);
    if (!appKeyBuf || !lora_packet.verifyMIC(p, undefined, appKeyBuf)) {
      console.warn('[LNS] Join Request MIC inválido o AppKey incorrecto');
      return false;
    }

    let devAddrBuf;
    try {
      devAddrBuf = pickOtaaJoinDevAddrBuf(ownerUserId, devEui);
    } catch (e) {
      console.error('[LNS]', e.message);
      return false;
    }
    const appNonce = crypto.randomBytes(3);
    const nid = netIdBuf();
    const { nwkSKey, appSKey } = deriveSessionKeys10x(appKeyBuf, appNonce, nid, p.DevNonce);

    const gw =
      store.lnsGetGatewayByEui(ownerUserId, gatewayEuiNorm) ||
      store.lnsGetGatewayByEui(gatewayUserId, gatewayEuiNorm) ||
      (typeof store.lnsGetGatewayByEuiAnyUser === 'function'
        ? store.lnsGetGatewayByEuiAnyUser(gatewayEuiNorm)
        : null);
    const gwBand = gw ? String(gw.frequencyBand || '').toUpperCase() : '';
    // Banda preferente desde BD del gateway; si no hay fila, heurística por frecuencia del uplink.
    const isUs915Join = isUs915Plan({ band: gwBand }, rxpk);

    let secUser = envInt('SYSCOM_LNS_RX_DELAY_SEC', 1);
    // Join-Accept RX1 delay (campo RxDelay): US915 → 5 s
    if (isUs915Join) secUser = 5;

    const rxEncoded = secUser <= 0 ? 0 : Math.min(15, secUser);
    const rxDelaySec = rxEncoded === 0 ? 1 : rxEncoded;

    const joinDlSettings = isUs915Join
      ? Math.max(0, Math.min(255, envInt('SYSCOM_LNS_JOIN_DL_SETTINGS_US', US915_JOIN_DL_SETTINGS_RX2_DR8)))
      : Math.max(0, Math.min(255, envInt('SYSCOM_LNS_JOIN_DL_SETTINGS', 0)));

    const joinCfList = isUs915Join ? us915JoinCfListForJoin(gwBand) : Buffer.alloc(0);

    const ja = lora_packet.fromFields(
      {
        MType: 'Join Accept',
        AppNonce: appNonce,
        NetID: nid,
        DevAddr: devAddrBuf,
        DLSettings: joinDlSettings,
        RxDelay: rxEncoded,
        CFList: joinCfList,
      },
      null,
      null,
      appKeyBuf
    );
    const phy = ja.getPHYPayload();

    const ud = store.getUserDeviceByDevEuiNorm(ownerUserId, devEui);
    const telemetryDeviceId = ud && ud.deviceId ? ud.deviceId : devEui;
    /** Clase en sesión: `device_decode_config` (plantilla) gana sobre `user_devices` vacío. Prueba `deviceId` de alta y DevEUI. */
    let fromCfg = null;
    for (const key of [String(telemetryDeviceId), String(devEui || '')].filter(
      (k, i, a) => k && a.indexOf(k) === i
    )) {
      const cfg = store.getDeviceDecodeConfig(key);
      const raw = cfg.lorawanClass ?? cfg.lorawan_class;
      if (raw != null && String(raw).trim() !== '') {
        fromCfg = String(raw).trim();
        break;
      }
    }
    const fromUd = row.lorawan_class || row.lorawanClass;
    const rawJoinClass =
      fromCfg != null && String(fromCfg).trim() !== ''
        ? fromCfg
        : fromUd != null && String(fromUd).trim() !== ''
          ? String(fromUd).trim()
          : null;
    const deviceClass = normalizeDeviceClass(rawJoinClass || 'A');
    const displayName =
      (ud && ud.displayName) || (row.display_name != null ? row.display_name : '') || row.displayName || devEui;

    /** Con `SYSCOM_LNS_JOIN_COMMIT_ON_TX_ACK=1` la sesión se difiere hasta GW_TX_ACK (evita fila si el GW rechaza el Join-Accept). Por defecto se escribe al encolar. */
    const upsertPayload = {
      userId: ownerUserId,
      devEui,
      devAddr: devAddrBuf.toString('hex').toUpperCase(),
      nwkSKeyHex: nwkSKey.toString('hex'),
      appSKeyHex: appSKey.toString('hex'),
      lastGatewayEui: gatewayEuiNorm,
      lastRxTmst: rxpk.tmst != null ? Number(rxpk.tmst) : null,
      lastRxFreq: rxpk.freq != null ? Number(rxpk.freq) : null,
      lastRxDatr: rxpk.datr != null ? String(rxpk.datr) : '',
      lastRxCodr: rxpk.codr != null ? String(rxpk.codr) : '',
      lastRxRfch: rxpk.rfch != null ? Number(rxpk.rfch) : null,
      deviceClass,
      lastUplinkWallMs: Date.now(),
      classBPingPeriodicity: -1,
      classBDataRate: null,
      rxDelaySec,
      pendingMacAck: false,
    };

    const pullObj = buildTxpk(phy, rxpk, { imme: false, rxDelaySec, band: gwBand });
    const joinTs = Date.now();
    const radioJoin = radioMetaFromRxpk(rxpk);
    const explicitJoinDelay = joinPullQueueNotBeforeMs();
    /** Misma cola de espaciado que clase C: evita TOO_EARLY/TOO_LATE al encolar Join-Accept tras un `imme` del apagador. */
    const joinQueueNotBefore =
      explicitJoinDelay > 0
        ? joinTs + explicitJoinDelay
        : scheduleClassCNotBeforeMs(ownerUserId, gatewayEuiNorm, joinTs);
    const joinTelemetryProps = {
      devEUI: devEui,
      lorawan_event: 'join_accept_sent',
      devAddr: devAddrBuf.toString('hex').toUpperCase(),
      lorawan_class: deviceClass,
      connectStatus: 'joined',
      gateway_id: gatewayEuiNorm,
      join_dl_settings: joinDlSettings,
      join_rx_delay: rxEncoded,
      join_cflist_hex: joinCfList.length ? joinCfList.toString('hex').toUpperCase() : null,
      ...radioJoin,
    };
    const deferJoinDb = joinSessionCommitDeferred();
    if (!deferJoinDb) {
      pruneSupersededDevAddrHints();
      const prevSess = store.lnsGetSessionByDevEui(ownerUserId, devEui);
      if (prevSess && prevSess.devAddr) {
        const prevAddr = String(prevSess.devAddr).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
        const nextAddr = devAddrBuf.toString('hex').toUpperCase();
        if (prevAddr.length === 8 && prevAddr !== nextAddr) {
          supersededDevAddrHint.set(micFailStreakKey(ownerUserId, prevAddr), {
            devEui,
            exp: Date.now() + 20 * 60 * 1000,
          });
        }
      }
      store.lnsUpsertSessionJoin(upsertPayload);
      saveIngestEntry(ownerUserId, {
        deviceId: telemetryDeviceId,
        deviceName: displayName,
        devEUI: devEui,
        properties: joinTelemetryProps,
        ts: joinTs,
      });
      store.lnsEnqueuePullResp(ownerUserId, gatewayEuiNorm, pullObj, joinQueueNotBefore, 255, null);
      console.log(
        '[LNS] OTAA Join-Accept encolado (sesión ya en BD; sin esperar GW_TX_ACK — predeterminado; use SYSCOM_LNS_JOIN_COMMIT_ON_TX_ACK=1 para diferir) →',
        devEui,
        devAddrBuf.toString('hex'),
        'clase',
        deviceClass
      );
    } else {
      store.lnsEnqueuePullResp(ownerUserId, gatewayEuiNorm, pullObj, joinQueueNotBefore, 255, {
        devEui,
        joinSessionCommit: {
          upsert: upsertPayload,
          telemetry: {
            deviceId: telemetryDeviceId,
            deviceName: displayName,
            properties: joinTelemetryProps,
            ts: joinTs,
          },
        },
      });
      console.log(
        '[LNS] OTAA Join-Accept encolado (sesión + telemetría tras TX_ACK del GW) →',
        devEui,
        devAddrBuf.toString('hex'),
        'clase',
        deviceClass
      );
    }
    return true;
  }

  function processDataUp(gatewayUserId, gatewayEuiNorm, p, rxpk) {
    const devAddrHex = p.DevAddr.toString('hex').toUpperCase();
    let session = store.lnsGetSessionByDevAddr(gatewayUserId, devAddrHex);
    if (!session && typeof store.lnsGetSessionByDevAddrInSuperadminPool === 'function') {
      const pool = store.lnsGetSessionByDevAddrInSuperadminPool(devAddrHex);
      if (pool) session = pool.session;
    }
    if (!session && typeof store.lnsGetSessionByDevAddrGlobal === 'function') {
      const global = store.lnsGetSessionByDevAddrGlobal(devAddrHex);
      if (global) session = global.session;
    }
    if (!session) {
      const now = Date.now();
      if (String(process.env.SYSCOM_LNS_LOG_NO_SESSION || '').trim() === '0') {
        return false;
      }
      const k = micFailStreakKey(gatewayUserId, devAddrHex);
      const hint = supersededDevAddrHint.get(k);
      const hintOk = hint && hint.exp > now && hint.devEui;
      const intervalMs = hintOk ? 60_000 : guestNoSessionLogMs();
      const prev = dataUpNoSessionLogAt.get(k) || 0;
      const anyKey = String(gatewayUserId);
      const lastAny = dataUpNoSessionAnyLogAt.get(anyKey) || 0;
      const anyMs = dataUpNoSessionAnyLogMs();
      if (now - prev > intervalMs && now - lastAny >= anyMs) {
        dataUpNoSessionLogAt.set(k, now);
        dataUpNoSessionAnyLogAt.set(anyKey, now);
        console.warn(
          '[LNS] Data up sin sesión (DevAddr',
          devAddrHex,
          ').',
          hintOk
            ? `Ese DevAddr era de ${hint.devEui} antes del último join; el nodo puede tardar unos uplinks en usar el DevAddr nuevo del Join-Accept.`
            : 'Tráfico sin sesión en esta cuenta (otro nodo / otra red / DevAddr antiguo). No indica fallo del gateway si sus dispositivos ya ingieren bien.',
          'Sin sesión no hay telemetría.',
          `(Otros DevAddr sin sesión: máx. un aviso / ${Math.round(anyMs / 1000)}s; SYSCOM_LNS_LOG_NO_SESSION=0 silencia.)`
        );
      }
      return false;
    }
    const ownerUserId = session.userId;
    const wireFcnt16 = p.getFCnt();
    let fCntMSBytes = null;
    let fcnt32 = null;
    for (const msbTry of listFcntMsbCandidatesForMic(session.fcntUp, wireFcnt16)) {
      if (lora_packet.verifyMIC(p, session.nwkSKey, undefined, msbTry)) {
        fCntMSBytes = msbTry;
        fcnt32 = fcnt32FromMsbAndWireLo(msbTry, wireFcnt16);
        const primary = resolveFcnt32ForMic(session.fcntUp, wireFcnt16);
        if (msbTry.toString('hex') !== primary.fCntMSBytes.toString('hex')) {
          console.log(
            '[LNS] MIC OK tras resync FCnt MSB (DevAddr',
            devAddrHex,
            'wireFCnt',
            wireFcnt16,
            '→ fcnt32',
            fcnt32,
            ')'
          );
        }
        break;
      }
    }
    if (!fCntMSBytes) {
      const mk = micFailStreakKey(ownerUserId, devAddrHex);
      const now = Date.now();
      const micLogMs = micDataInvalidLogMs();
      const lastMic = micDataInvalidLogAt.get(mk) || 0;
      if (now - lastMic >= micLogMs) {
        micDataInvalidLogAt.set(mk, now);
        console.warn(
          `[LNS] MIC datos inválido DevAddr ${devAddrHex} dev_eui ${session.devEui} wireFCnt ${wireFcnt16} ` +
            '(las claves NwkSKey de esta cuenta no verifican esta trama). Causas frecuentes: ' +
            '(1) Milesight ToolBox en LoRaWAN 1.1 — este LNS solo calcula MIC de datos como 1.0.x; use 1.0.2 o 1.0.3 en el WS101. ' +
            '(2) Misma DevAddr en aire por otra red (paquete ajeno). ' +
            '(3) Sesión desfasada: «Reiniciar sesión LoRaWAN» + join limpio y AppKey/JoinEUI iguales en app y en el nodo. ' +
            'La sesión no se borra sola. Log cada ~' +
            `${Math.round(micLogMs / 1000)} s (SYSCOM_LNS_MIC_FAIL_LOG_MS).`
        );
      }
      recordMicFailureAndMaybePurgeSession(ownerUserId, devAddrHex, session.devEui);
      return false;
    }
    clearMicFailStreak(ownerUserId, devAddrHex);

    if (session.fcntUp >= 0) {
      const prev = session.fcntUp >>> 0;
      if (fcnt32 < prev) {
        console.warn('[LNS] FCnt retrocede, se ignora', prev, '→', fcnt32);
        return false;
      }
    }

    let plain = Buffer.alloc(0);
    try {
      const port = p.getFPort();
      if (port != null && (port > 0 || p.FRMPayload.length > 0)) {
        plain = lora_packet.decrypt(p, session.appSKey, session.nwkSKey, fCntMSBytes) || Buffer.alloc(0);
      }
    } catch (e) {
      console.warn('[LNS] decrypt:', e.message);
      return false;
    }

    const fPort = p.getFPort();
    if (fPort === 0 && plain.length >= 5) {
      const ps = tryParsePingSlotInfoAns(plain);
      if (ps) {
        store.lnsPatchClassBFromMac(ownerUserId, session.devEui, ps.periodicity, ps.dr);
        console.log('[LNS] PingSlotInfoAns → periodicity=', ps.periodicity, 'dr=', ps.dr, 'dev=', session.devEui);
      }
    }

    if (session.fcntUp >= 0) {
      const prev = session.fcntUp >>> 0;
      if (fcnt32 === prev) {
        console.warn('[LNS] Duplicado FCnt (reemisión); se actualiza actividad y telemetría', fcnt32);
      } else {
        const delta = fcnt32 - prev;
        if (delta > 16384) {
          console.warn('[LNS] FCnt sospechoso (salto grande), se acepta igual:', prev, '→', fcnt32);
        }
      }
    }

    const devEui = session.devEui;
    const ud =
      store.getUserDevice(ownerUserId, devEui) ||
      store.getUserDeviceByDevEuiNorm(ownerUserId, devEui) ||
      store.listUserDevices(ownerUserId).find((d) => d.devEUI === devEui);
    const telemetryDeviceId = ud && ud.deviceId ? ud.deviceId : devEui;
    const displayName = ud ? ud.displayName : devEui;

    session.fcntUp = fcnt32;
    session.lastGatewayEui = gatewayEuiNorm;
    session.lastRxTmst = rxpk.tmst != null ? Number(rxpk.tmst) : null;
    session.lastRxFreq = rxpk.freq != null ? Number(rxpk.freq) : null;
    session.lastRxDatr = rxpk.datr != null ? String(rxpk.datr) : '';
    session.lastRxCodr = rxpk.codr != null ? String(rxpk.codr) : '';
    session.lastRxRfch = rxpk.rfch != null ? Number(rxpk.rfch) : null;
    session.lastUplinkWallMs = Date.now();
    const uplinkConfirmed = p.isConfirmed() && p.getDir() === 'up';
    session.pendingMacAck = uplinkConfirmed || session.pendingMacAck;

    const hadAwaitingDlAck = session.awaitingConfirmedDlAck === true;
    const macAckForDownlink = p.getDir() === 'up' && Boolean(p.getFCtrlACK());
    if (macAckForDownlink && hadAwaitingDlAck) {
      store.lnsClearAwaitingConfirmedDeviceAck(ownerUserId, devEui);
      insertUiEvent(
        ownerUserId,
        devEui,
        'downlink_device_acked',
        JSON.stringify({ fCntUplink: fcnt32, devAddr: devAddrHex })
      );
    }

    store.lnsUpdateSessionAfterUplink(devEui, session);

    const radioUp = radioMetaFromRxpk(rxpk);
    /** No expandir `session` aquí: incluye NwkSKey/AppSKey (Buffer) y userId; al JSON.parse en BD aparecen como `appSKey.data` y todas las cuentas veían las mismas claves en selectores. */
    saveIngestEntry(ownerUserId, {
      deviceId: telemetryDeviceId,
      deviceName: displayName,
      devEUI: devEui,
      properties: {
        devEUI: devEui,
        devAddr: devAddrHex,
        fCnt: fcnt32,
        fcntUp: session.fcntUp,
        fcntDown: session.fcntDown,
        fPort: p.getFPort(),
        payload_hex: plain.toString('hex').toUpperCase(),
        gateway_id: gatewayEuiNorm,
        deviceClass: session.deviceClass,
        lastUplinkWallMs: session.lastUplinkWallMs,
        lastRxTmst: session.lastRxTmst,
        lastRxFreq: session.lastRxFreq,
        lastRxDatr: session.lastRxDatr,
        lastRxCodr: session.lastRxCodr,
        lastRxRfch: session.lastRxRfch,
        classBPingPeriodicity: session.classBPingPeriodicity,
        classBDataRate: session.classBDataRate,
        rxDelaySec: session.rxDelaySec,
        pendingMacAck: session.pendingMacAck,
        awaitingConfirmedDlAck: session.awaitingConfirmedDlAck,
        ...radioUp,
        connectStatus: 'online',
        /** No copiar `session.deviceClass`: fija «A» y tapa `lorawan_class` del decoder Milesight (p. ej. «Class C»). */
        last_update: Date.now(),
      },
    });

    let linkCheckQueuedOk = false;
    if (linkCheckAnsToDeviceEnabled() && otaaUplinkHasLinkCheckReq(p, fPort, plain)) {
      try {
        const margin = Math.max(0, Math.min(254, envInt('SYSCOM_LNS_LINK_CHECK_ANS_MARGIN', 10)));
        const gwcnt = Math.max(0, Math.min(255, envInt('SYSCOM_LNS_LINK_CHECK_ANS_GW_CNT', 1)));
        /** LinkCheckAns (CID 0x03) en FRMPayload con FPort 0; cifrado con NwkSKey en `enqueueAppDownlink`. */
        enqueueAppDownlink(ownerUserId, devEui, 0, Buffer.from([0x03, margin, gwcnt]), {
          priority: 10,
          skipTxAckTrack: true,
        });
        linkCheckQueuedOk = true;
        console.log('[LNS] LinkCheckAns encolado →', devEui, 'margin=', margin, 'GwCnt=', gwcnt);
      } catch (e) {
        console.warn('[LNS] LinkCheckAns no encolado:', e && e.message ? e.message : e);
      }
    }

    tryFlushOneDeferredAppDownlinkAfterUplink(ownerUserId, devEui, linkCheckQueuedOk);

    return true;
  }

  /**
   * Tras un uplink, intenta un downlink de aplicación que quedó en cola diferida (clase A / sin tmst, etc.).
   * No compite con LinkCheckAns en el mismo ciclo (solo una ventana RX típica).
   */
  function tryFlushOneDeferredAppDownlinkAfterUplink(userId, devEui, skipBecauseLinkCheckQueued) {
    if (skipBecauseLinkCheckQueued) return;
    if (typeof store.lnsPeekOldestDeferredAppDownlink !== 'function') return;
    const row = store.lnsPeekOldestDeferredAppDownlink(userId, devEui);
    if (!row) return;
    let buf;
    try {
      buf = Buffer.from(row.payloadHex, 'hex');
    } catch {
      store.lnsDeleteDeferredAppDownlinkById(row.id);
      console.warn('[LNS] deferred app downlink: hex inválido, descartado id=', row.id);
      return;
    }
    if (!buf.length) {
      store.lnsDeleteDeferredAppDownlinkById(row.id);
      return;
    }
    try {
      enqueueAppDownlink(userId, devEui, row.fPort, buf, {
        confirmed: row.confirmed,
        delayMs: row.delayMs,
        priority: row.priority,
        deviceClass: row.deviceClass,
        gatewayEui: row.gatewayEui && row.gatewayEui.length === 16 ? row.gatewayEui : undefined,
        skipTxAckTrack: false,
      });
      store.lnsDeleteDeferredAppDownlinkById(row.id);
      console.log('[LNS] Downlink diferido enviado tras uplink →', devEui, 'fPort', row.fPort, 'cola id', row.id);
      try {
        insertUiEvent(
          userId,
          devEui,
          'downlink_deferred_flushed',
          JSON.stringify({
            fPort: row.fPort,
            payloadHex: row.payloadHex,
            deferredQueueId: row.id,
          })
        );
      } catch (e2) {
        console.warn('[LNS] UI event deferred flush:', e2.message);
      }
    } catch (e) {
      const c = e && e.code ? String(e.code) : '';
      if (
        c === 'DOWNLINK_IN_FLIGHT' ||
        c === 'CLASS_A_RX_WINDOW_CLOSED' ||
        c === 'CLASS_A_MISSING_GATEWAY_TMST' ||
        c === 'NO_GATEWAY'
      ) {
        return;
      }
      console.warn('[LNS] deferred flush falló, se conserva en cola:', e.message, c, 'id=', row.id);
    }
  }

  function processRxpk(userId, gatewayEuiNorm, rxpk) {
    if (!rxpk || !rxpk.data) return false;
    let pkt;
    try {
      pkt = lora_packet.fromWire(Buffer.from(rxpk.data, 'base64'));
    } catch (e) {
      return false;
    }

    if (pkt.isJoinRequestMessage()) {
      return processJoin(userId, gatewayEuiNorm, pkt, rxpk);
    }

    if (pkt.isDataMessage() && pkt.getDir() === 'up') {
      return processDataUp(userId, gatewayEuiNorm, pkt, rxpk);
    }

    return false;
  }

  function processPushJson(userId, gatewayMac8, jsonObj) {
    /** Misma normalización que la cola PULL_RESP: EUI del alta del usuario o, si no hay fila, MAC8 del wire. */
    const gatewayEuiNorm = String(
      store.getLorawanGatewayEuiNormForUser(userId, gatewayMac8) || gatewayMac8.toString('hex').toLowerCase()
    )
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();

    if (jsonObj && jsonObj.txpk_ack && typeof jsonObj.txpk_ack === 'object') {
      console.warn(
        '[LNS] PUSH_DATA contiene `txpk_ack` (no estándar GWMP). El UG65 envía ACK en **GW_TX_ACK** (UDP 0x05), no dentro del JSON de PUSH. Ignorado:',
        JSON.stringify(jsonObj.txpk_ack)
      );
    }

    const list = Array.isArray(jsonObj.rxpk) ? jsonObj.rxpk : [];
    let any = false;
    for (const rxpk of list) {
      if (processRxpk(userId, gatewayEuiNorm, rxpk)) any = true;
    }

    if (!any) {
      runLegacyUplink(userId, jsonObj);
      return false;
    }

    const legacyBody = { ...jsonObj };
    if (legacyBody.rxpk) {
      legacyBody.rxpk = legacyBody.rxpk.filter((pk) => {
        try {
          const p = lora_packet.fromWire(Buffer.from(pk.data, 'base64'));
          return !(p.isJoinRequestMessage() || (p.isDataMessage() && p.getDir() === 'up'));
        } catch {
          return true;
        }
      });
      if (legacyBody.rxpk.length === 0) delete legacyBody.rxpk;
    }

    if (legacyBody.stat || (legacyBody.rxpk && legacyBody.rxpk.length)) {
      runLegacyUplink(userId, legacyBody);
    }
    return true;
  }

  /**
   * Alinea el EUI guardado en sesión con el de `lorawan_gateways` del usuario (16 hex),
   * para que la cola `lorawan_lns_downlink.gateway_eui` coincida con `lnsDequeuePullResp` tras PULL_DATA.
   */
  function resolveQueueGatewayEui(userId, gatewayEui16Raw) {
    const s = String(gatewayEui16Raw || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (s.length !== 16) return s;
    try {
      const mac = Buffer.from(s, 'hex');
      if (mac.length !== 8) return s;
      const userGw = store.getLorawanGatewayEuiNormForUser(userId, mac);
      return userGw ? String(userGw).replace(/[^0-9a-fA-F]/g, '').toLowerCase() : s;
    } catch {
      return s;
    }
  }

  /**
   * @param {{ delayMs?: number, confirmed?: boolean, priority?: number, skipTxAckTrack?: boolean, deviceClass?: string, gatewayEui?: string }} [opts]
   */
  function enqueueAppDownlink(userId, devEuiNorm16, fPort, payloadBuf, opts) {
    const opt = opts || {};
    const session = store.lnsGetSessionByDevEui(userId, devEuiNorm16);
    if (!session) {
      const err = new Error('Dispositivo sin sesión LoRaWAN (haga OTAA primero)');
      err.code = 'NO_SESSION';
      throw err;
    }
    const gwOverride =
      opt.gatewayEui != null && String(opt.gatewayEui).trim() !== ''
        ? String(opt.gatewayEui)
            .replace(/[^0-9a-fA-F]/g, '')
            .toLowerCase()
        : '';
    let gwRaw = gwOverride || session.lastGatewayEui;
    if (!gwRaw) {
      const err = new Error('Sin gateway visto aún para downlink');
      err.code = 'NO_GATEWAY';
      throw err;
    }
    const gatewayQueueEui = resolveQueueGatewayEui(userId, gwRaw);
    if (gwOverride && gatewayQueueEui.length === 16) {
      try {
        store.lnsPatchSessionLastGateway(userId, devEuiNorm16, gatewayQueueEui);
      } catch {
        /* ignore */
      }
    }

    try {
      if (typeof store.lnsPruneStaleAppDownlinkTxAckInflight === 'function') {
        store.lnsPruneStaleAppDownlinkTxAckInflight();
      }
    } catch (e) {
      console.warn('[LNS] prune TX_ACK silencioso:', e.message);
    }
    const pruned = store.lnsPruneAbandonedTrackedAppDownlinksForDev(userId, devEuiNorm16);
    if (pruned > 0) {
      console.log('[LNS] Cola downlink app obsoleta eliminada:', pruned, 'dev_eui', devEuiNorm16);
    }

    const gwRow = store.lnsGetGatewayByEui(userId, gatewayQueueEui);
    const gwBand = gwRow ? String(gwRow.frequencyBand || '').trim() : '';

    const cls = normalizeDeviceClass(
      opt.deviceClass != null && String(opt.deviceClass).trim() !== '' ? opt.deviceClass : session.deviceClass
    );
    const nextDown = session.fcntDown < 0 ? 0 : (session.fcntDown + 1) % 65536;
    const skipTrack = Boolean(opt.skipTxAckTrack);
    const useTrack =
      !skipTrack && txAckTrackingEnabled() && appDownlinkTxAckWanted(cls);
    if (useTrack && store.lnsHasTrackedDownlinkPendingForDev(userId, devEuiNorm16)) {
      const err = new Error(
        'Downlink anterior pendiente de confirmación del gateway; inténtelo de nuevo en unos segundos.'
      );
      err.code = 'DOWNLINK_IN_FLIGHT';
      throw err;
    }
    const macAck = Boolean(session.pendingMacAck);
    const mType = opt.confirmed ? 'Confirmed Data Down' : 'Unconfirmed Data Down';
    const down = lora_packet.fromFields(
      {
        MType: mType,
        DevAddr: Buffer.from(session.devAddr, 'hex'),
        FCtrl: { ADR: false, ACK: macAck, FPending: false },
        FCnt: nextDown,
        FPort: fPort,
        payload: payloadBuf,
      },
      session.appSKey,
      session.nwkSKey,
      null
    );
    const phy = down.getPHYPayload();
    if (!useTrack) {
      store.lnsSetFcntDown(userId, devEuiNorm16, nextDown);
      if (opt.confirmed) {
        store.lnsMarkAwaitingConfirmedDeviceAck(userId, devEuiNorm16);
      }
    }

    const gwBandU = gwBand.toUpperCase();
    const r2Stub = rx2Defaults(isUs915Plan({ band: gwBandU }, null));
    const rxpkStub = {
      tmst: session.lastRxTmst || 0,
      freq: session.lastRxFreq || r2Stub.freq,
      datr: session.lastRxDatr || r2Stub.datr,
      codr: session.lastRxCodr || '4/5',
      rfch: session.lastRxRfch != null ? session.lastRxRfch : 0,
    };

    const rxDelaySec = session.rxDelaySec != null ? session.rxDelaySec : 1;
    let useImme = false;
    let notBeforeMs = 0;
    let classAWindow = 'RX1';

    if (cls === 'C') {
      useImme = true;
      const extraDelay =
        opt.delayMs != null && Number.isFinite(Number(opt.delayMs)) ? Math.max(0, Number(opt.delayMs)) : 0;
      notBeforeMs = scheduleClassCNotBeforeMs(userId, gatewayQueueEui, Date.now() + extraDelay);
    } else if (cls === 'B') {
      useImme = false;
      const strictB = String(process.env.SYSCOM_LNS_CLASS_B_STRICT_PING || '').trim() === '1';
      const pB = session.classBPingPeriodicity;
      if (strictB && (pB == null || pB < 0 || pB > 7)) {
        const err = new Error(
          'Downlink clase B: periodicidad de ping desconocida (falta PingSlotInfoAns en uplink MAC). ' +
            'Espere a que el dispositivo envíe PingSlotInfoAns o use SYSCOM_LNS_CLASS_B_STRICT_PING=0 para programación heurística.'
        );
        err.code = 'CLASS_B_PING_SLOT_UNKNOWN';
        throw err;
      }
      if (opt.delayMs != null && Number.isFinite(Number(opt.delayMs))) {
        notBeforeMs = Date.now() + Math.max(0, Number(opt.delayMs));
      } else {
        notBeforeMs = estimateClassBNotBeforeMs(session);
      }
      const tmstB =
        session.lastRxTmst != null &&
        Number.isFinite(Number(session.lastRxTmst)) &&
        Number(session.lastRxTmst) > 0;
      if (!tmstB) {
        const err = new Error(
          'Downlink clase B: hace falta un uplink reciente con `rxpk.tmst` del gateway para programar el `txpk`.'
        );
        err.code = 'CLASS_B_MISSING_GATEWAY_TMST';
        throw err;
      }
    } else {
      useImme = false;
      const lastUplinkWall = session.lastUplinkWallMs;
      const now = Date.now();
      const rx1Micros = classARx1DelayUs(rxDelaySec);
      const maxAgeMs = Math.ceil(rx1Micros / 1000) + 2000;
      if (lastUplinkWall == null || now - lastUplinkWall > maxAgeMs) {
        const err = new Error(
          'Downlink clase A: no hay uplink reciente. El dispositivo solo recibe justo después de enviar datos. ' +
            'Espere telemetría y reintente en los primeros segundos, o configure el dispositivo como clase C en la plantilla.'
        );
        err.code = 'CLASS_A_RX_WINDOW_CLOSED';
        throw err;
      }
      const tmstOk =
        session.lastRxTmst != null &&
        Number.isFinite(Number(session.lastRxTmst)) &&
        Number(session.lastRxTmst) > 0;
      if (!tmstOk) {
        const err = new Error(
          'Downlink clase A: el gateway no aportó `tmst` en el último uplink; no se puede programar RX1/RX2 (no se usa `imme`). ' +
            'Compruebe el packet forwarder Semtech y que `rxpk.tmst` llegue en PUSH_DATA.'
        );
        err.code = 'CLASS_A_MISSING_GATEWAY_TMST';
        throw err;
      }
      classAWindow = classARxWindowMode();
    }

    const classCScheduledTmst = cls === 'C' && classCUseGatewayTmst();
    if (classCScheduledTmst && !(session.lastRxTmst > 0)) {
      console.warn(
        '[LNS] SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1 pero sin tmst de uplink en sesión; se usa imme para clase C. Tras un uplink con tmst válido se programará por tmst.'
      );
    }

    const pullObj = buildTxpk(phy, rxpkStub, {
      imme: useImme,
      classCScheduledTmst: classCScheduledTmst && session.lastRxTmst > 0,
      rxDelaySec,
      classAWindow: cls === 'A' && !useImme ? classAWindow : 'RX1',
      band: gwBandU,
    });
    try {
      const tx = pullObj && pullObj.txpk;
      if (tx && String(process.env.SYSCOM_LNS_LOG_DOWNLINK_SCHEDULE || '').trim() === '1') {
        console.log('[LNS] txpk programado', {
          devEui: devEuiNorm16,
          deviceClass: cls,
          imme: Boolean(tx.imme),
          tmst: tx.tmst != null ? tx.tmst : null,
          rxDelaySec,
          classARxWindow: cls === 'A' && !useImme ? classAWindow : null,
          lastRxTmst: session.lastRxTmst,
          freq: tx.freq,
          rfch: tx.rfch,
          datr: tx.datr,
        });
      }
    } catch {
      /* ignore log */
    }
    const dlPriority = opt.priority != null ? Number(opt.priority) : 0;
    if (useTrack) {
      store.lnsEnqueuePullResp(userId, gatewayQueueEui, pullObj, notBeforeMs, dlPriority, {
        devEui: devEuiNorm16,
        newFcnt: nextDown,
        prevFcnt: session.fcntDown,
        confirmedDown: Boolean(opt.confirmed),
      });
      storePendingDownlink(userId, gatewayQueueEui, devEuiNorm16, nextDown, getTxAckTimeoutMs());
    } else {
      store.lnsEnqueuePullResp(userId, gatewayQueueEui, pullObj, notBeforeMs, dlPriority);
    }

    if (macAck) {
      store.lnsClearPendingMacAck(userId, devEuiNorm16);
    }

    return {
      ok: true,
      fPort,
      fCnt: nextDown,
      imme: useImme,
      deviceClass: cls,
      gatewayEui: gatewayQueueEui,
      notBeforeMs,
      confirmedDown: Boolean(opt.confirmed),
      macAckIncluded: macAck,
      classARxWindow: cls === 'A' && !useImme ? classAWindow : null,
      priority: dlPriority,
      txAckPending: useTrack,
    };
  }

  return { processPushJson, enqueueAppDownlink, processRxpk, normalizeDeviceClass, handleTxAck };
}

module.exports = { createLorawanLnsEngine };
