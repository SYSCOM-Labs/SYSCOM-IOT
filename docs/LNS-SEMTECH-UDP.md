# LNS integrado — Semtech UDP (GWMP)

**Terminología:** no confundir **banda del gateway** (902–928 MHz, `frequency_band`) con el **«canal» de plantilla** en decode-config (**FPort de aplicación**) ni con el **puerto UDP** (`LNS_UDP_PORT`). Ver [LORAWAN-CHANNELS-VS-APP.md](./LORAWAN-CHANNELS-VS-APP.md).

## Comportamiento por defecto (US915 + LNS encendido)

- **Plan regional:** **solo US915** (902–928 MHz). El stack usa **RX2 de referencia 923.3 MHz / SF12BW500** para downlinks `imme` y ventanas RX2, salvo que defina `SYSCOM_LNS_RX2_DATR` o `SYSCOM_LNS_RX2_CODR`. Si define `SYSCOM_LNS_RX2_FREQ`, debe estar **entre 902 y 928 MHz** (valores fuera de rango se recortan). `SYSCOM_LNS_PLAN` con valor no-US se ignora (aviso en log).
- **UDP Semtech:** si no define `LNS_UDP_PORT`, el servidor escucha **`1700/udp`** y carga el motor MAC/join/downlink en el mismo proceso (`npm start`). No hace falta checklist manual en cada arranque.
- **Desactivar UDP** solo donde no haya UDP entrante (p. ej. PaaS solo HTTP): `LNS_UDP_PORT=0` o `off` / `false` / `disabled`. En ese caso **no** presente el despliegue como “LNS GWMP listo”: use ingesta HTTPS/MQTT, relay UDP o una VM/bare metal con IP pública y reenvío de puertos.
- **Motor MAC:** activo salvo `SYSCOM_LNS_MAC=0` (solo entonces la ingesta LoRaWAN cifrada queda desactivada).
- **GW_TX_ACK (`0x05`):** el JSON (p. ej. `txpk_ack`) va **solo** en los bytes del datagrama **después** de la cabecera GWMP (versión 1 B, token 2 B, tipo `0x05`, EUI gateway 8 B → **offset 12**); no parsear el buffer UDP entero como JSON. Con el motor activo, `getLnsEngine()` publica **`globalThis.lnsEngine`**. **`handleTxAck`** ejecuta primero **`store.lnsHandleGatewayTxAck`** (inflight, `fcnt_down`, reintentos / reencola con `SYSCOM_LNS_TX_ACK_RETRY_MS`) y después inserta eventos UI/SSE: **`downlink_gateway_tx_ack`** (éxito) o **`downlink_gateway_tx_reject`** (error `txpk_ack`, p. ej. `TOO_LATE`, `TX_FREQ`). El listener UDP llama a `handleTxAck` dentro de `try/catch`.
- **Join-Accept US915 FSB2:** el motor incluye **CFList de 16 B** (ChMask0–ChMask4 + RFU) para habilitar canales 125 kHz **8–15** y 500 kHz **65–70**, salvo `SYSCOM_LNS_JOIN_CFLIST=0` si un nodo no acepta CFList.

### Cómo comprobar que un gateway US915 habla con el LNS

1. Arranque del servidor: en consola deben aparecer líneas **`[LNS] Motor MAC / join / downlink: ACTIVO`** y **`[LNS] Listener UDP Semtech GWMP: 0.0.0.0:1700`**, y al enlazar el socket **`[LNS-UDP] Semtech GWMP activo`** con el plan y RX2 efectivo.
2. En la app: **Gateways LoRaWAN** → alta con EUI real y banda **US902-928-FSB2** (US915 subbanda FSB2: canales 125 kHz 8–15 y 500 kHz 65–70). El API puede normalizar alias `US915` / `US902-928` a FSB2 al guardar.
3. En el packet forwarder: **servidor** = IP/DNS del host, **puerto up/down** = `LNS_UDP_PORT` (1700 por defecto). Firewall/NAT: **UDP** abierto hacia ese puerto.
4. Tras un uplink o join: telemetría o eventos en el panel; en logs, actividad `[LNS]` / `[LNS-UDP]` sin “Gateway no registrado”.

---

SYSCOM IoT puede actuar como **network server propio** (sin ChirpStack/TTN) para **LoRaWAN 1.0.x** sobre el protocolo **Semtech UDP**:

- **OTAA**: Join-Request / Join-Accept (MIC con `AppKey`, sesión `NwkSKey`/`AppSKey` en SQLite).
- **Uplink datos**: verificación MIC, descifrado FRMPayload, contador `FCnt` básico, telemetría + decoders existentes.
- **Downlink**: cola en BD + envío en **PULL_RESP** (tras **PULL_DATA** del gateway). Muchos gateways responden con **GW_TX_ACK** (`0x05`) indicando si aceptó el `txpk` (p. ej. `TOO_LATE`, `TX_FREQ`, o éxito). Algunos equipos (p. ej. **Milesight UG65**) pueden **no enviar `txpk_ack` fiable por UDP**; en ese caso conviene dejar el tracking **desactivado** (por defecto **apagado** desde código: el **`fcnt_down`** se confirma al encolar). Si activa el tracking (`SYSCOM_LNS_APP_DOWNLINK_TX_ACK=1` o `SYSCOM_LNS_TX_ACK_ENABLED=1` o legado `SYSCOM_LNS_TX_ACK=1`), los downlinks **de aplicación** no actualizan **`fcnt_down`** hasta un ACK exitoso; si el gateway rechaza el envío, se **reencola el mismo `PULL_RESP`**. El **Join-Accept** no usa esta ruta (sigue marcándose `sent` al enviar). Opcionalmente, por cada **PULL_DATA** se pueden enviar varios **PULL_RESP** (`SYSCOM_LNS_PULL_BURST`; por defecto **1**). La cola ordena por **`priority`** y antigüedad. API: `POST /api/devices/:deviceId/downlink` con `fPort` y `payloadHex`; opcionales: **`confirmed`**, **`delayMs`**, **`priority`**. Para **borrar la sesión LNS** (p. ej. corregir `rx_delay_sec`): **`DELETE /api/devices/:deviceId/lns/session`**, luego reinicie el nodo para OTAA de nuevo. Si hay un downlink en vuelo esperando TX_ACK, la API puede responder **429** (`DOWNLINK_IN_FLIGHT`).

## Puerto UDP (activo por defecto)

No es obligatorio definir nada: **`npm start`** ya abre **UDP 1700** y el motor MAC.

Para otro puerto:

```bash
set LNS_UDP_PORT=1780
npm start
```

Linux/macOS: `export LNS_UDP_PORT=1780`

## Variables útiles

| Variable | Descripción |
|----------|-------------|
| `SYSCOM_LNS_PLAN` | Solo **US915**; otros valores se ignoran. RX2 por defecto 923.3 / SF12BW500 salvo `SYSCOM_LNS_RX2_*` (frecuencia recortada a 902–928 MHz). |
| `LNS_UDP_PORT` | Puerto GWMP; por defecto **1700**. `0` / `off` / `false` / `disabled` = sin listener UDP. |
| `SYSCOM_LNS_MAC=0` | Desactiva el motor MAC (solo ingesta legada sin cifrado). |
| `SYSCOM_LNS_NET_ID` | NetID 6 hex (3 B), por defecto `000001`. |
| `SYSCOM_LNS_RX1_DELAY_US` | Si está definida (p. ej. **`5000000`**), **anula** el retardo RX1: siempre **5 000 000 µs (5 s)** respecto al `tmst` del último uplink en RX1. Si **no** está definida, RX1 usa **`rx_delay_sec` × 1e6 µs** desde la sesión (Join-Accept; por defecto **5 s** en sesión). |
| `SYSCOM_LNS_RX2_FREQ` / `SYSCOM_LNS_RX2_DATR` / `SYSCOM_LNS_RX2_CODR` | Parámetros para downlink **inmediato** (`imme`) y para la ventana **RX2 programada** (clase A con `SYSCOM_LNS_CLASS_A_RX_WINDOW=RX2`). |
| `SYSCOM_LNS_TX_POWER` | `powe` en `txpk`, por defecto `14`. |
| `SYSCOM_LNS_RX_DELAY_SEC` | RxDelay en Join-Accept (1–15; `0` en aire → 1 s en sesión). **Por defecto en el motor: 5** (US915 típico). Se guarda como **`rx_delay_sec`** en `lorawan_lns_sessions`. |
| `SYSCOM_LNS_RX2_AFTER_RX1_SEC` | Segundos entre el inicio de RX1 y el `tmst` de la ventana **RX2 programada** (clase A), por defecto `1`. |
| `SYSCOM_LNS_CLASS_A_RX_WINDOW` | `RX1` (por defecto) o `RX2`: el downlink clase A se programa en la primera o segunda ventana con **`imme: false`** y **`tmst`** respecto al último uplink. |
| `SYSCOM_LNS_CLASS_A_UPLINK_GRACE_MS` | Margen adicional (ms) tras el **RxDelay** (s) de sesión para aceptar el downlink API tras el uplink; por defecto **2000**. El máximo permitido es `rx_delay_sec × 1000 + grace` ms desde `last_uplink_wall_ms`. |
| `SYSCOM_LNS_PULL_BURST` | Máximo de **PULL_RESP** enviados por cada **PULL_DATA** (1–20), por defecto `1`. Sube solo si tu forwarder acepta varios por ciclo. |
| `SYSCOM_LNS_APP_DOWNLINK_TX_ACK` | Si está definido, manda sobre el resto: `1` = exigir **GW_TX_ACK** para downlinks de aplicación (FCnt tras ACK); `0` = no rastrear. |
| `SYSCOM_LNS_TX_ACK_ENABLED` | Igual que arriba si **no** definió `SYSCOM_LNS_APP_DOWNLINK_TX_ACK`. |
| `SYSCOM_LNS_TX_ACK` | **Legado.** Solo se consulta si no hay `SYSCOM_LNS_APP_DOWNLINK_TX_ACK` ni `SYSCOM_LNS_TX_ACK_ENABLED`. Por defecto (todo sin definir) el tracking queda **apagado**; `1` lo activa. |
| `SYSCOM_LNS_TX_ACK_MAX_RETRIES` | Reintentos tras rechazo TX_ACK, por defecto `3`. |
| `SYSCOM_LNS_TX_ACK_RETRY_MS` | Retardo antes de volver a poner el mismo `txpk` en cola (ms), por defecto `750`. |
| `SYSCOM_LNS_JOIN_CFLIST` | Por defecto activo: Join-Accept lleva **CFList 16 B** (ChMask FSB2: 125 kHz 8–15 y 500 kHz 65–70). `0` / `false` / `off` = sin CFList (compatibilidad con nodos que fallan con máscara). |
| `SYSCOM_LNS_TX_ACK_TIMEOUT_MS` | Reservado / documentación operativa; el motor no expira inflight por tiempo (desactive tracking si el GW no envía ACK). |
| `SYSCOM_LNS_CLASS_C_TX_GAP_MS` | Si > 0, espacio mínimo entre downlinks **clase C** encolados hacia el mismo gateway (`not_before_ms`), por defecto `0`. |
| `SYSCOM_LNS_TX_RFCH_IMME_US915` | Si está definido, `rfch` en `txpk` con **`imme: true`** (p. ej. `0` en US915). |
| `SYSCOM_LNS_CLASSB_BEACON_PERIOD_MS` | Periodo aproximado de alineación clase **B** (ms), por defecto `128000` (128 s, típico beacon LoRaWAN). |

## Clase A, B y C (dispositivo)

En el alta/edición vía **`POST /api/user-devices`** puede enviarse **`lorawanClass`**: `"A"`, `"B"` o `"C"` (se guarda en `user_devices` y se copia a la sesión LNS al hacer **join**). También puede actualizarse después con el mismo endpoint si ya existe sesión (se sincroniza `device_class` en `lorawan_lns_sessions`).

| Clase | Comportamiento del LNS (downlink aplicación) |
|-------|-----------------------------------------------|
| **A** | Siempre **`imme: false`**: el `txpk` se programa con **`tmst`** en **RX1** o **RX2** según `SYSCOM_LNS_CLASS_A_RX_WINDOW`, usando el `tmst` del último `rxpk` y el **`rx_delay_sec`** de la sesión (Join-Accept). Requiere uplink reciente (`rx_delay_sec` + margen `SYSCOM_LNS_CLASS_A_UPLINK_GRACE_MS`) y `last_rx_tmst` válido (> 0); si no, la API responde error (`CLASS_A_STALE_UPLINK`, `CLASS_A_NO_RXTMST`, etc.). Tras un **uplink confirmado**, el siguiente downlink lleva **ACK MAC** (`FCtrl.ACK`) hasta que se envía. |
| **C** | **`imme: true`** (transmisión inmediata en RX2 del plan regional). Opcional: **`SYSCOM_LNS_CLASS_C_TX_GAP_MS`** para separar envíos hacia el mismo gateway. |
| **B** | Cola con **`not_before_ms`**: alineación aproximada a ping slots usando `class_b_ping_periodicity` (aprendido del **PingSlotInfoAns** en MAC, FPort 0) o, si aún no se conoce, al periodo `SYSCOM_LNS_CLASSB_BEACON_PERIOD_MS`. Opcional en **`POST .../downlink`**: **`delayMs`** para fijar el envío en milisegundos desde ahora. |

**Nota clase B:** un despliegue **totalmente conforme** con LoRaWAN Clase B exige **beacon** en el gateway y fase acotada; aquí se ofrece **compatibilidad operativa** (cola diferida + parámetros MAC) mejorable con gateway beacon y afinado de tiempos en entornos exigentes.

## Dispositivo OTAA en la app

En el alta/edición del dispositivo deben coincidir con el nodo físico:

- **DevEUI** (16 hex)
- **AppEUI / JoinEUI** (16 hex) — columna `app_eui`
- **AppKey** (32 hex) — columna `app_key`

Sin eso el Join-Request se rechaza (no hay clave para validar MIC ni generar Join-Accept).

## Configuración del gateway

1. En la app: **Gateways LoRaWAN** → alta del gateway con el **mismo EUI** que muestra el equipo (p. ej. `24E124FFFEF9A1E2`).
2. En el gateway: **Packet Forward → Semtech**
   - **Server Address:** IP pública o DNS del host donde corre Node (debe ser alcanzable por **UDP** desde el gateway).
   - **Port Up / Port Down:** igual que `LNS_UDP_PORT` (habitualmente **1700**).

## Multi-tenant

El EUI de 8 bytes del paquete GWMP se compara con `lorawan_gateways` para saber a qué usuario pertenece la ingesta. Si hay más de un usuario con el mismo EUI, se usa el primero y se deja aviso en log.

## Desarrollo sin alta de gateway

```bash
set SYSCOM_LNS_DEFAULT_USER_ID=tu_id_de_usuario
set LNS_UDP_PORT=1700
npm start
```

Solo para pruebas: acepta PUSH_DATA aunque el EUI no esté registrado.

## Limitaciones / siguiente iteración

- **LoRaWAN 1.1**, **ADR completo**, la mayoría de **MAC commands** (salvo detección de **PingSlotInfoAns**), y **rejoin** avanzado no están al nivel de un stack certificable. Los downlinks pueden enviarse como **Confirmed Data Down** (`confirmed: true` en la API); el **ACK MAC** al uplink confirmado se incluye en el siguiente downlink. Tras un reinicio del servidor puede quedar un downlink en `await_tx_ack` sin fila en `lorawan_lns_tx_inflight`: en ese caso conviene revisar la BD o dejar el tracking **desactivado** (por defecto) o `SYSCOM_LNS_TX_ACK=0` / `SYSCOM_LNS_TX_ACK_ENABLED=0`.
- **FCnt** 32 bits y deduplicación multi-gateway fina pueden requerir más lógica en despliegues grandes.
- **Clase B**: la alineación a beacon/ping es **aproximada** salvo integración explícita con beacon del gateway y NTP/GPS en el NS.

## Alojamiento

- **Render / PaaS HTTP:** no sirve para UDP; usa las URLs HTTPS de **Ajustes** o despliega el backend en una VM con UDP abierto.
- **Firewall / NAT:** abre **UDP** hacia `LNS_UDP_PORT` hacia la máquina del servidor.

### PM2, systemd o Kubernetes

No se necesita un proceso aparte para el LNS: **el mismo `node … server/server.js`** abre HTTP y, por defecto, **UDP 1700**. En PM2 o systemd use el mismo comando y el mismo fichero de entorno (con `JWT_SECRET`, `SYSCOM_LNS_PLAN`, etc.). En Kubernetes exponga **dos puertos** del pod (TCP `PORT` y UDP `LNS_UDP_PORT`) y un `Service` tipo LoadBalancer que soporte **UDP** hacia el nodo correcto.
