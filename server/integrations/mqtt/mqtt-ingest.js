/**
 * Suscripción MQTT → ingesta HTTP local (UG63/SG50 y otros JSON LoRaWAN).
 *
 * Requiere: MQTT_BROKER_URL, SYSCOM_MQTT_INGEST_URL (POST completo hacia /api/lorawan/uplink/… o /api/ingest/…).
 *
 * Temas (cualquiera no vacío se suscribe):
 *   MQTT_SUBSCRIBE_TOPICS — lista separada por comas (prioridad si está definida)
 *   MQTT_UPLINK_TOPIC — tema uplink aplicación
 *   MQTT_TOPIC_JOIN, MQTT_TOPIC_ACK, MQTT_TOPIC_GATEWAY_INFO — §4, §5, §6 UG63/SG50
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function postJson(targetUrl, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: 30000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

function collectSubscribeTopics() {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const csv = process.env.MQTT_SUBSCRIBE_TOPICS || process.env.MQTT_TOPICS;
  if (csv) {
    csv.split(',').forEach((x) => add(x));
  }
  add(process.env.MQTT_UPLINK_TOPIC);
  add(process.env.MQTT_TOPIC_JOIN);
  add(process.env.MQTT_TOPIC_ACK);
  add(process.env.MQTT_TOPIC_GATEWAY_INFO);
  return out;
}

function startMqttIngest() {
  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch {
    console.warn('[MQTT] Paquete "mqtt" no instalado. Ejecuta: npm install mqtt');
    return null;
  }

  const broker = process.env.MQTT_BROKER_URL;
  const target = process.env.SYSCOM_MQTT_INGEST_URL;
  const topics = collectSubscribeTopics();

  if (!broker || !target || topics.length === 0) {
    return null;
  }

  const client = mqtt.connect(broker, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 30_000,
  });

  client.on('connect', () => {
    const qos = parseInt(process.env.MQTT_QOS || '0', 10) || 0;
    console.log(`[MQTT ingest] Conectado a ${broker}, suscripciones (${topics.length}):`, topics.join(', '));
    topics.forEach((t) => {
      client.subscribe(t, { qos }, (err) => {
        if (err) console.error('[MQTT ingest] subscribe', t, err.message);
      });
    });
  });

  client.on('message', (t, payload) => {
    let body;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      console.warn('[MQTT ingest] No JSON en', t);
      return;
    }
    postJson(target, body)
      .then((code) => {
        if (code && code >= 400) console.warn('[MQTT ingest] HTTP', code, '←', t);
      })
      .catch((e) => console.error('[MQTT ingest] Reenvío:', e.message));
  });

  client.on('error', (e) => console.error('[MQTT ingest]', e.message));
  return client;
}

module.exports = { startMqttIngest, collectSubscribeTopics };
