# SYSCOM IoT

Plataforma IoT auto-hospedada con panel web (**React + Vite**), API REST (**Express + Node.js**) y persistencia **SQLite**. Gestiona telemetría de sensores distribuidos, integración **LoRaWAN / LNS** completa (HTTP, MQTT y UDP Semtech GWMP), dashboards configurables con widgets en tiempo real (**SSE**) y gestión de usuarios con roles.

El frontend usa **rutas amigables** (`/panel`, `/dispositivos`, `/dispositivos/:id`, `/usuarios/…`, `/plantillas/…`, etc.); enlaces compartibles y navegación con historial del navegador.

## Requisitos

- **Node.js** ≥ 20.19.0

## Instalación

```bash
npm install
```

## Desarrollo

```bash
# API + frontend en un solo comando (recomendado)
npm run dev:all
```

O en terminales separadas:

```bash
# Terminal 1 — frontend Vite con HMR en https://127.0.0.1:5173
npm run dev

# Terminal 2 — API en :3001 (Vite reenvía /api automáticamente)
npm start
```

> La primera vez que abras `https://127.0.0.1:5173` el navegador mostrará una advertencia de certificado autofirmado. Acepta la excepción una sola vez.

Copia [`.env.example`](./.env.example) a `.env` y completa tus credenciales:

```bash
cp .env.example .env
```

Variables mínimas para desarrollo:

```env
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=https://127.0.0.1:5173
VITE_GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
VITE_GOOGLE_REDIRECT_URI=https://127.0.0.1:5173
```

## Detener el servidor

```bash
# Si usaste npm run dev:all
Ctrl + C

# Si iniciaste procesos por separado, detén cada terminal con
Ctrl + C
```

## Producción

```bash
# 1. Compilar el frontend
npm run build

# 2. Arrancar (sirve dist/ + API en un solo proceso)
NODE_ENV=production JWT_SECRET=<secreto-largo> npm start
```

**Windows (PowerShell):**
```powershell
$env:NODE_ENV='production'; $env:JWT_SECRET='<secreto-largo>'; npm start
```

Variables de entorno clave:

| Variable | Descripción |
|----------|-------------|
| `JWT_SECRET` | **Obligatorio** en producción. Cadena larga y aleatoria (`openssl rand -hex 32`). |
| `SYSCOM_JWT_EXPIRES` | Vigencia del JWT de sesión del navegador (p. ej. `90d`, `8h`). Por defecto `90d`. |
| `SYSCOM_JWT_REFRESH_GRACE_MS` | Tras caducar `exp`, ventana (ms) en que `POST /api/auth/refresh` y el stream SSE con `?token=` siguen aceptando el JWT. Por defecto ~30 días. |
| `GOOGLE_CLIENT_ID` | Client ID de Google OAuth (backend y frontend). |
| `GOOGLE_CLIENT_SECRET` | Client Secret de Google OAuth (solo backend). |
| `GOOGLE_REDIRECT_URI` | URI de redirección registrada en Google Cloud Console. |
| `VITE_GOOGLE_CLIENT_ID` | Igual que `GOOGLE_CLIENT_ID` (expuesto al build de Vite). |
| `VITE_GOOGLE_REDIRECT_URI` | URI de redirección en el cliente. |
| `SYSCOM_CORS_ORIGINS` | Orígenes HTTPS permitidos (coma). Ej: `https://app.com` |
| `SYSCOM_SQLITE_PATH` | Ruta al archivo SQLite en disco persistente |
| `LNS_UDP_PORT` | UDP Semtech GWMP; por defecto **1700**. Use `0` o `off` solo sin UDP entrante (PaaS HTTP). |
| `SYSCOM_LNS_PLAN` | Solo **US915** (902–928 MHz; RX2 ref. 923.3 / SF12BW500). Otros valores se ignoran. |
| `SYSCOM_LNS_MAC` | Motor MAC/join; activo salvo `0`. |
| `MQTT_BROKER_URL` | URL del broker MQTT. Ej: `mqtt://broker:1883` |
| `VITE_API_BASE` | Solo si frontend y API están en dominios distintos |

Ver todos los parámetros en [`.env.example`](./.env.example).

## Scripts npm

| Script | Descripción |
|--------|-------------|
| `npm run dev:all` | **Recomendado para desarrollo** — API + Vite concurrentemente |
| `npm run dev` | Solo frontend Vite con HMR |
| `npm start` | Solo servidor API (+ sirve `dist/` si existe) |
| `npm run build` | Build de producción del frontend |
| `npm run lint` | ESLint |
| `npm test` | Tests de integración (Node test runner) |
| `npm run verify` | Suite completa de verificación de endpoints |
| `npm run simulate:lns` | Simulación LoRaWAN Class A/B/C |

## Estructura

```
syscom-iot/
├── src/                        # Frontend React
│   ├── pages/                  # Dashboard, DeviceList, History, UserManagement…
│   ├── components/widgets/     # Widgets del dashboard
│   ├── services/               # Clientes HTTP (api.js, localAuth.js…)
│   ├── context/                # Auth, Theme, Language
│   └── constants/              # Rutas, templates, traducciones, bandas LoRaWAN
│
├── server/                     # Backend Express
│   ├── server.js               # Rutas, auth, CRUD
│   ├── store.js                # Capa de acceso a SQLite
│   ├── migrations/             # SQL numerados, bootstrap-admins.js, migrationHooks; ver migrations/README.md
│   ├── lns/                    # LoRaWAN LNS (engine, crypto, normalize, Semtech UDP)
│   ├── decoders/               # Decodificadores de payload (VM, Timewave, Eastron)
│   ├── integrations/milesight/ # Cliente REST y MQTT para gateways Milesight
│   ├── integrations/mqtt/      # Ingestión desde broker MQTT
│   ├── middleware/             # Rate limiter, política de contraseñas
│   ├── realtime/               # Pool SSE por usuario
│   ├── monitoring/             # Métricas internas
│   └── data/                   # Base de datos SQLite (generada al arrancar)
│
├── scripts/                    # Utilidades (verify-integration, simulate-lorawan)
└── docs/                       # Guías de despliegue e integración de dispositivos
```

## LoRaWAN: qué significa «canal»

En la app hay tres ideas distintas: **banda/plan del gateway** (US915 **FSB2**: 125 kHz canales 8–15 y 500 kHz 65–70), **canal plantilla** en decoder (`device_decode_config.channel` ≈ FPort de aplicación) y **puerto UDP** del LNS (GWMP). Resumen en [docs/LORAWAN-CHANNELS-VS-APP.md](./docs/LORAWAN-CHANNELS-VS-APP.md).

## Autenticación y roles

- La SPA renueva el JWT (`POST /api/auth/refresh`) ante `401`, al arrancar con token caducado (dentro de la gracia) y cada 6 h con sesión activa. Un JWT largo + gracia amplía el impacto si el token se roba: use **HTTPS**, `JWT_SECRET` fuerte y, si hace falta, `SYSCOM_JWT_EXPIRES` corto manteniendo el refresh automático.
- La **ingesta HTTP/LoRaWAN** (`/api/ingest/…`, `/api/lorawan/uplink/…`), **webhooks** y el **UDP del gateway** no usan el JWT del navegador; solo la UI y las rutas REST con `Authorization: Bearer`.
- Login exclusivamente mediante **Google OAuth** (flujo de redirección, sin popups).
- Superadministradores de organización: se definen en [`server/migrations/bootstrap-admins.js`](./server/migrations/bootstrap-admins.js); al primer arranque se crean en la base si no existen. El endpoint de setup (`/api/setup`) solo aplica si aún no hay ningún admin/superadmin “raíz”.
- Roles: `superadmin` › `admin` › `user`.
- La foto de perfil de Google se muestra automáticamente en la barra superior.

## Logotipo

Por defecto se sirve `public/logo-syscom.svg`. Desde **Ajustes → Logotipo de la aplicación** puedes subir una imagen propia; en ese caso se guarda en `localStorage` del navegador.

## Integraciones soportadas

- **LoRaWAN** — OTAA, Class A, RX1/RX2, downlinks confirmados/no confirmados
- **Milesight UG65 / UG67 / UG63** — HTTP REST + MQTT
- **Semtech Packet Forwarder** — UDP GWMP (**1700** por defecto; requiere host con UDP público — ver [`docs/LNS-SEMTECH-UDP.md`](./docs/LNS-SEMTECH-UDP.md) y [`docker-compose.yml`](./docker-compose.yml))
- **MQTT genérico** — ChirpStack, TTN, cualquier broker configurable
- **Decodificadores built-in** — Timewave (agua), Eastron SDM230 (energía / Modbus RTU)

## Migraciones de base de datos

Las migraciones son archivos SQL numerados (`server/migrations/sql/0001_….sql`) y se aplican **en orden** al arrancar el servidor (pendientes solamente). Detalle e historial en [`server/migrations/README.md`](./server/migrations/README.md).

La lista de **correos y nombres de superadministradores** que se insertan al aplicar la migración `0010` está en código en [`server/migrations/bootstrap-admins.js`](./server/migrations/bootstrap-admins.js) (también usada para no degradar su rol desde la API).

## Docker (US915 + LNS UDP en un solo arranque)

En la raíz del repo, con `JWT_SECRET` definido (p. ej. en un archivo `.env` junto al compose):

```bash
docker compose up --build -d
```

Expone **3001/tcp** (API + `dist/`) y **1700/udp** (Semtech GWMP). Verifique en logs las líneas `[LNS] Motor MAC…` y `[LNS-UDP] Semtech GWMP activo`. Detalle: [`docs/LNS-SEMTECH-UDP.md`](./docs/LNS-SEMTECH-UDP.md).

## Antes de desplegar

```bash
npm run lint
npm run build
npm test
```

