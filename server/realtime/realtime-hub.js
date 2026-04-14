/**
 * Server-Sent Events (SSE) por usuario: telemetría guardada y eventos LNS de UI.
 * Sin WebSockets ni broker externo.
 */
'use strict';

const metrics = require('../monitoring/syscom-metrics');

const DEFAULT_MAX_PER_USER = Math.min(
  20,
  Math.max(2, parseInt(process.env.SYSCOM_SSE_MAX_PER_USER || '8', 10) || 8)
);
const HEARTBEAT_MS = Math.max(
  10000,
  parseInt(process.env.SYSCOM_SSE_HEARTBEAT_MS || '25000', 10) || 25000
);

/**
 * @typedef {{ res: import('express').Response, hb: NodeJS.Timeout }} Client
 */

function createRealtimeHub() {
  /** @type {Map<string, Set<Client>>} */
  const byUser = new Map();

  function subscriberCount() {
    let n = 0;
    for (const set of byUser.values()) n += set.size;
    return n;
  }

  /**
   * @param {string} userId
   * @param {import('express').Response} res
   */
  function subscribe(userId, res) {
    const uid = String(userId);
    let set = byUser.get(uid);
    if (!set) {
      set = new Set();
      byUser.set(uid, set);
    }
    if (set.size >= DEFAULT_MAX_PER_USER) {
      const oldest = set.values().next().value;
      if (oldest) unsubscribeClient(uid, oldest);
    }

    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cerrado */
      }
    }, HEARTBEAT_MS);

    const client = { res, hb };
    set.add(client);

    const cleanup = () => {
      unsubscribeClient(uid, client);
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);

    return client;
  }

  /**
   * @param {string} userId
   * @param {Client} client
   */
  function unsubscribeClient(userId, client) {
    clearInterval(client.hb);
    const set = byUser.get(userId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) byUser.delete(userId);
  }

  /**
   * @param {string} userId
   * @param {string} event
   * @param {object} payload
   */
  function broadcast(userId, event, payload) {
    const uid = String(userId);
    const set = byUser.get(uid);
    if (!set || set.size === 0) return;
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of set) {
      try {
        c.res.write(line);
      } catch {
        unsubscribeClient(uid, c);
      }
    }
    if (event === 'telemetry') metrics.inc('sse_broadcast_telemetry');
    if (event === 'lns') metrics.inc('sse_broadcast_lns');
  }

  return {
    subscribe,
    broadcast,
    subscriberCount,
    _debugUserCount: () => byUser.size,
  };
}

module.exports = { createRealtimeHub };
