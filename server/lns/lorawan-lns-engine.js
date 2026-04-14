'use strict';

const crypto = require('crypto');
const lora_packet = require('lora-packet');
const { deriveSessionKeys10x, parseKeyHex32 } = require('./lorawan-lns-crypto');

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function rx1DelayUs() {
  return envInt('SYSCOM_LNS_RX1_DELAY_US', 1000000);
}

/** Retardo RX1 en µs: override por env o RxDelay de sesión (seg) alineado al Join-Accept. */
function classARx1DelayUs(rxDelaySec) {
  if (process.env.SYSCOM_LNS_RX1_DELAY_US != null && String(process.env.SYSCOM_LNS_RX1_DELAY_US).trim() !== '') {
    return envInt('SYSCOM_LNS_RX1_DELAY_US', 1000000);
  }
  const s = rxDelaySec != null ? Math.max(1, Math.min(15, Number(rxDelaySec))) : 1;
  return s * 1000000;
}

function classARxWindowMode() {
  const m = String(process.env.SYSCOM_LNS_CLASS_A_RX_WINDOW || 'RX1')
    .trim()
    .toUpperCase();
  if (m === 'RX2' || m === 'SCHED_RX2' || m === 'WINDOW2') return 'RX2';
  return 'RX1';
}

/** Si es false, el FCnt down se confirma al encolar (comportamiento anterior). Si es true, solo tras GW_TX_ACK. */
function txAckTrackingEnabled() {
  return String(process.env.SYSCOM_LNS_TX_ACK || '1').trim() !== '0';
}

function txPower() {
  return envInt('SYSCOM_LNS_TX_POWER', 14);
}

function classARx1WindowMs() {
  return envInt('SYSCOM_LNS_CLASS_A_RX1_WINDOW_MS', 35000);
}

function netIdBuf() {
  const hex = String(process.env.SYSCOM_LNS_NET_ID || '000001').replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return Buffer.from('000001', 'hex');
  return Buffer.from(hex, 'hex');
}

function rx2Defaults() {
  return {
    freq: envFloat('SYSCOM_LNS_RX2_FREQ', 869.525),
    datr: process.env.SYSCOM_LNS_RX2_DATR || 'SF12BW125',
    codr: process.env.SYSCOM_LNS_RX2_CODR || '4/5',
  };
}

function normalizeDeviceClass(v) {
  const u = String(v || 'A')
    .trim()
    .toUpperCase();
  return u === 'B' || u === 'C' ? u : 'A';
}

/**
 * @param {Buffer} phy
 * @param {{ tmst?: number, freq?: number, datr?: string, codr?: string, rfch?: number }} rxpk
 * @param {{ imme?: boolean, rxDelaySec?: number, classAWindow?: 'RX1'|'RX2' }} [opts]
 */
function buildTxpk(phy, rxpk, opts) {
  const useImme = opts && opts.imme;
  const rxDelaySec =
    opts && opts.rxDelaySec != null ? Math.max(1, Math.min(15, Number(opts.rxDelaySec))) : null;
  const classAWindow = (opts && opts.classAWindow) || 'RX1';
  const r2 = rx2Defaults();
  const base = {
    imme: Boolean(useImme),
    rfch: rxpk && rxpk.rfch != null ? Number(rxpk.rfch) : 0,
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

  function processJoin(userId, gatewayEuiNorm, p, rxpk) {
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

    const secUser = envInt('SYSCOM_LNS_RX_DELAY_SEC', 1);
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
        CFList: Buffer.alloc(0),
      },
      null,
      null,
      appKeyBuf
    );
    const phy = ja.getPHYPayload();

    const deviceClass = normalizeDeviceClass(row.lorawan_class || row.lorawanClass);

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
    store.lnsEnqueuePullResp(userId, gatewayEuiNorm, pullObj, 0, 255);

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
      },
    });
    console.log('[LNS] OTAA Join-Accept encolado →', devEui, devAddrBuf.toString('hex'), 'clase', deviceClass);
    return true;
  }

  function processDataUp(userId, gatewayEuiNorm, p, rxpk) {
    const devAddrHex = p.DevAddr.toString('hex').toUpperCase();
    const session = store.lnsGetSessionByDevAddr(userId, devAddrHex);
    if (!session) return false;
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

    const props = {
      devEUI: devEui,
      devAddr: devAddrHex,
      fCnt: fcnt,
      fPort: p.getFPort(),
      payload_hex: plain.toString('hex').toUpperCase(),
      payload_b64: plain.toString('base64'),
      gateway_id: gatewayEuiNorm,
      freq_mhz: rxpk.freq,
      rssi: rxpk.rssi,
      lora_snr: rxpk.lsnr,
      datr: rxpk.datr,
      connectStatus: 'online',
      lns_decrypted: true,
      lorawan_class: session.deviceClass,
      lora_downlink_device_acked: macAckForDownlink && hadAwaitingDlAck ? true : undefined,
    };

    saveIngestEntry(userId, {
      deviceId: devEui,
      deviceName: displayName,
      devEUI: devEui,
      properties: props,
      ...props,
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

    const cls = normalizeDeviceClass(session.deviceClass);
    const nextDown = session.fcntDown < 0 ? 0 : (session.fcntDown + 1) % 65536;
    const useTxAck = txAckTrackingEnabled();
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

    const rxDelaySec = session.rxDelaySec != null ? session.rxDelaySec : 1;
    let useImme = true;
    let notBeforeMs = 0;
    let classAWindow = 'RX1';

    if (cls === 'C') {
      useImme = true;
      notBeforeMs = 0;
    } else if (cls === 'A') {
      const wall = session.lastUplinkWallMs;
      const fresh = wall != null && Date.now() - wall < classARx1WindowMs();
      if (fresh && session.lastRxTmst != null) {
        useImme = false;
        classAWindow = classARxWindowMode();
      } else {
        useImme = true;
      }
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
      classAWindow: cls === 'A' && !useImme ? classAWindow : 'RX1',
    });
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

    return {
      ok: true,
      fCnt: nextDown,
      imme: useImme,
      deviceClass: cls,
      notBeforeMs,
      confirmedDown: Boolean(opt.confirmed),
      macAckIncluded: macAck,
      classARxWindow: cls === 'A' && !useImme ? classAWindow : null,
      priority: dlPriority,
      txAckPending: useTxAck,
    };
  }

  return { processPushJson, enqueueAppDownlink, processRxpk, normalizeDeviceClass };
}

module.exports = { createLorawanLnsEngine };
