/**
 * LNS integrado — protocolo Semtech UDP GWMP v2 (packet forwarder clásico).
 * PUSH_DATA → misma tubería que POST /api/lorawan/uplink (normalize + telemetría).
 *
 * Multi-tenant: el EUI de 8 B del paquete se cruza con `lorawan_gateways` del usuario.
 * Opcional: SYSCOM_LNS_DEFAULT_USER_ID si el GW aún no está dado de alta (solo pruebas).
 *
 * PULL_DATA → PULL_ACK y hasta SYSCOM_LNS_PULL_BURST mensajes PULL_RESP por ciclo (cola priorizada).
 * Tras un uplink (PUSH_DATA), si hay PULL_RESP pendiente y un peer PULL reciente, se envía
 * de inmediato al mismo UDP (no esperar el keepalive ~10 s: RX1 clase A es 1–5 s).
 * Con downlinks que esperan GW_TX_ACK, deje **SYSCOM_LNS_PULL_BURST=1**: varios PULL_RESP en el mismo PULL comparten token y el ACK solo correlaciona uno.
 * GW_TX_ACK → confirma o rechaza la transmisión; downlinks de aplicación confirman FCnt y reintentan si aplica.
 * Tras cada PULL_DATA: prune de await_tx_ack sin GW_TX_ACK (`SYSCOM_LNS_TX_ACK_TIMEOUT_MS` o `SYSCOM_LNS_TX_ACK_SILENCE_MS`) para no bloquear la API.
 * Además: intervalo `SYSCOM_LNS_TX_ACK_PRUNE_INTERVAL_MS` (ms; **0** = desactivar) ejecuta la misma purga aunque no llegue PULL_DATA.
 */
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const { ensureGatewaysAutoRegistered } = require('./lib/auto-fleet-sync.cjs');

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

function pullPeerMaxAgeMs() {
  const n = parseInt(process.env.SYSCOM_LNS_PULL_PEER_MAX_AGE_MS || '70000', 10);
  return Number.isFinite(n) ? Math.max(3000, n) : 70000;
}

function pullRespOnPushEnabled() {
  return String(process.env.SYSCOM_LNS_PULL_RESP_ON_PUSH || '1').trim() !== '0';
}

/**
 * @param {{ address?: string, port?: number, lastMs?: number } | null | undefined} peer
 * @param {number} [nowMs]
 * @param {number} [maxAgeMs]
 */
function isPullPeerFresh(peer, nowMs, maxAgeMs) {
  if (!peer || peer.address == null || String(peer.address).trim() === '') return false;
  const port = Number(peer.port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  const last = Number(peer.lastMs);
  if (!Number.isFinite(last) || last <= 0) return false;
  const now = nowMs != null && Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const age = now - last;
  const maxAge = maxAgeMs != null && Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : pullPeerMaxAgeMs();
  return age >= 0 && age <= maxAge;
}

function randomGwmpToken() {
  return crypto.randomBytes(2);
}

function gwAck(version, token2, identifier) {
  return Buffer.from([version, token2[0], token2[1], identifier]);
}

/**
 * @param {string} jsonOut
 * @param {Buffer|Uint8Array} token2
 */
function buildPullRespPacket(jsonOut, token2) {
  const inner = Buffer.from(String(jsonOut), 'utf8');
  const pkt = Buffer.alloc(4 + inner.length);
  pkt[0] = PROTOCOL_VERSION;
  pkt[1] = token2[0];
  pkt[2] = token2[1];
  pkt[3] = GW_PULL_RESP;
  inner.copy(pkt, 4);
  return pkt;
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
 * @param {Map<string, { address: string, port: number, lastMs: number }>} pullPeers
 * @param {string[]} keys
 * @param {{ address: string, port: number }} rinfo
 */
function rememberPullPeer(pullPeers, keys, rinfo) {
  if (!pullPeers || !rinfo) return;
  const rec = { address: rinfo.address, port: rinfo.port, lastMs: Date.now() };
  for (const raw of keys || []) {
    const k = String(raw || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (k.length === 16 || k.length === 8) pullPeers.set(k, rec);
  }
}

function lookupPullPeer(pullPeers, keys) {
  if (!pullPeers) return null;
  for (const raw of keys || []) {
    const k = String(raw || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (!k) continue;
    const peer = pullPeers.get(k);
    if (isPullPeerFresh(peer)) return peer;
  }
  return null;
}

/**
 * @param {{
 *   socket: import('dgram').Socket,
 *   store: object,
 *   gwNorm: string,
 *   rinfo: { address: string, port: number },
 *   token2?: Buffer|Uint8Array,
 *   reuseTokenForBurst?: boolean,
 *   refreshPullRespJson?: Function,
 * }} opts
 * @returns {number} enviados
 */
function dequeueAndSendPullResps(opts) {
  const { socket, store, gwNorm, rinfo, refreshPullRespJson } = opts;
  if (!gwNorm || !rinfo || !socket || typeof store.lnsDequeuePullResp !== 'function') return 0;
  const burst = pullBurstLimit();
  const reuse = Boolean(opts.reuseTokenForBurst);
  let sent = 0;
  for (let b = 0; b < burst; b += 1) {
    const row = store.lnsDequeuePullResp(gwNorm);
    if (!row) break;
    const tok =
      reuse && opts.token2 && opts.token2.length >= 2 ? opts.token2 : randomGwmpToken();
    try {
      const jsonOut =
        typeof refreshPullRespJson === 'function' ? refreshPullRespJson(row) : row.json;
      sendUdp(socket, buildPullRespPacket(jsonOut, tok), rinfo);
      if (row.trackTxAck && typeof store.lnsPullRespEnterAwaitTxAck === 'function') {
        try {
          store.lnsPullRespEnterAwaitTxAck(row.id, gwNorm, tok[0], tok[1]);
        } catch (dbErr) {
          console.error('[LNS-UDP] await TX_ACK DB:', dbErr.message);
        }
      } else if (typeof store.lnsMarkPullRespSent === 'function') {
        store.lnsMarkPullRespSent(row.id);
      }
      sent += 1;
    } catch (e) {
      console.error('[LNS-UDP] PULL_RESP:', e.message);
    }
  }
  return sent;
}

function pruneTxAckInflight(store) {
  if (typeof store.lnsPruneStaleAppDownlinkTxAckInflight !== 'function') return;
  try {
    store.lnsPruneStaleAppDownlinkTxAckInflight();
  } catch (e) {
    console.warn('[LNS-UDP] prune TX_ACK:', e.message);
  }
}

/**
 * @param {{
 *   port: number,
 *   store: object,
 *   processPushDataJson: (mac: Buffer, json: object, userIds: string[]) => void,
 *   onHeartbeat?: (mac: Buffer) => void,
 *   refreshPullRespJson?: (row: object) => string,
 * }} opts
 */
function startSemtechUdpLns(opts) {
  const { port, store, processPushDataJson, onHeartbeat, refreshPullRespJson } = opts;
  const socket = dgram.createSocket('udp4');
  const pullPeers = new Map();

  socket.on('error', (err) => {
    console.error('[LNS-UDP]', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`[LNS-UDP] Puerto ${port} en uso. Cambie LNS_UDP_PORT o libere el puerto.`);
      process.exit(1);
    }
  });

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 4) return;
    const version = msg[0];
    if (version !== PROTOCOL_VERSION) return;
    const token = msg.subarray(1, 3);
    const id = msg[3];

    if (id === GW_PULL_DATA) {
      if (msg.length < 12) return;
      sendUdp(socket, gwAck(version, token, GW_PULL_ACK), rinfo);
      const mac = msg.subarray(4, 12);
      if (typeof onHeartbeat === 'function') onHeartbeat(mac);
      ensureGatewaysAutoRegistered(store, mac);
      const gwNorm = store.lnsResolveGatewayEuiNorm(mac);
      rememberPullPeer(pullPeers, [gwNorm, mac.toString('hex')], rinfo);
      if (gwNorm) {
        dequeueAndSendPullResps({
          socket,
          store,
          gwNorm,
          rinfo,
          token2: token,
          reuseTokenForBurst: true,
          refreshPullRespJson,
        });
      }
      pruneTxAckInflight(store);
      return;
    }

    if (id === GW_TX_ACK) {
      if (msg.length < 12) return;
      const mac = msg.subarray(4, 12);
      const gwNormTx = store.lnsResolveGatewayEuiNorm(mac);
      rememberPullPeer(pullPeers, [gwNormTx, mac.toString('hex')], rinfo);
      let jsonObj;
      try {
        const raw = msg.subarray(12).toString('utf8');
        jsonObj = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('[LNS-UDP] TX_ACK JSON inválido:', e.message);
        return;
      }
      if (String(process.env.SYSCOM_LNS_LOG_TX_ACK || '').trim() === '1') {
        console.log('[LNS-UDP] GW_TX_ACK (0x05) raw JSON', JSON.stringify(jsonObj || {}), 'from', rinfo.address);
      } else if (String(process.env.SYSCOM_LNS_LOG_TX_ACK_PROGRESS || '').trim() === '1') {
        const ta = jsonObj && jsonObj.txpk_ack;
        const er = ta && ta.error != null ? String(ta.error) : '';
        console.log(
          '[LNS-UDP] GW_TX_ACK',
          'from',
          rinfo.address,
          'gw_mac8=',
          mac.toString('hex'),
          'token=',
          token[0],
          token[1],
          'txpk_ack.error=',
          er || '(vacío)',
          'json_keys=',
          jsonObj && typeof jsonObj === 'object' ? Object.keys(jsonObj).join(',') : ''
        );
      }
      const gwNorm = gwNormTx;
      if (!gwNorm || typeof store.lnsHandleGatewayTxAck !== 'function') {
        console.warn('[LNS-UDP] GW_TX_ACK sin gwNorm o sin store.lnsHandleGatewayTxAck; mac8=', mac.toString('hex'));
        return;
      }
      try {
        store.lnsHandleGatewayTxAck(gwNorm, token, jsonObj);
      } catch (e) {
        console.error('[LNS-UDP] TX_ACK:', e.message);
      }
      try {
        const ta = jsonObj && jsonObj.txpk_ack;
        const errAck = ta && ta.error != null ? String(ta.error) : 'NONE';
        const eng = typeof globalThis !== 'undefined' ? globalThis.lnsEngine : null;
        if (eng && typeof eng.handleTxAck === 'function') {
          eng.handleTxAck(gwNorm, errAck, ta && typeof ta === 'object' ? ta : {});
        }
      } catch (e2) {
        console.warn('[LNS-UDP] engine.handleTxAck:', e2.message);
      }
      return;
    }

    if (id === GW_PUSH_DATA) {
      if (msg.length < 12) {
        sendUdp(socket, gwAck(version, token, GW_PUSH_ACK), rinfo);
        return;
      }
      const mac = msg.subarray(4, 12);
      let jsonObj;
      try {
        const raw = msg.subarray(12).toString('utf8');
        jsonObj = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('[LNS-UDP] JSON inválido desde', rinfo.address, e.message);
        sendUdp(socket, gwAck(version, token, GW_PUSH_ACK), rinfo);
        return;
      }

      sendUdp(socket, gwAck(version, token, GW_PUSH_ACK), rinfo);

      let userIds = ensureGatewaysAutoRegistered(store, mac);
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
        console.warn(
          '[LNS-UDP] Varios usuarios comparten el mismo EUI de gateway; se prueba el LNS por cada cuenta hasta que un paquete encaje (join/sesión).'
        );
      }
      try {
        processPushDataJson(mac, jsonObj, userIds);
      } catch (e) {
        console.error('[LNS-UDP] Error al procesar PUSH_DATA:', e.message);
      }
      /**
       * Clase A: el medidor abre RX1 a 1–5 s. El keepalive PULL_DATA del UG65 suele ser ~10 s,
       * así que esperar el próximo PULL deja el tmst vencido (TOO_LATE). Semtech permite
       * PULL_RESP en cualquier momento al último peer de PULL_DATA.
       */
      if (pullRespOnPushEnabled()) {
        const gwNorm = store.lnsResolveGatewayEuiNorm(mac);
        const peer = lookupPullPeer(pullPeers, [gwNorm, mac.toString('hex')]);
        if (gwNorm && peer) {
          const n = dequeueAndSendPullResps({
            socket,
            store,
            gwNorm,
            rinfo: peer,
            refreshPullRespJson,
          });
          if (n > 0 && String(process.env.SYSCOM_LNS_LOG_DOWNLINK_SCHEDULE || '').trim() === '1') {
            console.log('[LNS-UDP] PULL_RESP tras PUSH_DATA', n, 'gw', gwNorm, 'peer', peer.address + ':' + peer.port);
          }
        }
      }
      return;
    }

    if (String(process.env.SYSCOM_LNS_LOG_GWMP_UNKNOWN || '').trim() === '1') {
      console.warn(
        '[LNS-UDP] GWMP id no manejado (no 0x00/0x02/0x05):',
        id,
        'len=',
        msg.length,
        'head_hex=',
        msg.subarray(0, Math.min(24, msg.length)).toString('hex'),
        'from',
        rinfo.address + ':' + rinfo.port
      );
    }
  });

  const pruneEveryMs = parseInt(process.env.SYSCOM_LNS_TX_ACK_PRUNE_INTERVAL_MS || '5000', 10);
  if (Number.isFinite(pruneEveryMs) && pruneEveryMs > 0) {
    const iv = setInterval(() => {
      pruneTxAckInflight(store);
    }, Math.max(2000, pruneEveryMs));
    if (typeof iv.unref === 'function') iv.unref();
  }

  socket.bind(port, '0.0.0.0', () => {
    console.log(
      `[LNS-UDP] Semtech GWMP en udp/0.0.0.0:${port} — Packet Forward tipo Semtech → IP pública de este servidor y puerto ${port}`
    );
  });

  return socket;
}

module.exports = {
  startSemtechUdpLns,
  isPullPeerFresh,
  pullPeerMaxAgeMs,
  pullRespOnPushEnabled,
  buildPullRespPacket,
  rememberPullPeer,
  lookupPullPeer,
  dequeueAndSendPullResps,
  PROTOCOL_VERSION,
  GW_PULL_RESP,
};
