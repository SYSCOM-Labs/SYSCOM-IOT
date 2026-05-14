# LNS integrado — Semtech UDP (GWMP)

Syscom IoT puede actuar como **network server propio** (sin ChirpStack/TTN) para **LoRaWAN 1.0.x** sobre el protocolo **Semtech UDP**:

- **OTAA**: Join-Request / Join-Accept (MIC con `AppKey`, sesión `NwkSKey`/`AppSKey` en SQLite).
- **Uplink datos**: verificación MIC, descifrado FRMPayload, contador `FCnt` básico, telemetría + decoders existentes.
- **Downlink**: cola en BD + envío en **PULL_RESP** (tras **PULL_DATA** del gateway). El gateway responde con **GW_TX_ACK** (`0x05`) indicando si aceptó el `txpk` (p. ej. `TOO_LATE`, `TX_FREQ`, o éxito). El JSON con `txpk_ack` va **en los bytes 12+ del paquete UDP**, no como datagrama JSON completo. Con **`SYSCOM_LNS_TX_ACK=1`** (por defecto), los downlinks **de aplicación** no actualizan **`fcnt_down`** en sesión hasta un ACK exitoso; si el gateway rechaza el envío, se **reencola el mismo `PULL_RESP`** (mismo FCnt en el aire) hasta agotar reintentos. El **Join-Accept** no usa esta ruta (sigue marcándose `sent` al enviar). Opcionalmente, por cada **PULL_DATA** se pueden enviar varios **PULL_RESP** (`SYSCOM_LNS_PULL_BURST`; por defecto **1**). La cola ordena por **`priority`** y antigüedad. **API (único NS LoRaWAN en la app):** `POST /api/devices/:deviceId/downlink` con `fPort` y **`payloadHex`** o **`payloadBase64`**; opcionales: **`confirmed`**, **`delayMs`**, **`priority`**. Integraciones: **`POST /api/lns/integration-tokens`** (JWT staff) y **`POST /api/lns/v1/devices/:devEUI/queue`** (Bearer del token). Respuesta JSON incluye **`txAckPending`** (boolean) y, si aplica, **`txAckMaxWaitMs`** (aprox. ms hasta liberación sin GW_TX_ACK, alineado con `SYSCOM_LNS_TX_ACK_TIMEOUT_MS` / `SYSCOM_LNS_TX_ACK_SILENCE_MS`). Si hay un downlink en vuelo esperando TX_ACK, la API puede responder **429** (`DOWNLINK_IN_FLIGHT`).

## Activar UDP

```bash
set LNS_UDP_PORT=1700
npm start
```

Linux/macOS: `export LNS_UDP_PORT=1700`

## Variables útiles

| Variable | Descripción |
|----------|-------------|
| `SYSCOM_LNS_MAC=0` | Desactiva el motor MAC (solo ingesta legada sin cifrado). |
| `SYSCOM_LNS_LOG_NO_SESSION` | Si vale **`0`**, no se escribe en consola el aviso «Data up sin sesión» (nodos sin sesión en la cuenta / radio vecina). |
| `SYSCOM_LNS_NO_SESSION_ANY_LOG_MS` | Mínimo entre dos avisos «sin sesión» **para la misma cuenta** (cualquier DevAddr), por defecto **120000** (2 min). Evita ráfagas cuando muchos DevAddr ajenos llegan al gateway. |
| `SYSCOM_LNS_GUEST_UPLINK_LOG_MS` | Mínimo entre avisos **por el mismo DevAddr** sin sesión, por defecto **300000** (5 min). |
| `SYSCOM_LNS_NET_ID` | NetID 6 hex (3 B), por defecto `000001`. |
| `SYSCOM_LNS_RX1_DELAY_US` | Si está definida, **anula** el retardo RX1 (µs) respecto al `tmst` del último uplink, en lugar de `rx_delay_sec × 1e6` de sesión. Valor por defecto si el parse falla: **5_000_000** µs (5 s, típ. US915 cuando se fuerza override). Si **no** está definida, RX1 = `rx_delay_sec × 1e6` µs (negociado en Join-Accept). |
| `SYSCOM_LNS_RX2_FREQ` / `SYSCOM_LNS_RX2_DATR` / `SYSCOM_LNS_RX2_CODR` | Si **definidos**, sustituyen RX2 / `imme` para **todos** los planes. Si no, el motor elige por banda del gateway (`lorawan_gateways.frequency_band`) o frecuencia de uplink: **US915** (p. ej. `US902-928-FSB2`) → **923.3 MHz** y **SF12BW500**; **EU868** → 869.525 MHz y SF12BW125. |
| `SYSCOM_LNS_RX2_FREQ_US` / `SYSCOM_LNS_RX2_DATR_US` | Opcional: override solo **US915** cuando no usa el bloque global `SYSCOM_LNS_RX2_*`. |
| `SYSCOM_LNS_TX_POWER` | `powe` en `txpk`, por defecto `14`. |
| `SYSCOM_LNS_RX_DELAY_SEC` | RxDelay en Join-Accept (1–15; `0` en aire significa 1 s). Se guarda en sesión como **`rx_delay_sec`** para alinear downlinks clase A en RX1. |
| `SYSCOM_LNS_RX2_AFTER_RX1_SEC` | Segundos entre el inicio de RX1 y el `tmst` de la ventana **RX2 programada** (clase A), por defecto `1`. |
| `SYSCOM_LNS_CLASS_A_RX_WINDOW` | `RX1` (por defecto) o `RX2`: con uplink reciente, el downlink clase A se programa en la primera o segunda ventana de recepción (RX2 usa `SYSCOM_LNS_RX2_*` y `tmst` diferido). |
| `SYSCOM_LNS_CLASS_A_RX1_WINDOW_MS` | Tras un uplink, ventana (ms) en la que el downlink puede usar **RX1/RX2 programado** (`tmst`). Si **expira** sin uplink nuevo, la API responde **400** (`CLASS_A_RX_WINDOW_CLOSED`). Si hay uplink reciente pero el GW no mandó **`rxpk.tmst`**, **400** (`CLASS_A_MISSING_GATEWAY_TMST`): clase A **no** usa `imme`. |
| `SYSCOM_LNS_PRUNE_AWAIT_TX_ACK_MS` | Antigüedad (ms) para borrar **`await_tx_ack`** con fila `tx_inflight` aún presente pero sin ACK (defecto **180000** = 3 min). Además, al encolar se borran siempre los **`await_tx_ack` fantasma** (sin fila en `lorawan_lns_tx_inflight`, p. ej. tras reinicio del servidor). |
| `SYSCOM_LNS_CLASS_C_TX_GAP_MS` | Hueco mínimo entre downlinks **clase C** `imme` al mismo gateway (ms), por defecto **800** (reduce **TOO_LATE** en UG65 / dual-radio). |
| `SYSCOM_LNS_PULL_BURST` | Máximo de **PULL_RESP** enviados por cada **PULL_DATA** (1–20), por defecto `1`. Sube solo si tu forwarder acepta varios por ciclo. |
| `SYSCOM_LNS_TX_ACK_ENABLED` | Si está definido, **sustituye** a `SYSCOM_LNS_TX_ACK` (`1`/`true` = esperar GW_TX_ACK correlacionado). |
| `SYSCOM_LNS_TX_ACK` | `1` (por defecto): confirma **FCnt down** solo tras **TX_ACK** exitoso del gateway; reintentos sin cambiar el frame. **`0`**: no espera GW_TX_ACK (pruebas si el forwarder no manda `txpk_ack`). |
| `SYSCOM_LNS_APP_DOWNLINK_TX_ACK` | Si **`0`**: downlinks de **aplicación** (API/UI) no esperan GW_TX_ACK. Si **`1`**/`true`: sí esperan (si el tracking global está activo). **Sin definir**: clase **A/B** hereda `SYSCOM_LNS_TX_ACK`; clase **C** no espera ACK por defecto (fiabilidad con `imme` / gateways que ACK tarde). |
| `SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST` | **`1`**: clase **C** construye `txpk` con **`tmst`** = último `rxpk.tmst` del nodo + `SYSCOM_LNS_CLASS_C_TMST_OFFSET_US` (µs), **`imme: false`**, misma freq/dr RX2 (p. ej. UG65 que rechaza solo `imme`). Sin `tmst` válido en sesión se mantiene `imme`. **No** usar `Date.now()` para `tmst` (no es el reloj del concentrador). |
| `SYSCOM_LNS_CLASS_C_TMST_OFFSET_US` | Retardo en **microsegundos** respecto al último uplink; por defecto **500000** (0,5 s). Mínimo 50000. |
| `SYSCOM_LNS_TX_ACK_MAX_RETRIES` | Reintentos tras rechazo TX_ACK, por defecto `3`. |
| `SYSCOM_LNS_TX_ACK_RETRY_MS` | Retardo antes de volver a poner el mismo `txpk` en cola (ms), por defecto `750`. |
| `SYSCOM_LNS_TX_ACK_TIMEOUT_MS` | Tiempo (ms) sin **GW_TX_ACK** antes de liberar **`await_tx_ack`** de aplicación (defecto **5000** si no se define ninguna de las dos). Tiene prioridad sobre `SYSCOM_LNS_TX_ACK_SILENCE_MS`. |
| `SYSCOM_LNS_TX_ACK_SILENCE_MS` | Alias legado del timeout sin GW_TX_ACK; se usa si `SYSCOM_LNS_TX_ACK_TIMEOUT_MS` no está definido. |
| `SYSCOM_LNS_CLASSB_BEACON_PERIOD_MS` | Periodo aproximado de alineación clase **B** (ms), por defecto `128000` (128 s, típico beacon LoRaWAN). |
| `SYSCOM_LNS_CLASS_B_STRICT_PING` | **`1`**: no encolar downlink clase **B** hasta conocer periodicidad (0–7) vía **PingSlotInfoAns**; API **400** (`CLASS_B_PING_SLOT_UNKNOWN`). Por defecto desactivado (heurística con beacon period). |
| `SYSCOM_LNS_LOG_TX_ACK` | **`1`**: registra el JSON completo de cada **GW_TX_ACK** (0x05) recibido por UDP. |
| `SYSCOM_LNS_LOG_TX_ACK_PROGRESS` | **`1`**: una línea por **GW_TX_ACK** (origen IP, MAC8 wire, token, `txpk_ack.error`, claves JSON). Útil si el estado queda en «pendiente TX_ACK». |
| `SYSCOM_LNS_TX_ACK_PRUNE_INTERVAL_MS` | Cada cuántos ms se ejecuta la purga de **`await_tx_ack`** sin ACK (además de en cada **PULL_DATA**). Defecto **5000**; **`0`** desactiva el intervalo. |
| `SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT` | **`1`**: si el **token** del GW_TX_ACK no coincide con `lorawan_lns_tx_inflight`, se intenta correlacionar con el **último** inflight de aplicación del mismo gateway. Solo seguro con **un** downlink pendiente por GW. |
| `SYSCOM_LNS_LOG_GWMP_UNKNOWN` | **`1`**: avisa en consola si llega un byte `id` GWMP no manejado (≠ PUSH/PULL/TX_ACK). |
| `SYSCOM_LNS_LOG_DOWNLINK_SCHEDULE` | **`1`**: al encolar downlink app, registra `imme` / `tmst` / `rxDelaySec` / ventana RX1/RX2. |
| `SYSCOM_MILESIGHT_UG_QUEUE_PROXY` | Solo si vale **`1`**: reactiva el proxy `…/milesight-ug-gateway/devices/:devEUI/queue` hacia la API del UG65. **Por defecto omitida**: esas rutas responden **410** — los downlinks LoRaWAN deben ir al **LNS integrado**, no a la cola REST del gateway. |
| `LNS_INTEGRATION_JWT_SECRET` | Secreto HMAC para JWT de integración (`typ: lns_integration`). En **producción**, distinto de `JWT_SECRET`. |

## Downlinks: solo LNS integrado (sin NS del gateway)

Esta aplicación **no** usa ChirpStack, TTN ni el network server embebido del Milesight para MAC/downlinks: el **único** servidor de red LoRaWAN es el **LNS integrado** (SQLite + Semtech UDP).

- El **UG65/67** debe estar en **Packet Forwarder → Semtech** apuntando al **host y `LNS_UDP_PORT`** donde corre Node.
- Las rutas **`GET|POST|DELETE /api/milesight-ug-gateway/.../queue`** están **desactivadas por defecto** (HTTP **410**) para evitar enviar downlinks por la API administrativa del gateway (aceptación HTTP vs rechazo de `txpk` en radio). Otras rutas del proxy (login, listados, `urpackets`, etc.) siguen disponibles para diagnóstico.

### Cola diferida hasta el próximo uplink (medidores clase A / sin `tmst`)

Si el POST de downlink fallaría con **`CLASS_A_RX_WINDOW_CLOSED`**, **`CLASS_A_MISSING_GATEWAY_TMST`**, **`NO_GATEWAY`** (pero hay sesión OTAA), **`CLASS_B_MISSING_GATEWAY_TMST`** o **`CLASS_B_PING_SLOT_UNKNOWN`**, el servidor **guarda el payload en SQLite** (`lorawan_lns_deferred_app_dl`) y responde **HTTP 202** con `deferred: true`. Los errores **`CLASS_A_RX_WINDOW_CLOSED`** y **`CLASS_A_MISSING_GATEWAY_TMST`** **siempre** encolan hasta el próximo uplink (medidores clase A), salvo **`deferUntilUplink: false`** en el JSON. En el **siguiente uplink** válido del mismo DevEUI, el motor intenta **un** downlink diferido (no compite con **LinkCheckAns** en el mismo ciclo). Sigue haciendo falta que el **gateway** haga **PULL_DATA** para llevarse el `PULL_RESP` ya generado en ese momento.

| Variable | Efecto |
|----------|--------|
| `SYSCOM_LNS_DEFER_APP_DOWNLINK=0` | Desactiva el diferido; se mantiene el error inmediato (p. ej. 400). |
| `SYSCOM_LNS_DEFER_APP_DOWNLINK_MAX` | Máximo de entradas en cola por dispositivo (defecto **32**). |
| `SYSCOM_LNS_DEFER_APP_DOWNLINK_TTL_MS` | Antigüedad máxima por entrada (defecto **7 días**); entradas más viejas se purgan al insertar otra. |

En el cuerpo JSON del POST puede enviarse **`deferUntilUplink: false`** para forzar el comportamiento antiguo (sin cola) en esa petición. **`deferUntilUplink: true`** activa la cola ante esos errores **incluso si** `SYSCOM_LNS_DEFER_APP_DOWNLINK=0` (la UI envía `true` por defecto). Al **borrar sesión LoRaWAN** del dispositivo se eliminan también las entradas diferidas de ese DevEUI.

## Clase A, B y C (dispositivo)

En el alta/edición vía **`POST /api/user-devices`** puede enviarse **`lorawanClass`**: `"A"`, `"B"` o `"C"` (se guarda en `user_devices` y se copia a la sesión LNS al hacer **join**). También puede actualizarse después con **`PATCH /api/user-devices/:deviceId`** (superadmin) o **`PUT /api/devices/:deviceId/decode-config`** (staff, campo `lorawanClass`) si ya existe sesión (se sincroniza `device_class` en `lorawan_lns_sessions`).

**Orden de resolución al encolar un downlink** (si el cuerpo del POST **no** trae `lorawanClass` / `deviceClass`): **`device_decode_config.lorawan_class`** (plantilla aplicada en servidor) → **`user_devices.lorawan_class`** → **`lorawan_lns_sessions.device_class`** → metadato en última telemetría (último recurso). Si hay **dos filas** `device_decode_config` (p. ej. `device_id` interno y DevEUI), se usa la **`lorawan_class` de la fila con `updated_at` más reciente**. La tabla «Plantillas» del navegador no actualiza la clase hasta propagar o `PUT …/decode-config`; **`GET /api/devices/:deviceId/lora-profile`** muestra la clase efectiva y `lorawanClassSource`.

**Telemetría vs clase real:** algunos decoders (p. ej. Shengda **0x09**) publican un texto «Class B» que **no** implica que el downlink deba programarse como B. Para ignorar ese último paso use **`SYSCOM_LNS_DOWNLINK_IGNORE_TELEMETRY_CLASS=1`** o envíe en el POST del downlink **`"lorawanClass":"A"`**.

| Clase | Comportamiento del LNS (downlink aplicación) |
|-------|-----------------------------------------------|
| **A** | Con uplink reciente dentro de `SYSCOM_LNS_CLASS_A_RX1_WINDOW_MS` y **`rxpk.tmst`** del GW, el `txpk` usa **solo `tmst`** (**RX1** o **RX2** según `SYSCOM_LNS_CLASS_A_RX_WINDOW` y `SYSCOM_LNS_RX2_AFTER_RX1_SEC`). Sin `tmst` → error (`CLASS_A_MISSING_GATEWAY_TMST`). Si la ventana wall-time ya pasó → `CLASS_A_RX_WINDOW_CLOSED`. Tras uplink **confirmado**, el siguiente downlink puede llevar **ACK MAC** (`FCtrl.ACK`). |
| **C** | Siempre **RX2 inmediato** (`imme: true`): el dispositivo escucha de forma casi continua en RX2. |
| **B** | Cola con **`not_before_ms`** (ping / heurística) y **`txpk` con `tmst`** respecto al último uplink (misma base temporal que RX1; no `imme`). Requiere **`rxpk.tmst`** reciente; sin él → **`CLASS_B_MISSING_GATEWAY_TMST`**. Opcional **`delayMs`** en la API. |

**Nota clase B:** un despliegue **totalmente conforme** con LoRaWAN Clase B exige **beacon** en el gateway y fase acotada; aquí se ofrece **compatibilidad operativa** (cola diferida + parámetros MAC) mejorable con gateway beacon y afinado de tiempos en entornos exigentes.

### Dispositivos clase B — checklist operativo

1. **Clase persistida en el servidor**  
   Defina **`lorawanClass` = `"B"`** en el dispositivo (`user_devices`) o en la **plantilla** (`device_decode_config.lorawan_class`). Si el nodo solo informa `lorawan_class` en telemetría (p. ej. texto «Class C» de Milesight), ese valor es **último recurso** y puede no coincidir con el modo real; la clase **B** en BD/plantilla tiene prioridad sobre telemetría (ver orden arriba).

2. **`rxpk.tmst` del gateway**  
   Los downlinks clase **B** usan **`tmst`** respecto al último uplink (no `imme`). El packet forwarder **Semtech** debe enviar **`tmst`** en cada `rxpk`. Sin eso la API responde **`CLASS_B_MISSING_GATEWAY_TMST`**.

3. **PingSlotInfoAns (MAC)**  
   Tras un uplink con **FPort 0**, el LNS busca **PingSlotInfoAns** (CID `0x11`) y guarda **periodicidad** (0–7) y **DR** en sesión. Eso mejora el cálculo de **`not_before_ms`**. Con **`SYSCOM_LNS_CLASS_B_STRICT_PING=1`** no se encola downlink B hasta tener periodicidad conocida → **`CLASS_B_PING_SLOT_UNKNOWN`** si aún no llegó el MAC. Por defecto está desactivado: se usa heurística con **`SYSCOM_LNS_CLASSB_BEACON_PERIOD_MS`** (128 s típico).

4. **Ventana RX1 (muchas redes clase B)**  
   En la práctica muchos nodos clase B reciben comandos en la **ventana RX1/RX2** tras un uplink (igual que A) además de ping slots. El registro de actividad puede mostrar «clase B» y **TX en ventana RX**: es coherente con este LNS (programación por `tmst`, no cola `imme` clase C).

5. **Mismo gateway con nodos clase C**  
   Los rechazos **`TOO_EARLY` / `TOO_LATE`** con **`imme`** afectan sobre todo a downlinks **clase C**. Los downlinks **B** no usan `imme`, pero el concentrador sigue siendo compartido: si mezcla muchos C y B, conviene subir **`SYSCOM_LNS_CLASS_C_TX_GAP_MS`** para los nodos C y revisar **`SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT=1`** si hay ACK huérfanos en el log.

6. **API**  
   Opcional **`delayMs`** en el cuerpo del downlink para espaciar respecto a `not_before_ms` heurístico. **`SYSCOM_LNS_LOG_DOWNLINK_SCHEDULE=1`** ayuda a ver `imme` / `tmst` / clase en consola.

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

- **LoRaWAN 1.1**, **ADR completo**, la mayoría de **MAC commands** (salvo detección de **PingSlotInfoAns**), y **rejoin** avanzado no están al nivel de un stack certificable. Los downlinks pueden enviarse como **Confirmed Data Down** (`confirmed: true` en la API); el **ACK MAC** al uplink confirmado se incluye en el siguiente downlink. Tras un reinicio del servidor puede quedar un downlink en `await_tx_ack` sin fila en `lorawan_lns_tx_inflight`: en ese caso conviene revisar la BD o usar `SYSCOM_LNS_TX_ACK=0` en entornos de prueba.
- **FCnt** 32 bits y deduplicación multi-gateway fina siguen simplificados. **US915**: RX1, RX2/`imme` y retardo de join usan parámetros del plan **US902-928** cuando la banda del gateway o la frecuencia de uplink (902–915 MHz) lo indican.
- **Clase B**: la alineación a beacon/ping es **aproximada** salvo integración explícita con beacon del gateway y NTP/GPS en el NS.

## Alojamiento

- **Render / PaaS HTTP:** no sirve para UDP; usa las URLs HTTPS de **Ajustes** o despliega el backend en una VM con UDP abierto.
- **Firewall / NAT:** abre **UDP** hacia `LNS_UDP_PORT` hacia la máquina del servidor.
