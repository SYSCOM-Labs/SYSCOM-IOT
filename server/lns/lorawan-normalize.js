/**
 * Convierte uplinks típicos de gateways / application servers LoRaWAN
 * a un objeto plano compatible con extractIngestProperties / ingesta genérica.
 *
 * Milesight (NS embebido, HTTP dataUpURL): devEUI, payloadBase64, payloadHex,
 * payloadJson (string JSON tras el codec), gatewayMac, loraSNR, type (p. ej. UpUnc).
 *
 * UG63 / SG50 (MQTT aplicación): uplink con data (Base64), rxInfo[], txInfo{}; join; ack; gateway info.
 */

function bufToHex(buf) {
  return Buffer.from(buf).toString('hex');
}

/** Intenta leer DevAddr (4 B, LE) del PHYPayload LoRaWAN 1.0.x (sin validar MIC). */
function tryParseDevAddrFromPhyBase64(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 9) return null;
    const mhdr = buf[0];
    const ftype = mhdr & 0xff;
    if (ftype === 0x00 || ftype === 0x20) return null;
    // Data uplink: MHDR + DevAddr (4 LE) + …
    const devaddr = buf.slice(1, 5);
    return bufToHex(Buffer.from(devaddr).reverse()).toUpperCase();
  } catch {
    return null;
  }
}

function toFiniteNumber(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseLoRaMetric(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function parseMilesightPayloadJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw.trim()) : JSON.parse(String(raw));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return {};
}

function isMilesightEmbeddedNsShape(body) {
  if (!body || typeof body !== 'object') return false;
  const deui = String(body.devEUI || body.deveui || '').replace(/\s/g, '');
  if (!deui) return false;
  const hasMsPayload =
    body.payloadBase64 != null ||
    body.payloadHex != null ||
    (body.payloadJson != null && body.payloadJson !== '');
  if (hasMsPayload) return true;
  const t = String(body.type || '');
  if (/^up/i.test(t) && body.gatewayMac) return true;
  if (/^join/i.test(t) && body.gatewayMac) return true;
  return false;
}

function normalizeMilesightEmbeddedNsUplink(body) {
  if (!isMilesightEmbeddedNsShape(body)) return null;
  const deuiNorm = String(body.devEUI || body.deveui).replace(/\s/g, '').toLowerCase();
  const decoded = parseMilesightPayloadJson(body.payloadJson);
  const rssi = parseLoRaMetric(body.rssi);
  const loraSnr = parseLoRaMetric(body.loraSNR);
  const props = {
    ...decoded,
    devEUI: deuiNorm,
    deviceName: body.name || body.deviceName || deuiNorm,
    fCnt: toFiniteNumber(body.fCnt),
    fPort: toFiniteNumber(body.fPort),
    payload_b64: body.payloadBase64,
    payload_hex: body.payloadHex,
    rssi,
    lora_snr: loraSnr,
    gateway_id: body.gatewayMac,
    gateway_mac: body.gatewayMac,
    frequency_hz: toFiniteNumber(body.frequency),
    data_rate: body.dataRate,
    lorawan_packet_type: body.type,
    devAddr: body.devAddr,
    appEUI: body.appEUI,
    mic: body.mic,
    adr: body.adr,
    class_type: body.classType,
    received_at: body.time,
    connectStatus: /^join/i.test(String(body.type || '')) ? 'joined' : 'online',
    source: 'milesight_gateway',
  };
  Object.keys(props).forEach((k) => {
    if (props[k] === undefined) delete props[k];
  });
  return {
    deviceId: deuiNorm,
    deviceName: props.deviceName,
    devEUI: deuiNorm,
    properties: props,
    ...props,
  };
}

/**
 * Milesight y otros LNS pueden enviar `{ "packets": [ { ...uplink }, ... ] }`.
 * @param {object} body
 * @returns {object[]}
 */
function expandLorawanPacketBodies(body) {
  if (!body || typeof body !== 'object') return [body];
  if (Array.isArray(body.packets) && body.packets.length > 0) {
    return body.packets.filter((p) => p && typeof p === 'object');
  }
  /** Semtech GWMP: un PUSH_DATA puede traer varios `rxpk`; normalizar uno a uno. */
  if (Array.isArray(body.rxpk) && body.rxpk.length > 1) {
    return body.rxpk.map((pk) => ({ ...body, rxpk: [pk] }));
  }
  return [body];
}

/**
 * UG65/UG67 API: GET /api/devices/{devEUI}/data → { result: { payloadJSON: "…" } }
 * o streaming /api/urpackets con { result: { … campos uplink … } }.
 */
function normalizeUgApiPayloadJsonInner(inner) {
  if (!inner || typeof inner !== 'object') return null;
  const deui = String(inner.devEUI || inner.deveui || '').replace(/\s/g, '').toLowerCase();
  if (!deui) return null;
  const rxInfo = Array.isArray(inner.rxInfo)
    ? inner.rxInfo.map((rx) => ({
        gatewayID: rx.mac || rx.gatewayID || rx.gatewayId,
        gatewayId: rx.mac || rx.gatewayId,
        rssi: rx.rssi,
        loRaSNR: rx.loRaSNR != null ? rx.loRaSNR : rx.snr,
        uplinkID: rx.uplinkID,
        time: rx.time,
      }))
    : [];
  const baseObject =
    inner.object && typeof inner.object === 'object' && !Array.isArray(inner.object) ? { ...inner.object } : {};
  if (inner.time != null) baseObject.ug_api_received_at = inner.time;
  if (inner.applicationID != null) baseObject.applicationID = inner.applicationID;
  if (inner.applicationName != null) baseObject.applicationName = inner.applicationName;
  if (inner.source) baseObject.source = inner.source;
  if (inner.txInfo && typeof inner.txInfo === 'object') {
    const tx = inner.txInfo;
    if (tx.frequency != null) baseObject.tx_frequency_hz = tx.frequency;
    if (tx.adr != null) baseObject.tx_adr = tx.adr;
    if (tx.codeRate != null) baseObject.tx_code_rate = tx.codeRate;
    if (tx.dataRate && typeof tx.dataRate === 'object') {
      if (tx.dataRate.spreadFactor != null) baseObject.tx_spreading_factor = tx.dataRate.spreadFactor;
      if (tx.dataRate.bandwidth != null) baseObject.tx_bandwidth = tx.dataRate.bandwidth;
      if (tx.dataRate.modulation != null) baseObject.tx_modulation = tx.dataRate.modulation;
    }
  }
  const chirpLike = {
    devEUI: deui,
    deviceName: inner.deviceName || inner.device_name || deui,
    data: inner.data,
    fCnt: inner.fCnt,
    fPort: inner.fPort,
    object: baseObject,
    rxInfo,
    applicationID: inner.applicationID,
    applicationName: inner.applicationName,
    txInfo: inner.txInfo,
    source: inner.source || 'milesight_ug_api',
    ug_api_time: inner.time,
  };
  return normalizeLorawanUplink(chirpLike);
}

/** UG63/SG50 MQTT §2: application uplink (incluye txInfo y applicationID). */
function isMilesightUg63Sg50AppUplink(body) {
  if (!body || typeof body !== 'object') return false;
  const deui = String(body.devEUI || '').replace(/\s/g, '');
  if (!deui) return false;
  if (body.data == null || typeof body.data !== 'string') return false;
  if (!Array.isArray(body.rxInfo)) return false;
  if (!body.txInfo || typeof body.txInfo !== 'object') return false;
  return true;
}

function normalizeMilesightUg63Sg50AppUplink(body) {
  if (!isMilesightUg63Sg50AppUplink(body)) return null;
  const inner = { ...body, source: 'milesight_ug63_mqtt' };
  return normalizeUgApiPayloadJsonInner(inner);
}

/** §4 Join notification (sin payload data). */
function normalizeMilesightUg63MqttJoin(body) {
  if (!body || typeof body !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(body, 'data') && body.data != null && String(body.data).length > 0) {
    return null;
  }
  const deui = String(body.devEUI || '').replace(/\s/g, '').toLowerCase();
  if (!deui) return null;
  const devAddr = String(body.devAddr || '').replace(/\s/g, '');
  if (!devAddr) return null;
  if (body.applicationID == null && body.applicationName == null) return null;
  const props = {
    devEUI: deui,
    deviceName: body.deviceName || deui,
    devAddr,
    applicationID: body.applicationID,
    applicationName: body.applicationName,
    received_at: body.time,
    connectStatus: 'joined',
    mqtt_event: 'join',
    source: 'milesight_ug63_mqtt',
  };
  Object.keys(props).forEach((k) => props[k] === undefined && delete props[k]);
  return { deviceId: deui, deviceName: props.deviceName, devEUI: deui, properties: props, ...props };
}

/** §5 ACK de downlink confirmado. */
function normalizeMilesightUg63MqttAck(body) {
  if (!body || typeof body !== 'object') return null;
  if (!('acknowledged' in body) || typeof body.acknowledged !== 'boolean') return null;
  const deui = String(body.devEUI || '').replace(/\s/g, '').toLowerCase();
  if (!deui) return null;
  const props = {
    devEUI: deui,
    deviceName: body.deviceName || deui,
    downlink_acknowledged: body.acknowledged,
    fCnt: toFiniteNumber(body.fCnt),
    applicationID: body.applicationID,
    applicationName: body.applicationName,
    received_at: body.time,
    mqtt_event: 'downlink_ack',
    connectStatus: 'online',
    source: 'milesight_ug63_mqtt',
  };
  Object.keys(props).forEach((k) => props[k] === undefined && delete props[k]);
  return { deviceId: deui, deviceName: props.deviceName, devEUI: deui, properties: props, ...props };
}

/** §6 Información del gateway (pseudo-dispositivo por EUI del gateway). */
function normalizeMilesightUg63GatewayInfo(body) {
  if (!body || typeof body !== 'object') return null;
  const di = body.device_info;
  if (!di || typeof di !== 'object') return null;
  const eui = String(di.eui || di.gateway_id || '').replace(/\s/g, '').toLowerCase();
  if (!eui) return null;
  const gid = `gateway-${eui}`;
  const props = {
    devEUI: gid,
    deviceName: di.model ? `GW ${di.model}` : `Gateway ${eui}`,
    gateway_eui: eui,
    mqtt_event: 'gateway_info',
    connectStatus: 'online',
    source: 'milesight_ug63_mqtt',
    tunnel_support: body.tunnel_support,
    device_info: di,
    network_info: body.network_info,
  };
  if (body.battery_info && typeof body.battery_info === 'object') props.battery_info = body.battery_info;
  return { deviceId: gid, deviceName: props.deviceName, devEUI: gid, properties: props, ...props };
}

function unwrapMilesightUgApiEnvelope(body) {
  if (!body || typeof body !== 'object' || !body.result || typeof body.result !== 'object') return null;
  const r = body.result;
  if (typeof r.payloadJSON === 'string' && r.payloadJSON.trim() !== '') {
    const inner = parseMilesightPayloadJson(r.payloadJSON);
    if (inner && typeof inner === 'object') {
      const t = String(inner.type || '').toLowerCase();
      if (t === 'uplink' || inner.devEUI) {
        const n = normalizeUgApiPayloadJsonInner(inner);
        if (n) return n;
      }
    }
  }
  if (r.devEUI && (r.payloadBase64 != null || r.payloadHex != null || (r.payloadJson != null && r.payloadJson !== ''))) {
    return normalizeMilesightEmbeddedNsUplink(r);
  }
  return null;
}

/**
 * @param {object} body
 * @returns {object} cuerpo normalizado para saveIngestEntry
 */
function normalizeLorawanUplink(body) {
  if (!body || typeof body !== 'object') return body;

  const ugApi = unwrapMilesightUgApiEnvelope(body);
  if (ugApi) return ugApi;

  const gwInfo = normalizeMilesightUg63GatewayInfo(body);
  if (gwInfo) return gwInfo;

  const mqttAck = normalizeMilesightUg63MqttAck(body);
  if (mqttAck) return mqttAck;

  const mqttJoin = normalizeMilesightUg63MqttJoin(body);
  if (mqttJoin) return mqttJoin;

  const ug63Uplink = normalizeMilesightUg63Sg50AppUplink(body);
  if (ug63Uplink) return ug63Uplink;

  const milesight = normalizeMilesightEmbeddedNsUplink(body);
  if (milesight) return milesight;

  // ── ChirpStack application HTTP integration (v3/v4) ─────────────
  const deui = (body.devEUI || body.deveui || body.deviceInfo?.devEui || '').toString().replace(/\s/g, '');
  if (deui) {
    const deuiNorm = deui.toLowerCase();
    const decoded = body.object || body.decoded || {};
    const props = {
      ...decoded,
      devEUI: deuiNorm,
      deviceName: body.deviceName || body.deviceInfo?.deviceName || deuiNorm,
      fCnt: body.fCnt,
      fPort: body.fPort,
      dr: body.dr,
      adr: body.adr,
      confirmed: body.confirmed,
    };
    if (body.data) props.payload_b64 = body.data;
    if (Array.isArray(body.rxInfo) && body.rxInfo.length) {
      const rx = body.rxInfo[0];
      props.gateway_id = rx.gatewayID || rx.gatewayId;
      props.rssi = rx.rssi;
      props.lora_snr = rx.loRaSNR != null ? rx.loRaSNR : rx.snr;
      props.uplink_id = rx.uplinkID;
    }
    props.connectStatus = 'online';
    return {
      deviceId: deuiNorm,
      deviceName: props.deviceName,
      devEUI: deuiNorm,
      properties: props,
      ...props,
    };
  }

  // ── The Things Stack / similar (device_ids.dev_eui) ────────────────
  if (body.end_device_ids?.dev_eui) {
    const eui = String(body.end_device_ids.dev_eui).replace(/\s/g, '').toLowerCase();
    const u = body.uplink_message || {};
    const decoded = u.decoded_payload || {};
    const props = {
      ...decoded,
      devEUI: eui,
      deviceName: body.end_device_ids.device_id || eui,
      fCnt: u.f_cnt,
      fPort: u.f_port,
      payload_b64: u.frm_payload,
    };
    if (u.rx_metadata && u.rx_metadata.length) {
      props.gateway_id = u.rx_metadata[0].gateway_ids?.gateway_id;
      props.rssi = u.rx_metadata[0].rssi;
      props.lora_snr = u.rx_metadata[0].snr;
    }
    props.connectStatus = 'online';
    return { deviceId: eui, deviceName: props.deviceName, devEUI: eui, ...props };
  }

  // ── Semtech JSON (gateway → servidor): array rxpk ─────────────────
  if (Array.isArray(body.rxpk) && body.rxpk.length > 0) {
    const gw = (body.gateway_id || body.gwid || body.EUI || 'gateway').toString();
    const first = body.rxpk[0];
    let devAddr = null;
    if (first.data) {
      devAddr = tryParseDevAddrFromPhyBase64(first.data);
    }
    const deviceKey = devAddr ? `devaddr-${devAddr}` : `${gw}-${first.tmst || Date.now()}`;
    let payloadHex = '';
    try {
      payloadHex = Buffer.from(first.data || '', 'base64').toString('hex');
    } catch (_) {}

    const props = {
      gateway_id: gw,
      rxpk_count: body.rxpk.length,
      freq_mhz: first.freq,
      rssi: first.rssi,
      lora_snr: first.lsnr,
      datr: first.datr,
      codr: first.codr,
      tmst: first.tmst,
      payload_hex: payloadHex,
      payload_b64: first.data,
      devAddr: devAddr || undefined,
      connectStatus: 'online',
    };

    return {
      deviceId: deviceKey,
      deviceName: devAddr ? `DevAddr ${devAddr}` : `Gateway ${gw}`,
      devEUI: deviceKey,
      ...props,
    };
  }

  return body;
}

module.exports = { normalizeLorawanUplink, tryParseDevAddrFromPhyBase64, expandLorawanPacketBodies };
