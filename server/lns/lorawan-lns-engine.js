'use strict';

const crypto = require('crypto');
const lora_packet = require('lora-packet');
const { deriveSessionKeys10x, parseKeyHex32 } = require('./lorawan-lns-crypto');
const { rx2DefaultsFromEnvAndPlan, warnUplinkFreqMismatchedPlan } = require('./lorawan-regional-plan');
const { buildUs915Fsb2JoinCFList } = require('./us915-fsb2-join-cflist');

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/**
 * Retardo RX1 en µs respecto al `tmst` del último uplink.
 * - Si `SYSCOM_LNS_RX1_DELAY_US` está definida (p. ej. `5000000`), **anula** el cálculo por RxDelay de sesión.
 * - Si no, usa **rx_delay_sec de sesión** (1–15 s, típico **5** en US915 tras Join-Accept) × 1e6 µs.
 */
function classARx1DelayUs(rxDelaySec) {
  if (process.env.SYSCOM_LNS_RX1_DELAY_US != null && String(process.env.SYSCOM_LNS_RX1_DELAY_US).trim() !== '') {
    return envInt('SYSCOM_LNS_RX1_DELAY_US', 5_000_000);
  }
  const s = rxDelaySec != null ? Math.max(1, Math.min(15, Number(rxDelaySec))) : 5;
  return s * 1_000_000;
}

function classARxWindowMode() {
  const m = String(process.env.SYSCOM_LNS_CLASS_A_RX_WINDOW || 'RX1')
    .trim()
    .toUpperCase();
  if (m === 'RX2' || m === 'SCHED_RX2' || m === 'WINDOW2') return 'RX2';
  return 'RX1';
}

/**
 * @param {string} name
 * @param {boolean | null} whenUnset null = variable no definida
 */
function parseOptionalEnvBool(name, whenUnset) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return whenUnset;
  const s = String(raw).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  return whenUnset;
}

/**
 * Downlinks de aplicación: si es false, FCnt al encolar; si true, solo tras GW_TX_ACK.
 * Por defecto false (p. ej. Milesight UG65 sin `txpk_ack` fiable por UDP).
 * Precedencia: `SYSCOM_LNS_APP_DOWNLINK_TX_ACK` → `SYSCOM_LNS_TX_ACK_ENABLED` → `SYSCOM_LNS_TX_ACK` (legado).
 */
function appDownlinkTxAckTrackingEnabled() {
  const app = parseOptionalEnvBool('SYSCOM_LNS_APP_DOWNLINK_TX_ACK', null);
  if (app !== null) return app;
  const gen = parseOptionalEnvBool('SYSCOM_LNS_TX_ACK_ENABLED', null);
  if (gen !== null) return gen;
  return parseOptionalEnvBool('SYSCOM_LNS_TX_ACK', false);
}

/** @deprecated Use appDownlinkTxAckTrackingEnabled; alias para el mismo criterio. */
function txAckTrackingEnabled() {
  return appDownlinkTxAckTrackingEnabled();
}

function txPower() {
  return envInt('SYSCOM_LNS_TX_POWER', 14);
}

function netIdBuf() {
  const hex = String(process.env.SYSCOM_LNS_NET_ID || '000001').replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return Buffer.from('000001', 'hex');
  return Buffer.from(hex, 'hex');
}

function rx2Defaults() {
  const o = rx2DefaultsFromEnvAndPlan();
  return { freq: o.freq, datr: o.datr, codr: o.codr };
}

function normalizeDeviceClass(v) {
  const u = String(v || 'A')
    .trim()
    .toUpperCase();
  return u === 'B' || u === 'C' ? u : 'A';
}

/**
 * Clase efectiva: primero `device_decode_config` (plantilla aplicada), luego `user_devices`, luego sesión LNS.
 * @param {{ findUserDeviceByDevEuiNorm?: Function, getDeviceDecodeConfig?: Function, lnsSyncSessionDeviceClass?: Function }} store
 */
function resolveLnsDeviceClassFromDecodeConfigThenUserDevice(store, userId, devEuiNorm16, session) {
  if (!session) return 'A';
  if (
    typeof store.findUserDeviceByDevEuiNorm !== 'function' ||
    typeof store.getDeviceDecodeConfig !== 'function'
  ) {
    return normalizeDeviceClass(session.deviceClass);
  }
  const ud = store.findUserDeviceByDevEuiNorm(userId, devEuiNorm16);
  const deviceId = ud ? String(ud.deviceId || '').trim() : String(devEuiNorm16 || '').trim();
  const cfg = deviceId ? store.getDeviceDecodeConfig(deviceId) : { lorawanClass: '' };
  const decRaw = String(cfg.lorawanClass || '').trim();
  let profileCls;
  if (decRaw) {
    profileCls = normalizeDeviceClass(decRaw);
  } else {
    const rawUd = ud && String(ud.lorawanClass || '').trim();
    if (rawUd) profileCls = normalizeDeviceClass(ud.lorawanClass);
    else profileCls = normalizeDeviceClass(session.deviceClass);
  }
  const sessionCls = normalizeDeviceClass(session.deviceClass);
  if (profileCls !== sessionCls && typeof store.lnsSyncSessionDeviceClass === 'function') {
    store.lnsSyncSessionDeviceClass(userId, devEuiNorm16, profileCls);
  }
  session.deviceClass = profileCls;
  return profileCls;
}

/**
 * @param {Buffer} phy
 * @param {{ tmst?: number, freq?: number, datr?: string, codr?: string, rfch?: number }} rxpk
 * @param {{ imme?: boolean, rxDelaySec?: number, classAWindow?: 'RX1'|'RX2' }} [opts]
 */
function immeTxRfch(rxpk) {
  if (
    process.env.SYSCOM_LNS_TX_RFCH_IMME_US915 != null &&
    String(process.env.SYSCOM_LNS_TX_RFCH_IMME_US915).trim() !== ''
  ) {
    return envInt('SYSCOM_LNS_TX_RFCH_IMME_US915', 0);
  }
  return rxpk && rxpk.rfch != null ? Number(rxpk.rfch) : 0;
}

function buildTxpk(phy, rxpk, opts) {
  const useImme = opts && opts.imme;
  const rxDelaySec =
    opts && opts.rxDelaySec != null ? Math.max(1, Math.min(15, Number(opts.rxDelaySec))) : null;
  const classAWindow = (opts && opts.classAWindow) || 'RX1';
  const r2 = rx2Defaults();
  const base = {
    imme: Boolean(useImme),
    rfch: useImme ? immeTxRfch(rxpk) : rxpk && rxpk.rfch != null ? Number(rxpk.rfch) : 0,
    powe: txPower(),
    modu: 'LORA',
    ipol: true,
    size: phy.length,
    data: phy.toString('base64'),
  };
  if (useImme) {
    base.freq = r2.freq;
    base.datr = r2.datr;
    base.codr = r2.codr;
  } else if (classAWindow === 'RX2') {
    const afterRx1 = envInt('SYSCOM_LNS_RX2_AFTER_RX1_SEC', 1);
    const secOffset = (rxDelaySec != null ? rxDelaySec : 1) + afterRx1;
    base.tmst = Number(rxpk.tmst) + secOffset * 1000000;
    base.freq = r2.freq;
    base.datr = r2.datr;
    base.codr = r2.codr;
  } else {
    base.tmst = Number(rxpk.tmst) + classARx1DelayUs(rxDelaySec);
    base.freq = Number(rxpk.freq);
    base.datr = String(rxpk.datr || r2.datr);
    base.codr = String(rxpk.codr || '4/5');
  }
  return { txpk: base };
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

/** Plan regional US915; en BD debe ser `US902-928-FSB2` (FSB2: 125 kHz 8–15 + 500 kHz 65–70). */
function isUs915RegionalBand(frequencyBand) {
  const s = String(frequencyBand || '')
    .trim()
    .toUpperCase();
  if (!s) return false;
  if (s.includes('AU915') || s.includes('EU868')) return false;
  return s.includes('US915') || s.includes('US902');
}

/**
 * Métricas de radio Semtech `rxpk` para ingest / telemetría.
 * @param {{ rssi?: number, lsnr?: number, freq?: number, datr?: string }} rxpk
 */
function buildRadioMetaFromRxpk(rxpk) {
  if (!rxpk || typeof rxpk !== 'object') return {};
  const meta = {};
  if (rxpk.rssi != null && Number.isFinite(Number(rxpk.rssi))) meta.rssi = Number(rxpk.rssi);
  if (rxpk.lsnr != null && Number.isFinite(Number(rxpk.lsnr))) meta.snr = Number(rxpk.lsnr);
  if (rxpk.freq != null && Number.isFinite(Number(rxpk.freq))) meta.freq = Number(rxpk.freq);
  const dr = rxpk.datr != null ? String(rxpk.datr).trim() : '';
  if (dr) {
    meta.datarate = dr;
    meta.dr = dr;
  }
  return meta;
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
  /** Fin del slot reservado por downlink clase C (ms epoch), por gateway, para `SYSCOM_LNS_CLASS_C_TX_GAP_MS`. */
  const lastClassCDlEndByGw = Object.create(null);
  const insertUiEvent =
    typeof ctx.insertUiEvent === 'function'
      ? ctx.insertUiEvent
      : (uid, deui, type, meta) => store.lnsInsertUiEvent(uid, deui, type, meta);

  function processJoin(userId, gatewayEuiNorm, p, rxpk) {
    warnUplinkFreqMismatchedPlan(rxpk);
    const joinEui = buf8ToHex16(p.AppEUI);
    const devEui = buf8ToHex16(p.DevEUI);
    const row = store.lnsFindOtaaDeviceRow(userId, joinEui, devEui);
    if (!row) {
      console.warn('[LNS] Join sin dispositivo OTAA en app (devEUI/appEUI/appKey):', devEui, joinEui);
      return false;
    }
    const appKeyBuf = parseKeyHex32(row.app_key);
    if (!appKeyBuf || !lora_packet.verifyMIC(p, undefined, appKeyBuf)) {
      console.warn('[LNS] Join Request MIC inválido o AppKey incorrecto');
      return false;
    }

    let devAddrBuf;
    try {
      devAddrBuf = store.lnsAllocateDevAddrBuf(userId);
    } catch (e) {
      console.error('[LNS]', e.message);
      return false;
    }
    const appNonce = crypto.randomBytes(3);
    const nid = netIdBuf();
    const { nwkSKey, appSKey } = deriveSessionKeys10x(appKeyBuf, appNonce, nid, p.DevNonce);

    /** Por defecto 5 s (US915 / Join-Accept típico); override con `SYSCOM_LNS_RX_DELAY_SEC`. */
    const secUser = envInt('SYSCOM_LNS_RX_DELAY_SEC', 5);
    const rxEncoded = secUser <= 0 ? 0 : Math.min(15, secUser);
    const rxDelaySec = rxEncoded === 0 ? 1 : rxEncoded;

    const ja = lora_packet.fromFields(
      {
        MType: 'Join Accept',
        AppNonce: appNonce,
        NetID: nid,
        DevAddr: devAddrBuf,
        DLSettings: 0,
        RxDelay: rxEncoded,
        CFList: buildUs915Fsb2JoinCFList(),
      },
      null,
      null,
      appKeyBuf
    );
    const phy = ja.getPHYPayload();

    const didJoin = String(row.device_id || '').trim();
    const cfgJoin = didJoin ? store.getDeviceDecodeConfig(didJoin) : { lorawanClass: '' };
    const decJoin = String(cfgJoin.lorawanClass || '').trim();
    const deviceClass = decJoin
      ? normalizeDeviceClass(decJoin)
      : normalizeDeviceClass(row.lorawan_class || row.lorawanClass);

    store.lnsUpsertSessionJoin({
      userId,
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
    });

    const pullObj = buildTxpk(phy, rxpk, { imme: false, rxDelaySec });

    const gwRow = typeof store.lnsGetGatewayByEui === 'function' ? store.lnsGetGatewayByEui(userId, gatewayEuiNorm) : null;
    const us915JoinDelayMs = gwRow && isUs915RegionalBand(gwRow.frequencyBand) ? 5000 : 0;
    const joinNotBeforeMs = us915JoinDelayMs > 0 ? Date.now() + us915JoinDelayMs : 0;
    store.lnsEnqueuePullResp(userId, gatewayEuiNorm, pullObj, joinNotBeforeMs, 255);

    const radioMeta = buildRadioMetaFromRxpk(rxpk);
    saveIngestEntry(userId, {
      deviceId: devEui,
      deviceName: row.display_name || devEui,
      devEUI: devEui,
      properties: {
        devEUI: devEui,
        lorawan_event: 'join_accept_queued',
        devAddr: devAddrBuf.toString('hex').toUpperCase(),
        lorawan_class: deviceClass,
        connectStatus: 'joined',
        gateway_id: gatewayEuiNorm,
        frequency_band: gwRow ? gwRow.frequencyBand : undefined,
        us915_join_delay_ms: us915JoinDelayMs || undefined,
        ...radioMeta,
      },
    });
    if (us915JoinDelayMs > 0) {
      console.log(
        '[LNS] OTAA Join-Accept encolado (US915: retardo',
        us915JoinDelayMs,
        'ms) →',
        devEui,
        devAddrBuf.toString('hex')
      );
    } else {
      console.log('[LNS] OTAA Join-Accept encolado →', devEui, devAddrBuf.toString('hex'), 'clase', deviceClass);
    }
    return true;
  }

  function processDataUp(userId, gatewayEuiNorm, p, rxpk) {
    warnUplinkFreqMismatchedPlan(rxpk);
    const devAddrHex = p.DevAddr.toString('hex').toUpperCase();
    const session = store.lnsGetSessionByDevAddr(userId, devAddrHex);
    if (!session) return false;
    const devEuiNorm = String(session.devEui || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (devEuiNorm.length === 16) {
      resolveLnsDeviceClassFromDecodeConfigThenUserDevice(store, userId, devEuiNorm, session);
    }
    if (!lora_packet.verifyMIC(p, session.nwkSKey, undefined)) {
      console.warn('[LNS] MIC datos inválido DevAddr', devAddrHex);
      return false;
    }
    const fcnt = p.getFCnt();
    if (session.fcntUp >= 0) {
      const delta = (fcnt - session.fcntUp + 65536) % 65536;
      if (delta === 0) {
        console.warn('[LNS] Duplicado FCnt', fcnt);
        return true;
      }
      if (delta > 16384) {
        console.warn('[LNS] FCnt sospechoso (salto grande), se acepta igual:', session.fcntUp, '→', fcnt);
      }
    }

    let plain = Buffer.alloc(0);
    try {
      const port = p.getFPort();
      if (port != null && (port > 0 || p.FRMPayload.length > 0)) {
        plain = lora_packet.decrypt(p, session.appSKey, session.nwkSKey) || Buffer.alloc(0);
      }
    } catch (e) {
      console.warn('[LNS] decrypt:', e.message);
      return false;
    }

    const fPort = p.getFPort();
    if (fPort === 0 && plain.length >= 5) {
      const ps = tryParsePingSlotInfoAns(plain);
      if (ps) {
        store.lnsPatchClassBFromMac(userId, session.devEui, ps.periodicity, ps.dr);
        console.log('[LNS] PingSlotInfoAns → periodicity=', ps.periodicity, 'dr=', ps.dr, 'dev=', session.devEui);
      }
    }

    const devEui = session.devEui;
    const ud = store.getUserDevice(userId, devEui) || store.listUserDevices(userId).find((d) => d.devEUI === devEui);
    const displayName = ud ? ud.displayName : devEui;

    session.fcntUp = fcnt;
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
      store.lnsClearAwaitingConfirmedDeviceAck(userId, devEui);
      insertUiEvent(
        userId,
        devEui,
        'downlink_device_acked',
        JSON.stringify({ fCntUplink: fcnt, devAddr: devAddrHex })
      );
    }

    store.lnsUpdateSessionAfterUplink(devEui, session);

    const radioMeta = buildRadioMetaFromRxpk(rxpk);
    /** Solo metadatos seguros (nunca esparcir la sesión LNS: contiene Buffers de claves). */
    const props = {
      devEUI: devEui,
      devAddr: devAddrHex,
      fCnt: fcnt,
      fcnt_up: fcnt,
      fPort: p.getFPort(),
      payload_hex: plain.toString('hex').toUpperCase(),
      payload_b64: plain.toString('base64'),
      gateway_id: gatewayEuiNorm,
      freq_mhz: rxpk.freq,
      lora_snr: rxpk.lsnr,
      datr: rxpk.datr,
      connectStatus: 'online',
      lns_decrypted: true,
      lorawan_class: session.deviceClass,
      rx_delay_sec: session.rxDelaySec,
      class_b_ping_periodicity: session.classBPingPeriodicity,
      class_b_data_rate: session.classBDataRate,
      fcnt_down: session.fcntDown,
      lora_downlink_device_acked: macAckForDownlink && hadAwaitingDlAck ? true : undefined,
      ...radioMeta,
    };

    saveIngestEntry(userId, {
      deviceId: devEui,
      deviceName: displayName,
      devEUI: devEui,
      properties: props,
    });
    return true;
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
    const gatewayEuiNorm =
      store.getLorawanGatewayEuiNormForUser(userId, gatewayMac8) || gatewayMac8.toString('hex').toLowerCase();

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
   * @param {{ delayMs?: number, confirmed?: boolean, priority?: number }} [opts]
   */
  function enqueueAppDownlink(userId, devEuiNorm16, fPort, payloadBuf, opts) {
    const opt = opts || {};
    const session = store.lnsGetSessionByDevEui(userId, devEuiNorm16);
    if (!session) {
      const err = new Error('Dispositivo sin sesión LoRaWAN (haga OTAA primero)');
      err.code = 'NO_SESSION';
      throw err;
    }
    if (!session.lastGatewayEui) {
      const err = new Error('Sin gateway visto aún para downlink');
      err.code = 'NO_GATEWAY';
      throw err;
    }

    const cls = resolveLnsDeviceClassFromDecodeConfigThenUserDevice(store, userId, devEuiNorm16, session);
    const nextDown = session.fcntDown < 0 ? 0 : (session.fcntDown + 1) % 65536;
    const useTxAck = appDownlinkTxAckTrackingEnabled();
    if (useTxAck && store.lnsHasTrackedDownlinkPendingForDev(userId, devEuiNorm16)) {
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
    if (!useTxAck) {
      store.lnsSetFcntDown(userId, devEuiNorm16, nextDown);
      if (opt.confirmed) {
        store.lnsMarkAwaitingConfirmedDeviceAck(userId, devEuiNorm16);
      }
    }

    const rxpkStub = {
      tmst: session.lastRxTmst || 0,
      freq: session.lastRxFreq || rx2Defaults().freq,
      datr: session.lastRxDatr || rx2Defaults().datr,
      codr: session.lastRxCodr || '4/5',
      rfch: session.lastRxRfch != null ? session.lastRxRfch : 0,
    };

    const rxDelaySec =
      session.rxDelaySec != null ? Math.max(1, Math.min(15, Number(session.rxDelaySec))) : 5;
    let useImme = true;
    let notBeforeMs = 0;
    let classAWindow = 'RX1';

    if (cls === 'C') {
      useImme = true;
      const gap = envInt('SYSCOM_LNS_CLASS_C_TX_GAP_MS', 0);
      const gw = session.lastGatewayEui;
      if (gap > 0 && gw) {
        const prevEnd = lastClassCDlEndByGw[gw] || 0;
        const start = Math.max(Date.now(), prevEnd);
        notBeforeMs = start;
        lastClassCDlEndByGw[gw] = start + gap;
      } else {
        notBeforeMs = 0;
      }
    } else if (cls === 'A') {
      /**
       * Clase A: nunca `imme: true` para datos de aplicación — el end-device solo escucha en RX1/RX2
       * tras un uplink; hay que programar `tmst` relativo al último `rxpk.tmst` del gateway.
       */
      useImme = false;
      const lastUplinkWall = session.lastUplinkWallMs;
      const now = Date.now();
      const rxD = Math.max(1, Math.min(15, Number(rxDelaySec) || 5));
      const graceMs =
        process.env.SYSCOM_LNS_CLASS_A_UPLINK_GRACE_MS != null &&
        String(process.env.SYSCOM_LNS_CLASS_A_UPLINK_GRACE_MS).trim() !== ''
          ? envInt('SYSCOM_LNS_CLASS_A_UPLINK_GRACE_MS', 2000)
          : 2000;
      const maxAgeMs = rxD * 1000 + graceMs;
      if (session.lastRxTmst == null || Number.isNaN(Number(session.lastRxTmst))) {
        const err = new Error(
          'Downlink clase A: falta tmst del último uplink en el gateway. Espere un uplink por radio antes de enviar.'
        );
        err.code = 'CLASS_A_NO_RXTMST';
        throw err;
      }
      if (Number(session.lastRxTmst) <= 0) {
        const err = new Error(
          'Downlink clase A: tmst del último uplink no válido (0). Espere un uplink real por el gateway Semtech.'
        );
        err.code = 'CLASS_A_INVALID_RXTMST';
        throw err;
      }
      if (lastUplinkWall == null || Number.isNaN(Number(lastUplinkWall)) || now - lastUplinkWall > maxAgeMs) {
        const agoSec =
          lastUplinkWall != null && !Number.isNaN(Number(lastUplinkWall))
            ? Math.round((now - lastUplinkWall) / 1000)
            : null;
        const err = new Error(
          agoSec == null
            ? `Downlink clase A: no hay registro de uplink reciente; envíe el comando dentro de los ${Math.round(
                maxAgeMs / 1000
              )} s posteriores a un uplink del dispositivo (RX1/RX2).`
            : `Downlink clase A: el último uplink fue hace ${agoSec} s; el máximo permitido para programar RX es ${Math.round(
                maxAgeMs / 1000
              )} s (RxDelay ${rxD} s + margen).`
        );
        err.code = 'CLASS_A_STALE_UPLINK';
        throw err;
      }
      classAWindow = classARxWindowMode();
      notBeforeMs = 0;
    } else if (cls === 'B') {
      useImme = true;
      if (opt.delayMs != null && Number.isFinite(Number(opt.delayMs))) {
        notBeforeMs = Date.now() + Math.max(0, Number(opt.delayMs));
      } else {
        notBeforeMs = estimateClassBNotBeforeMs({
          ...session,
          classBPingPeriodicity: session.classBPingPeriodicity,
        });
      }
    }

    const pullObj = buildTxpk(phy, rxpkStub, {
      imme: useImme,
      rxDelaySec,
      classAWindow: cls === 'A' ? classAWindow : 'RX1',
    });
    if (cls === 'A' && pullObj?.txpk && pullObj.txpk.imme === false) {
      const rx1Us = classARx1DelayUs(rxDelaySec);
      console.log(
        `[LNS] Downlink clase A: tmst=${pullObj.txpk.tmst}, imme=false, rxDelaySec=${rxDelaySec}, window=${classAWindow}, rx1DelayUs=${classAWindow === 'RX1' ? rx1Us : 'RX2-offset'}`
      );
    }
    const dlPriority = opt.priority != null ? Number(opt.priority) : 0;
    if (useTxAck) {
      store.lnsEnqueuePullResp(userId, session.lastGatewayEui, pullObj, notBeforeMs, dlPriority, {
        devEui: devEuiNorm16,
        newFcnt: nextDown,
        prevFcnt: session.fcntDown,
        confirmedDown: Boolean(opt.confirmed),
      });
    } else {
      store.lnsEnqueuePullResp(userId, session.lastGatewayEui, pullObj, notBeforeMs, dlPriority);
    }

    if (macAck) {
      store.lnsClearPendingMacAck(userId, devEuiNorm16);
    }

    const rx1DelayUsApplied = cls === 'A' && classAWindow === 'RX1' ? classARx1DelayUs(rxDelaySec) : null;
    return {
      ok: true,
      fCnt: nextDown,
      imme: useImme,
      deviceClass: cls,
      notBeforeMs,
      confirmedDown: Boolean(opt.confirmed),
      macAckIncluded: macAck,
      classARxWindow: cls === 'A' ? classAWindow : null,
      rxDelaySec,
      txpkTmst: pullObj?.txpk?.tmst != null ? pullObj.txpk.tmst : undefined,
      rx1DelayUs: rx1DelayUsApplied != null ? rx1DelayUsApplied : undefined,
      priority: dlPriority,
      txAckPending: useTxAck,
    };
  }

  /**
   * GW_TX_ACK (Semtech UDP 0x05): primero `store.lnsHandleGatewayTxAck` (inflight, FCnt, reintentos),
   * luego evento UI/SSE para correlación en cliente (`downlink_gateway_tx_ack` / `downlink_gateway_tx_reject`).
   * El JSON es solo el cuerpo GWMP tras el EUI (12 B), p. ej. `{ txpk_ack: { error: "NONE" } }`.
   */
  function handleTxAck(gatewayEuiNorm16, tokenBuf, txAckJson) {
    if (!gatewayEuiNorm16 || !tokenBuf || tokenBuf.length < 2) return;
    if (typeof store.lnsHandleGatewayTxAck !== 'function') return;
    const json = txAckJson && typeof txAckJson === 'object' ? txAckJson : {};
    const outcome = store.lnsHandleGatewayTxAck(gatewayEuiNorm16, tokenBuf, json);
    if (!outcome || !outcome.devEui) return;
    if (typeof insertUiEvent !== 'function') return;
    try {
      const eventType = outcome.success ? 'downlink_gateway_tx_ack' : 'downlink_gateway_tx_reject';
      const meta = {
        gatewayEui: outcome.gatewayEui,
        tokenHex: Buffer.from(tokenBuf).toString('hex'),
        success: outcome.success,
        error: outcome.error,
        fCnt: outcome.newFcnt,
        trackTxAck: outcome.trackTxAck,
        downlinkId: outcome.downlinkId,
        txpkAck: json.txpk_ack != null ? json.txpk_ack : undefined,
      };
      insertUiEvent(outcome.userId, outcome.devEui, eventType, JSON.stringify(meta));
    } catch (e) {
      console.warn('[LNS] UI event tras GW_TX_ACK:', e.message);
    }
  }

  return { processPushJson, enqueueAppDownlink, processRxpk, normalizeDeviceClass, handleTxAck };
}

module.exports = { createLorawanLnsEngine };
