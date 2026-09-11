'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPullPeerFresh,
  buildPullRespPacket,
  rememberPullPeer,
  lookupPullPeer,
  dequeueAndSendPullResps,
  PROTOCOL_VERSION,
  GW_PULL_RESP,
} = require('../semtech-udp-lns');

test('isPullPeerFresh: peer PULL reciente sirve para PULL_RESP asíncrono', () => {
  const now = 1_000_000;
  assert.equal(isPullPeerFresh({ address: '1.2.3.4', port: 1700, lastMs: now - 4000 }, now, 70000), true);
  assert.equal(isPullPeerFresh({ address: '1.2.3.4', port: 1700, lastMs: now - 80000 }, now, 70000), false);
  assert.equal(isPullPeerFresh(null, now, 70000), false);
  assert.equal(isPullPeerFresh({ address: '1.2.3.4', port: 0, lastMs: now }, now, 70000), false);
});

test('buildPullRespPacket: GWMP v2 id=PULL_RESP y JSON intacto', () => {
  const tok = Buffer.from([0xab, 0xcd]);
  const pkt = buildPullRespPacket('{"txpk":{}}', tok);
  assert.equal(pkt[0], PROTOCOL_VERSION);
  assert.equal(pkt[1], 0xab);
  assert.equal(pkt[2], 0xcd);
  assert.equal(pkt[3], GW_PULL_RESP);
  assert.equal(pkt.subarray(4).toString('utf8'), '{"txpk":{}}');
});

test('rememberPullPeer / lookupPullPeer: EUI 16 hex o MAC8', () => {
  const map = new Map();
  rememberPullPeer(map, ['24e124fffefaf79f', 'fffefaf79f'], { address: '10.0.0.8', port: 5401 });
  const peer = lookupPullPeer(map, ['24e124fffefaf79f']);
  assert.ok(peer);
  assert.equal(peer.address, '10.0.0.8');
  assert.equal(peer.port, 5401);
});

test('dequeueAndSendPullResps: vacía la cola hacia el peer PULL, no al socket PUSH', () => {
  const sent = [];
  const socket = {
    send(buf, port, address, cb) {
      sent.push({ buf, port, address });
      if (typeof cb === 'function') cb();
    },
  };
  const rows = [{ id: 9, json: '{"txpk":{"imme":false}}', trackTxAck: false }];
  const store = {
    lnsDequeuePullResp: (gw) => {
      assert.equal(gw, '24e124fffefaf79f');
      return rows.shift() || null;
    },
    lnsMarkPullRespSent: (id) => {
      assert.equal(id, 9);
    },
  };
  const n = dequeueAndSendPullResps({
    socket,
    store,
    gwNorm: '24e124fffefaf79f',
    rinfo: { address: '203.0.113.10', port: 5410 },
  });
  assert.equal(n, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].address, '203.0.113.10');
  assert.equal(sent[0].port, 5410);
  assert.equal(sent[0].buf[3], GW_PULL_RESP);
});
