# LNS integrado — Semtech UDP (GWMP)

SYSCOM IoT puede actuar como **network server propio** (sin ChirpStack/TTN) para **LoRaWAN 1.0.x** sobre el protocolo **Semtech UDP**:

- **OTAA**: Join-Request / Join-Accept (MIC con `AppKey`, sesión `NwkSKey`/`AppSKey` en SQLite).
- **Uplink datos**: verificación MIC, descifrado FRMPayload, contador `FCnt` básico, telemetría + decoders existentes.
- **Downlink**: cola en BD + envío en **PULL_RESP** (tras **PULL_DATA** del gateway). El gateway responde con **GW_TX_ACK** (`0x05`) indicando si aceptó el `txpk` (p. ej. `TOO_LATE`, `TX_FREQ`, o éxito). Con **`SYSCOM_LNS_TX_ACK=1`** (por defecto), los downlinks **de aplicación** no actualizan **`fcnt_down`** en sesión hasta un ACK exitoso; si el gateway rechaza el envío, se **reencola el mismo `PULL_RESP`** (mismo FCnt en el aire) hasta agotar reintentos. El **Join-Accept** no usa esta ruta (sigue marcándose `sent` al enviar). Opcionalmente, por cada **PULL_DATA** se pueden enviar varios **PULL_RESP** (`SYSCOM_LNS_PULL_BURST`; por defecto **1**). La cola ordena por **`priority`** y antigüedad. API: `POST /api/devices/:deviceId/downlink` con `fPort` y `payloadHex`; opcionales: **`confirmed`**, **`delayMs`**, **`priority`**. Si hay un downlink en vuelo esperando TX_ACK, la API puede responder **429** (`DOWNLINK_IN_FLIGHT`).

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
| `SYSCOM_LNS_NET_ID` | NetID 6 hex (3 B), por defecto `000001`. |
| `SYSCOM_LNS_RX1_DELAY_US` | Si está definida, **anula** el retardo RX1 calculado desde el **RxDelay guardado en sesión** (mismo criterio que el Join-Accept: `SYSCOM_LNS_RX_DELAY_SEC`). Si no está definida, RX1 = `rx_delay_sec × 1e6` µs respecto al `tmst` del último uplink. |
| `SYSCOM_LNS_RX2_FREQ` / `SYSCOM_LNS_RX2_DATR` / `SYSCOM_LNS_RX2_CODR` | Parámetros para downlink **inmediato** (`imme`) y para la ventana **RX2 programada** (clase A con `SYSCOM_LNS_CLASS_A_RX_WINDOW=RX2`). |
| `SYSCOM_LNS_TX_POWER` | `powe` en `txpk`, por defecto `14`. |
| `SYSCOM_LNS_RX_DELAY_SEC` | RxDelay en Join-Accept (1–15; `0` en aire significa 1 s). Se guarda en sesión como **`rx_delay_sec`** para alinear downlinks clase A en RX1. |
| `SYSCOM_LNS_RX2_AFTER_RX1_SEC` | Segundos entre el inicio de RX1 y el `tmst` de la ventana **RX2 programada** (clase A), por defecto `1`. |
| `SYSCOM_LNS_CLASS_A_RX_WINDOW` | `RX1` (por defecto) o `RX2`: con uplink reciente, el downlink clase A se programa en la primera o segunda ventana de recepción (RX2 usa `SYSCOM_LNS_RX2_*` y `tmst` diferido). |
| `SYSCOM_LNS_CLASS_A_RX1_WINDOW_MS` | Tras un uplink, ventana (ms) en la que el downlink puede usar **RX1/RX2 programado** (`tmst`); si expira, se usa **RX2** con `imme` (clase A). |
| `SYSCOM_LNS_PULL_BURST` | Máximo de **PULL_RESP** enviados por cada **PULL_DATA** (1–20), por defecto `1`. Sube solo si tu forwarder acepta varios por ciclo. |
| `SYSCOM_LNS_TX_ACK` | `1` (por defecto): confirma **FCnt down** solo tras **TX_ACK** exitoso del gateway; reintentos sin cambiar el frame. `0`: comportamiento anterior (FCnt al encolar). |
| `SYSCOM_LNS_TX_ACK_MAX_RETRIES` | Reintentos tras rechazo TX_ACK, por defecto `3`. |
| `SYSCOM_LNS_TX_ACK_RETRY_MS` | Retardo antes de volver a poner el mismo `txpk` en cola (ms), por defecto `750`. |
| `SYSCOM_LNS_CLASSB_BEACON_PERIOD_MS` | Periodo aproximado de alineación clase **B** (ms), por defecto `128000` (128 s, típico beacon LoRaWAN). |

## Clase A, B y C (dispositivo)

En el alta/edición vía **`POST /api/user-devices`** puede enviarse **`lorawanClass`**: `"A"`, `"B"` o `"C"` (se guarda en `user_devices` y se copia a la sesión LNS al hacer **join**). También puede actualizarse después con el mismo endpoint si ya existe sesión (se sincroniza `device_class` en `lorawan_lns_sessions`).

| Clase | Comportamiento del LNS (downlink aplicación) |
|-------|-----------------------------------------------|
| **A** | Si hubo uplink reciente dentro de `SYSCOM_LNS_CLASS_A_RX1_WINDOW_MS` y hay `tmst`, el `txpk` usa **RX1** o **RX2 programado** según `SYSCOM_LNS_CLASS_A_RX_WINDOW`, con retardo coherente con el **Join-Accept** (`rx_delay_sec`). Si la ventana expiró o no hay `tmst`, **RX2 inmediato** (`imme`). Tras un **uplink confirmado**, el siguiente downlink lleva **ACK MAC** (`FCtrl.ACK`) hasta que se envía. |
| **C** | Siempre **RX2 inmediato** (`imme: true`): el dispositivo escucha de forma casi continua en RX2. |
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

- **LoRaWAN 1.1**, **ADR completo**, la mayoría de **MAC commands** (salvo detección de **PingSlotInfoAns**), y **rejoin** avanzado no están al nivel de un stack certificable. Los downlinks pueden enviarse como **Confirmed Data Down** (`confirmed: true` en la API); el **ACK MAC** al uplink confirmado se incluye en el siguiente downlink. Tras un reinicio del servidor puede quedar un downlink en `await_tx_ack` sin fila en `lorawan_lns_tx_inflight`: en ese caso conviene revisar la BD o usar `SYSCOM_LNS_TX_ACK=0` en entornos de prueba.
- **FCnt** 32 bits, deduplicación multi-gateway fina y **US915** sin ajustes dedicados requieren más lógica.
- **Clase B**: la alineación a beacon/ping es **aproximada** salvo integración explícita con beacon del gateway y NTP/GPS en el NS.

## Alojamiento

- **Render / PaaS HTTP:** no sirve para UDP; usa las URLs HTTPS de **Ajustes** o despliega el backend en una VM con UDP abierto.
- **Firewall / NAT:** abre **UDP** hacia `LNS_UDP_PORT` hacia la máquina del servidor.
