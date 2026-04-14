/**
 * LNS integrado — protocolo Semtech UDP GWMP v2 (packet forwarder clásico).
 * PUSH_DATA → misma tubería que POST /api/lorawan/uplink (normalize + telemetría).
 *
 * Multi-tenant: el EUI de 8 B del paquete se cruza con `lorawan_gateways` del usuario.
 * Opcional: SYSCOM_LNS_DEFAULT_USER_ID si el GW aún no está dado de alta (solo pruebas).
 *
 * PULL_DATA → PULL_ACK y hasta SYSCOM_LNS_PULL_BURST mensajes PULL_RESP por ciclo (cola priorizada).
 * GW_TX_ACK → confirma o rechaza la transmisión; downlinks de aplicación confirman FCnt y reintentan si aplica.
 */
'use strict';

const dgram = require('dgram');

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
 */
function startSemtechUdpLns(opts) {
  const { port, store, processPushDataJson } = opts;
  const socket = dgram.createSocket('udp4');

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
            sendUdp(socket, pkt, rinfo);
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
      if (!gwNorm || typeof store.lnsHandleGatewayTxAck !== 'function') return;
      try {
        store.lnsHandleGatewayTxAck(gwNorm, token, jsonObj);
      } catch (e) {
        console.error('[LNS-UDP] TX_ACK:', e.message);
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
      return;
    }
  });

  socket.bind(port, '0.0.0.0', () => {
    console.log(
      `[LNS-UDP] Semtech GWMP en udp/0.0.0.0:${port} — Packet Forward tipo Semtech → IP pública de este servidor y puerto ${port}`
    );
  });

  return socket;
}

module.exports = { startSemtechUdpLns };
