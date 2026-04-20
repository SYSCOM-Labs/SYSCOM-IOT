/**
 * LNS integrado — protocolo Semtech UDP GWMP v2 (packet forwarder clásico).
 * PUSH_DATA → misma tubería que POST /api/lorawan/uplink (normalize + telemetría).
 *
 * Multi-tenant: el EUI de 8 B del paquete se cruza con `lorawan_gateways` del usuario.
 * Opcional: SYSCOM_LNS_DEFAULT_USER_ID si el GW aún no está dado de alta (solo pruebas).
 *
 * PULL_DATA → PULL_ACK y hasta SYSCOM_LNS_PULL_BURST mensajes PULL_RESP por ciclo (cola priorizada).
 * GW_TX_ACK (0x05) → JSON **solo** en bytes ≥12 (no parsear el datagrama UDP entero). Preferir
 * `globalThis.lnsEngine.handleTxAck` (store + eventos UI/SSE). Si el motor no está cargado, solo `store.lnsHandleGatewayTxAck`.
 *
 * Resiliencia: no se llama a process.exit por errores UDP (p. ej. EADDRINUSE). El API HTTP sigue vivo;
 * se reintenta el bind cada LNS_UDP_BIND_RETRY_MS hasta tener éxito (o hasta stop() explícito).
 */
'use strict';

const dgram = require('dgram');
const { rx2DefaultsFromEnvAndPlan } = require('./lorawan-regional-plan');

const PROTOCOL_VERSION = 0x02;
const GW_PUSH_DATA = 0x00;
const GW_PUSH_ACK = 0x01;
const GW_PULL_DATA = 0x02;
const GW_PULL_RESP = 0x03;
const GW_PULL_ACK = 0x04;
const GW_TX_ACK = 0x05;

function pullBurstLimit() {
  const n = parseInt(process.env.SYSCOM_LNS_PULL_BURST, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(20, n));
}

function bindRetryMs() {
  const n = parseInt(process.env.LNS_UDP_BIND_RETRY_MS || '30000', 10);
  if (!Number.isFinite(n)) return 30000;
  return Math.max(5000, Math.min(24 * 60 * 60 * 1000, n));
}

function gwAck(version, token2, identifier) {
  return Buffer.from([version, token2[0], token2[1], identifier]);
}

/**
 * @param {import('dgram').Socket} socket
 * @param {Buffer} buf
 * @param {import('dgram').RemoteInfo} rinfo
 */
function sendUdp(socket, buf, rinfo) {
  socket.send(buf, rinfo.port, rinfo.address, () => {});
}

/**
 * @param {{
 *   port: number,
 *   store: object,
 *   processPushDataJson: (userId: string, json: object) => void,
 * }} opts
 * @returns {{ stop: () => void }}
 */
function startSemtechUdpLns(opts) {
  const { port, store, processPushDataJson } = opts;
  const retryMs = bindRetryMs();
  let stopped = false;
  /** @type {import('dgram').Socket | null} */
  let liveSocket = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function safeCloseCurrent() {
    if (!liveSocket) return;
    const s = liveSocket;
    liveSocket = null;
    try {
      s.removeAllListeners();
      s.close();
    } catch {
      /* ignore */
    }
  }

  function scheduleRetry(reason) {
    if (stopped) return;
    if (retryTimer) return;
    const sec = Math.round(retryMs / 1000);
    console.warn(
      `[LNS-UDP] ${reason || 'Error UDP'} — API HTTP sigue activa. Reintento de bind udp/0.0.0.0:${port} en ${sec}s (LNS_UDP_BIND_RETRY_MS).`
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) attemptBind();
    }, retryMs);
  }

  function onMessage(msg, rinfo) {
    const s = liveSocket;
    if (!s) return;
    if (msg.length < 4) return;
    const version = msg[0];
    if (version !== PROTOCOL_VERSION) return;
    const token = msg.subarray(1, 3);
    const id = msg[3];

    if (id === GW_PULL_DATA) {
      if (msg.length < 12) return;
      sendUdp(s, gwAck(version, token, GW_PULL_ACK), rinfo);
      const mac = msg.subarray(4, 12);
      const gwNorm = store.lnsResolveGatewayEuiNorm(mac);
      if (gwNorm && typeof store.lnsDequeuePullResp === 'function') {
        const burst = pullBurstLimit();
        for (let b = 0; b < burst; b += 1) {
          const row = store.lnsDequeuePullResp(gwNorm);
          if (!row) break;
          try {
            const inner = Buffer.from(row.json, 'utf8');
            const pkt = Buffer.alloc(4 + inner.length);
            pkt[0] = version;
            pkt[1] = token[0];
            pkt[2] = token[1];
            pkt[3] = GW_PULL_RESP;
            inner.copy(pkt, 4);
            sendUdp(s, pkt, rinfo);
            if (row.trackTxAck && typeof store.lnsPullRespEnterAwaitTxAck === 'function') {
              try {
                store.lnsPullRespEnterAwaitTxAck(row.id, gwNorm, token[0], token[1]);
              } catch (dbErr) {
                console.error('[LNS-UDP] await TX_ACK DB:', dbErr.message);
              }
            } else {
              store.lnsMarkPullRespSent(row.id);
            }
          } catch (e) {
            console.error('[LNS-UDP] PULL_RESP:', e.message);
          }
        }
      }
      return;
    }

    if (id === GW_TX_ACK) {
      if (msg.length < 12) return;
      const mac = msg.subarray(4, 12);
      let jsonObj;
      try {
        const raw = msg.subarray(12).toString('utf8');
        jsonObj = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('[LNS-UDP] TX_ACK JSON inválido:', e.message);
        return;
      }
      const gwNorm = store.lnsResolveGatewayEuiNorm(mac);
      if (!gwNorm) return;
      try {
        const eng = typeof globalThis !== 'undefined' && globalThis.lnsEngine;
        if (eng && typeof eng.handleTxAck === 'function') {
          eng.handleTxAck(gwNorm, token, jsonObj);
        } else if (typeof store.lnsHandleGatewayTxAck === 'function') {
          store.lnsHandleGatewayTxAck(gwNorm, token, jsonObj);
        }
      } catch (e) {
        console.error('[LNS-UDP] TX_ACK:', e.message);
      }
      return;
    }

    if (id === GW_PUSH_DATA) {
      if (msg.length < 12) {
        sendUdp(s, gwAck(version, token, GW_PUSH_ACK), rinfo);
        return;
      }
      const mac = msg.subarray(4, 12);
      let jsonObj;
      try {
        const raw = msg.subarray(12).toString('utf8');
        jsonObj = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('[LNS-UDP] JSON inválido desde', rinfo.address, e.message);
        sendUdp(s, gwAck(version, token, GW_PUSH_ACK), rinfo);
        return;
      }

      sendUdp(s, gwAck(version, token, GW_PUSH_ACK), rinfo);

      let userIds = store.findUserIdsBySemtechGatewayMac8(mac);
      const defUid = process.env.SYSCOM_LNS_DEFAULT_USER_ID;
      if (userIds.length === 0 && defUid) {
        console.warn('[LNS-UDP] Gateway sin registro en app; SYSCOM_LNS_DEFAULT_USER_ID →', defUid);
        userIds = [String(defUid).trim()];
      }
      if (userIds.length === 0) {
        const h = mac.toString('hex');
        console.warn(
          '[LNS-UDP] Gateway no registrado (MAC8 wire hex:',
          h,
          '). Añádelo en Gateways LoRaWAN con el mismo EUI.'
        );
        return;
      }
      if (userIds.length > 1) {
        console.warn('[LNS-UDP] Varios usuarios comparten el mismo EUI de gateway; ingiriendo solo para el primero.');
      }
      const userId = userIds[0];
      try {
        processPushDataJson(userId, mac, jsonObj);
      } catch (e) {
        console.error('[LNS-UDP] Error al procesar PUSH_DATA:', e.message);
      }
    }
  }

  function attemptBind() {
    if (stopped) return;
    clearRetryTimer();
    safeCloseCurrent();

    const socket = dgram.createSocket('udp4');
    liveSocket = socket;

    socket.on('error', (err) => {
      console.error('[LNS-UDP]', err.message, err.code ? `(${err.code})` : '');
      safeCloseCurrent();
      const reason =
        err.code === 'EADDRINUSE'
          ? `Puerto ${port} ocupado (EADDRINUSE)`
          : `Socket UDP (${err.code || 'error'})`;
      scheduleRetry(reason);
    });

    socket.on('message', onMessage);

    socket.bind(port, '0.0.0.0', () => {
      if (stopped || liveSocket !== socket) return;
      clearRetryTimer();
      const eff = rx2DefaultsFromEnvAndPlan();
      console.log(
        `[LNS-UDP] Semtech GWMP activo: udp/0.0.0.0:${port} — plan ${eff.planId}, RX2 efectivo ${eff.freq} MHz ${eff.datr} — packet forwarder → IP pública:${port}`
      );
    });
  }

  attemptBind();

  return {
    stop() {
      stopped = true;
      clearRetryTimer();
      safeCloseCurrent();
    },
  };
}

module.exports = { startSemtechUdpLns };
