# Canales en Syscom IoT: radio LoRaWAN vs plantilla vs transporte

En la UI y en los logs aparece la palabra **“canal”** en contextos distintos. Esta guía fija la terminología para no confundir **frecuencia/subbanda LoRaWAN** con el **metadato de aplicación** `device_decode_config.channel` ni con **puertos de red**.

---

## 1) Radio LoRaWAN: banda y plan (902–928 MHz, US915)

**Dónde vive:** motor LNS en Node (`server/lns/lorawan-lns-engine.js`, `server/lns/semtech-udp-lns.js`), plan regional (`server/lns/lorawan-regional-plan.js`), persistencia de sesión y gateways (`server/store.js`), rutas HTTP (`server/server.js`).

**Qué es:** el plan de frecuencias que usa el **network server** para RX1/RX2 programados, downlinks `imme` de referencia, coherencia con uplinks `rxpk.freq`, etc. En este repositorio el despliegue está acotado a **US915 (ISM 902–928 MHz)** en subbanda **FSB2**: canales **125 kHz 8–15** y, en paralelo, enlaces **500 kHz 65–70** (DR4). El **Join-Accept OTAA** incluye **CFList de 16 B** (ChMask) con esa subbanda salvo `SYSCOM_LNS_JOIN_CFLIST=0`. RX2 de referencia típica **923.3 MHz / SF12BW500** (ajustable con `SYSCOM_LNS_RX2_*` dentro del rango 902–928 MHz).

**Gateways:** el campo **`lorawan_gateways.frequency_band`** se guarda como **`US902-928-FSB2`** (único valor en UI). El API aún acepta temporalmente `US915` / `US902-928` y los normaliza a FSB2 al crear el registro. Definición en `server/lns/lorawan-gateway-bands.js` y `src/constants/lorawanGatewayBands.js`.

**No mezclar** con el campo `channel` del decoder en SQLite: aquí “banda / subbanda” = índices y MHz del **plan regional del gateway**, no el FPort de la capa de aplicación.

---

## 2) “Canal” de plantilla / aplicación: `device_decode_config.channel`

**Dónde vive:** tabla SQLite `device_decode_config` (columnas `channel`, `decoder_script`, …), plantillas en el cliente (`src/pages/TemplatesPage.jsx`, `src/constants/seedDeviceTemplates.js`, `src/services/deviceTemplates.js`).

**Qué es:** texto que el servidor interpreta sobre todo como **FPort de aplicación (1–223)** para:

- resolver el FPort del **downlink** LNS si el cuerpo del `POST` no trae `fPort` (`server/lib/resolve-app-fport.js`);
- coherencia con el **decoder** cuando el uplink no incluye `fPort` (misma resolución en ingesta).

**Regla:** **Canal (plantilla) ≠ MHz ≠ subbanda LoRaWAN del gateway.** Es un **metadato de codec/aplicación** (convención Milesight/ChirpStack: a menudo `85`, `1`, etc.).

---

## 3) Transporte: cómo llega el tráfico al LNS y a la app

| Mecanismo | Puerto / ruta | Uso |
|-----------|----------------|-----|
| **Semtech UDP GWMP** | `LNS_UDP_PORT` (por defecto **1700/udp**) | Gateway ↔ proceso Node: `PUSH_DATA` (uplinks), `PULL_DATA` / `PULL_RESP` (downlinks). `GW_TX_ACK` (`0x05`) lleva JSON de `txpk_ack` **embebido** en el datagrama GWMP (no es que todo el UDP sea JSON). |
| **HTTPS (API)** | TCP del `PORT` de la API | SPA e integraciones: `POST /api/devices/:deviceId/downlink`, ingesta, CRUD gateways, etc. |
| **SSE** | Misma API HTTP, stream de eventos | Tiempo real en el cliente (`src/components/SyscomRealtimeBridge.jsx` y pool en `server/realtime/`). |

---

## 4) Tabla rápida (regla de oro)

| Término “canal” / parecido | Dónde vive | Significado |
|----------------------------|------------|-------------|
| **Banda / FSB2** | `lorawan_gateways.frequency_band` + motor LNS | Plan **US915 FSB2**: 125 kHz **8–15** y 500 kHz **65–70** (902–928 MHz). |
| **Canal (plantilla)** / decode-config | `device_decode_config.channel`, plantillas | **FPort de aplicación** y convención del decoder; **no** es MHz. |
| **Puerto UDP** | `LNS_UDP_PORT` | **Transporte GWMP** hacia el LNS integrado. |

---

## 5) Criterio de éxito en código y UI

- La documentación y los mensajes de error distinguen **banda del gateway** vs **canal de plantilla (FPort)** vs **puerto UDP del LNS**.
- Las etiquetas del modal de decoder y de plantillas usan explícitamente **“Canal plantilla (FPort de aplicación)”** donde corresponde.
