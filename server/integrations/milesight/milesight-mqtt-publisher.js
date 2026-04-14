/**
 * Publicación MQTT hacia UG63/SG50: downlink (§3) y API NS por request/response (§7).
 * Variables: MQTT_BROKER_URL, MQTT_USERNAME, MQTT_PASSWORD,
 *   MQTT_DOWNLINK_TOPIC_TEMPLATE (ej. milesight/downlink/{deveui}),
 *   MQTT_NS_REQUEST_TOPIC, MQTT_NS_RESPONSE_TOPIC, MQTT_NS_RESPONSE_TIMEOUT_MS (opcional, default 20000).
 */

let mqtt;
try {
  mqtt = require('mqtt');
} catch {
  mqtt = null;
}

let client = null;
let connecting = null;
const pendingNs = new Map();

function brokerOptions() {
  return {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 30_000,
  };
}

function getClient() {
  if (!mqtt) return null;
  const url = process.env.MQTT_BROKER_URL;
  if (!url) return null;
  if (client) return client;
  if (connecting) return connecting;

  connecting = new Promise((resolve, reject) => {
    const c = mqtt.connect(url, brokerOptions());
    const rt = process.env.MQTT_NS_RESPONSE_TOPIC;
    c.on('connect', () => {
      client = c;
      connecting = null;
      if (rt) {
        c.subscribe(rt, { qos: 0 }, (err) => {
          if (err) console.error('[MQTT publish] subscribe response:', err.message);
        });
      }
      resolve(c);
    });
    c.on('message', (_topic, payload) => {
      let j;
      try {
        j = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      const id = j.id != null ? String(j.id) : null;
      if (!id || !pendingNs.has(id)) return;
      const p = pendingNs.get(id);
      pendingNs.delete(id);
      clearTimeout(p.timer);
      p.resolve(j);
    });
    c.on('error', (e) => {
      if (!client) {
        connecting = null;
        reject(e);
      } else {
        console.error('[MQTT publish]', e.message);
      }
    });
  });

  return connecting;
}

async function withClient(fn) {
  const c = await getClient();
  if (!c) throw new Error('MQTT no disponible (instale mqtt y defina MQTT_BROKER_URL)');
  return fn(c);
}

function expandDownlinkTopic(deveui, explicitTopic) {
  if (explicitTopic && String(explicitTopic).trim()) return String(explicitTopic).trim();
  const tpl = process.env.MQTT_DOWNLINK_TOPIC_TEMPLATE;
  if (!tpl) throw new Error('Defina MQTT_DOWNLINK_TOPIC_TEMPLATE (ej. milesight/downlink/{deveui}) o envíe topic en el cuerpo');
  const eui = String(deveui || '').replace(/\s/g, '');
  return tpl.replace(/\{deveui\}/gi, eui);
}

/**
 * @param {string} deveui
 * @param {{ confirmed: boolean, fPort: number, data: string, topic?: string }} payload
 */
function publishDownlink(deveui, payload) {
  const { confirmed, fPort, data, topic: explicitTopic } = payload;
  if (data == null || fPort == null) throw new Error('data y fPort son obligatorios');
  const topic = expandDownlinkTopic(deveui, explicitTopic);
  const body = JSON.stringify({
    confirmed: Boolean(confirmed),
    fPort: typeof fPort === 'string' ? parseInt(fPort, 10) : fPort,
    data: String(data),
  });
  return withClient(
    (c) =>
      new Promise((resolve, reject) => {
        c.publish(topic, body, { qos: 0 }, (err) => (err ? reject(err) : resolve({ topic })));
      })
  );
}

/**
 * Publica petición NS (§7) y espera respuesta con el mismo id.
 * @param {{ id?: string, method: string, url: string, body?: object }} reqEnvelope
 */
function publishNsRequestAndWait(reqEnvelope, timeoutMs) {
  const reqTopic = process.env.MQTT_NS_REQUEST_TOPIC;
  const resTopic = process.env.MQTT_NS_RESPONSE_TOPIC;
  if (!reqTopic || !resTopic) {
    throw new Error('Defina MQTT_NS_REQUEST_TOPIC y MQTT_NS_RESPONSE_TOPIC');
  }
  const timeout = timeoutMs || parseInt(process.env.MQTT_NS_RESPONSE_TIMEOUT_MS || '20000', 10) || 20000;
  const id = reqEnvelope.id != null ? String(reqEnvelope.id) : `ns-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const msg = {
    id,
    method: reqEnvelope.method,
    url: reqEnvelope.url,
    ...(reqEnvelope.body !== undefined ? { body: reqEnvelope.body } : {}),
  };

  return withClient(
    (c) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingNs.has(id)) {
            pendingNs.delete(id);
            reject(new Error(`Timeout MQTT NS (${timeout} ms) para id=${id}`));
          }
        }, timeout);
        pendingNs.set(id, {
          timer,
          resolve: (body) => resolve(body),
        });
        c.publish(reqTopic, JSON.stringify(msg), { qos: 0 }, (err) => {
          if (err) {
            pendingNs.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      })
  );
}

function getMqttApiStatus() {
  const broker = Boolean(process.env.MQTT_BROKER_URL);
  return {
    brokerConfigured: broker,
    packageAvailable: Boolean(mqtt),
    downlink: Boolean(process.env.MQTT_DOWNLINK_TOPIC_TEMPLATE),
    nsRequest: Boolean(process.env.MQTT_NS_REQUEST_TOPIC && process.env.MQTT_NS_RESPONSE_TOPIC),
  };
}

module.exports = {
  publishDownlink,
  publishNsRequestAndWait,
  getMqttApiStatus,
  expandDownlinkTopic,
};
