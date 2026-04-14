# Funciones autohospedadas (sin plataformas de terceros)

## Server-Sent Events (SSE)

- **Ruta:** `GET /api/events/stream?token=<JWT>`
- **Motivo del token en query:** `EventSource` del navegador no envía cabecera `Authorization`. No incluir el enlace en sitios públicos ni en logs compartidos.
- **Eventos:**
  - `connected` — conexión establecida.
  - `telemetry` — datos: `{ deviceId, deviceName, timestamp }` tras guardar telemetría (ingesta HTTP, LNS, POST `/api/telemetry`). Se notifica a cada `userId` que recibe fila (propietario + cuentas con el mismo dispositivo asignado).
  - `lns` — evento de UI LNS: `{ id, eventType, devEui, meta, createdAt }` (p. ej. `downlink_sent`, `downlink_device_acked`).
- **Variables:** `SYSCOM_SSE_MAX_PER_USER` (conexiones simultáneas por usuario, por defecto 8), `SYSCOM_SSE_HEARTBEAT_MS` (por defecto 25000).

## Métricas en memoria

- **Ruta:** `GET /api/admin/syscom-metrics` — requiere JWT de **administrador** o **superadmin**.
- Respuesta: `startedAt`, `uptimeMs`, `counters` (telemetría guardada, logins, rechazos por rate limit, broadcasts SSE, etc.) y `realtime.sseSubscribers`.

## Límites de velocidad (por IP)

- **Login:** `POST /api/auth/login` — ventana 15 min; máximo intentos `SYSCOM_LOGIN_RATE_MAX` (por defecto 40).
- **Ingesta:** POST `/api/ingest/...`, `/api/lorawan/uplink/...`, `/api/milesight/uplink/...` y las mismas rutas en `INGEST_PORT` — por minuto `SYSCOM_INGEST_RATE_MAX` (por defecto 600).
- Respuesta **429** con `Retry-After` y cuerpo `{ error, code: 'RATE_LIMIT' }`.

## Pruebas

```bash
npm test
```

Ejecuta `node --test` sobre `server/test/selfhosted.test.cjs` (rate limit, hub SSE, métricas).
