# SYSCOM IoT — LoRaWAN Monitoreo y Control

Este directorio es la aplicación **SYSCOM IoT** dentro del repositorio [SYSCOM-IOT](../README.md): panel web, API y motor LoRaWAN para monitoreo y control de dispositivos. En el mismo monorepo, el proyecto **[LoraWan-Control-Agua](../LoraWan-Control-Agua/)** está **pendiente** (carpeta reservada para la línea de producto de control de agua).

---

**SYSCOM IoT** es una plataforma web para operación de dispositivos IoT: panel **React 19 + Vite 7**, API **Express 4** sobre **Node.js** (ESM en scripts de arranque; servidor en CommonJS) y persistencia **SQLite** vía `node --experimental-sqlite`. Ofrece ingesta de telemetría, motor **LoRaWAN / LNS** (HTTP, MQTT Milesight y **UDP Semtech GWMP** integrado), automatizaciones, dashboards con widgets y actualización **en tiempo casi real con Server-Sent Events (SSE)**. La autenticación combina **JWT** (sesión web y refresh), política de contraseñas y **OAuth opcional** (Google, Microsoft, Yahoo) enlazado a usuarios ya existentes en la base de datos.

**Rutas y URLs:** la SPA **no usa React Router ni paths amigables por URL** (`/dispositivos`, etc.); la vista activa vive en estado de React y se puede recordar la última pantalla en `localStorage` (`syscom_iot_last_page`). Las **rutas HTTP de la API** siguen el prefijo `/api/…` (y opcionalmente ingesta dedicada; ver código y `.env.example`). En desarrollo, Vite proxifica `/api` al backend; el stream SSE va directo al origen del API en dev (ver `src/config/apiBase.js`).

## Requisitos

| Componente | Versión mínima / notas |
|------------|-------------------------|
| **Node.js** | `^20.19.0` o `>=22.12.0` (campo `engines` en `package.json`; alineado con Vite 7). Comprobar con `node -v`. |
| **npm** | Compatible con **lockfileVersion 3** del repositorio (típicamente **npm 9+**). No se incluye `yarn.lock`; si usáis Yarn, equivalente: `yarn install` tras auditar resolución de dependencias. |

No hay otros runtimes obligatorios en este subproyecto (sin Dockerfile ni compose en su raíz).

## Instalación

Desde **esta carpeta** (`LoraWan-Monitoreo-y-Control`, donde vive `package.json`):

```bash
npm install
```

Esto crea `node_modules/` (~380 paquetes, incluido Vite, Express, lora-packet, etc.) y deja todo listo para `npm start`. No hay paso adicional: las dependencias del frontend y del backend conviven en el mismo `node_modules`.

### Si `npm install` falla con `ETIMEDOUT`

Algunos ISPs en México (Infinitum/Telmex y similares) tienen peering roto hacia el rango de Cloudflare donde reside `registry.npmjs.org` (`104.16.x.x`): DNS resuelve, pero el handshake TCP/443 no se completa y caen los `.tgz`. El síntoma típico:

```
npm error code ETIMEDOUT
npm error network request to https://registry.npmjs.org/...failed
```

Opciones, de menor a mayor invasividad:

1. **Mirror para una sola instalación** (recomendado como primer intento):

   ```bash
   npm install --registry=https://registry.npmmirror.com
   ```

   `registry.npmmirror.com` es el espejo público de npm mantenido por Alibaba: paquetes idénticos al registry oficial, otra IP, no toca tu configuración global.

2. **Tethering del celular** y reintentar `npm install` normal — si la red corporativa/WiFi es la causa, suele resolver al cambiar de ISP.

3. **Mirror persistente solo para este proyecto** (si lo anterior funciona y quieres dejarlo fijo):

   ```bash
   echo 'registry=https://registry.npmmirror.com' > .npmrc
   ```

   El archivo `.npmrc` queda local a esta carpeta. **No lo commiteéis** si llegáis a añadir tokens (`//registry.example.com/:_authToken=…`).

4. **VPN**, cambio de DNS o reportar al ISP — solo si nada de lo anterior funciona.

## Desarrollo

**Todo-en-uno con `npm start`:** levanta backend (Express) y frontend (Vite con HMR) en el mismo proceso padre, con logs prefijados `[api]` / `[front]`. **Ctrl+C** detiene ambos a la vez.

```bash
npm start
```

Lo que veréis al arrancar (orden no garantizado, suele ir Vite primero):

```
[front]   VITE v7.x  ready in 250 ms
[front]   ➜  Local:   http://127.0.0.1:5173/
[api]   🚀 Syscom IoT API escuchando en http://0.0.0.0:3001
```

Abrid **http://127.0.0.1:5173** en el navegador. En una instalación nueva con la SQLite vacía, la app llama a `GET /api/setup/status`, detecta `needsSetup: true` y muestra el asistente para crear el **primer superadministrador** en vez del login. Tras crearlo, el siguiente arranque irá directo a la pantalla de login.

| Servicio | Comando | URL / puerto por defecto |
|----------|---------|---------------------------|
| API + Vite (recomendado) | `npm start` | API en `http://127.0.0.1:3001`, front en `http://127.0.0.1:5173` |
| Solo frontend | `npm run dev` | `http://127.0.0.1:5173` |
| Solo backend | `npm run start:api` | `http://127.0.0.1:3001` |
| Proxy Vite | (automático) | Peticiones del navegador a `/api` → `http://localhost:3001` |

### Detalles del wrapper `npm start`

`scripts/start-dev.mjs`:

- Lanza dos hijos con `child_process.spawn`: `node --experimental-sqlite [--env-file=.env] server/server.js` y `node node_modules/vite/bin/vite.js`.
- Prefija cada línea de stdout/stderr con `[api]` (cyan) o `[front]` (magenta) para que sean distinguibles.
- Carga `--env-file=.env` **solo si el archivo existe**, así máquinas nuevas arrancan con valores por defecto del código.
- Propaga `SIGINT` (Ctrl+C) y `SIGTERM` a ambos hijos. Si uno cae por su cuenta, baja al otro y sale con el código del primero en caer.
- Sin dependencias adicionales (todo es `node:child_process` y `node:fs`).

No fijéis `NODE_ENV=production` en desarrollo sin definir `JWT_SECRET` (el servidor sale con error en producción sin él).

**HTTPS y certificados:** la configuración actual de Vite usa **HTTP** en el puerto de desarrollo. Si personalizáis Vite/servidor con **TLS** (proxy corporativo, certificado autofirmado), el navegador puede bloquear o avisar hasta que confiéis en el emisor o importéis la CA; SSE y `EventSource` también exigen un contexto seguro coherente con el origen del API.

**Variables de entorno:** copiad la plantilla a `.env` cuando queráis valores explícitos.

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

Ejemplo mínimo de `.env` para desarrollo local (sin secretos reales; ajustad valores):

```bash
# Desarrollo: podéis omitir JWT_SECRET si NO usáis NODE_ENV=production.
# JWT_SECRET=cambiar-en-produccion-usar-openssl-rand-hex-32
# PORT=3001
# SYSCOM_CORS_ORIGINS=http://127.0.0.1:5173
# VITE_DEV_API_PORT=3001
```

Listado completo y comentarios: [`.env.example`](./.env.example).

## Detener el servidor

- Con `npm start` (modo todo-en-uno) basta un único **Ctrl+C** en la terminal del padre: el wrapper propaga `SIGTERM` a Vite y a la API, y sale con el código del primero en caer.
- Si arrancáis API y frontend por separado (`npm run start:api` + `npm run dev`), detened ambas terminales.
- Si el puerto **3001** o **5173** queda ocupado por un proceso huérfano, cerrad ese proceso o cambiad `PORT` antes de volver a arrancar (en Windows: `netstat -ano | findstr :3001`).

## Producción

1. Definid variables de entorno (como mínimo **`JWT_SECRET`** con `NODE_ENV=production`; ver tabla más abajo y [`.env.example`](./.env.example)).
2. Compilad el frontend y arrancad el proceso Node que sirve API + `dist/`.

**Build y arranque en un solo comando (recomendado en el repo):**

```bash
npm run production
```

Equivale a `npm run build` seguido de `npm run start:prod` (`scripts/start-production.mjs` fuerza `NODE_ENV=production` y carga `.env` si existe).

**Pasos manuales equivalentes (Unix shell):**

```bash
npm run build
NODE_ENV=production JWT_SECRET='cadena-larga-aleatoria' npm start
```

O usando solo el wrapper de producción tras el build:

```bash
npm run build
npm run start:prod
```

(con `JWT_SECRET` y el resto en `.env` o exportadas en el entorno).

**PowerShell (Windows) — ejemplo de sesión con variables en línea:**

```powershell
$env:NODE_ENV = 'production'
$env:JWT_SECRET = 'cadena-larga-aleatoria'
$env:SYSCOM_CORS_ORIGINS = 'https://iot.ejemplo.com'
$env:SYSCOM_SQLITE_PATH = 'C:\datos\syscom-iot\data.sqlite'
npm start
```

Si el front se construye para **otro host** que el de la API, definid `VITE_API_BASE` en el momento del build (debe terminar en `/api`); detalle en comentarios de `src/config/apiBase.js` y `.env.example`.

Despliegue en **AWS EC2** (systemd, Nginx, SQLite, UDP): [docs/DEPLOY-AWS-EC2.md](./docs/DEPLOY-AWS-EC2.md). **Render** u otros PaaS HTTP: [docs/DEPLOY-RENDER.md](./docs/DEPLOY-RENDER.md). Unidad **systemd** de ejemplo: [deploy/ec2/README.md](./deploy/ec2/README.md).

## Variables de entorno clave

Obligatoriedad referida a **entorno de producción** típico (`NODE_ENV=production`). El listado exhaustivo está en [`.env.example`](./.env.example).

| Variable | Descripción breve | En producción |
|----------|-------------------|---------------|
| `NODE_ENV` | Modo de ejecución. | Debe ser `production` para despliegues reales. |
| `JWT_SECRET` | Firma de JWT de sesión web. | **Obligatoria** (sin ella el proceso termina). |
| `SYSCOM_CORS_ORIGINS` | Orígenes permitidos (coma) o `*`. | **Muy recomendada** lista explícita de orígenes HTTPS. |
| `SYSCOM_SQLITE_PATH` | Ruta del archivo SQLite. | **Recomendada** (disco persistente conocido y backup). |
| `LNS_INTEGRATION_JWT_SECRET` | JWT para integraciones LNS (`/api/lns/integration-tokens`). | **Recomendada** distinta de `JWT_SECRET`. |
| `PORT` | Puerto HTTP principal de la API. | Opcional (defecto **3001**). |
| `LNS_UDP_PORT` / `SYSCOM_LNS_UDP` | Puerto UDP Semtech; `0` desactiva escucha UDP. | Opcional según topología (defecto UDP **1700** si no se desactiva). |
| `INGEST_PORT` | Puerto dedicado `POST /ingest/...` además de `/api/ingest/...`. | Opcional. |
| `VITE_API_BASE` | URL base del API en el build del front. | Condicional si front y API van en hosts distintos. |
| `SYSCOM_TRUST_PROXY` | Confiar en `X-Forwarded-*` detrás de reverse proxy. | Condicional (`1` típico tras Nginx/Traefik). |
| `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*`, `YAHOO_OAUTH_*` | Proveedores OAuth opcionales. | Opcional. |

## Scripts npm

Definidos en `package.json` (no hay otros gestores versionados en el repo).

| Script | Descripción |
|--------|-------------|
| `npm start` | Arranca API (`server/server.js`) **y** Vite dev en paralelo con logs prefijados (`scripts/start-dev.mjs`). |
| `npm run start:api` | Solo API: `server/server.js` con `node --experimental-sqlite` y `--env-file=.env` si existe. |
| `npm run start:prod` | Solo API con `NODE_ENV=production` (`scripts/start-production.mjs`); requiere `npm run build` previo para que Express sirva `dist/`. |
| `npm run dev` | Solo Vite dev (HMR). |
| `npm run build` | Compilación de producción del frontend a `dist/`. |
| `npm run production` | `build` + `start:prod` (un solo flujo para compilar y servir en modo producción). |
| `npm run preview` | Previsualiza el build con el servidor estático de Vite. |
| `npm run lint` | ESLint sobre el proyecto. |
| `npm test` | Tests del servidor con el test runner de Node (`server/test/selfhosted.test.cjs`). |
| `npm run verify` | Verificación de integración (`scripts/verify-integration.mjs`). |
| `npm run simulate:lns` | Simulación LoRaWAN (`scripts/simulate-lorawan-classes.mjs`). |

## Estructura

Árbol orientativo del repositorio (omitidos `node_modules/`, `dist/` generado, etc.):

```text
.
├── index.html              # Entrada HTML de Vite
├── package.json            # Dependencias, engines y scripts npm
├── package-lock.json
├── vite.config.js          # Dev server, puerto 5173, proxy /api → :3001
├── .env.example            # Plantilla de variables (referencia principal)
├── public/                 # Estáticos públicos (p. ej. service worker de toasts)
├── src/                    # SPA React: páginas, componentes, contextos, servicios
├── server/                 # Express, SQLite (store), LNS, MQTT, métricas, tests
├── shared/                 # JSON compartido API ↔ front (p. ej. contrato SSE, bandas LoRaWAN)
├── scripts/                # Arranque con env, producción, utilidades LNS y mantenimiento
├── docs/                   # Documentación de dominio y despliegue
└── deploy/ec2/             # Artefactos EC2 (systemd, nginx, README de despliegue)
```

## Dominio, autenticación, integraciones y datos

### Conceptos de producto

- **Dispositivos y telemetría:** historial en SQLite, widgets con fusión de lecturas parciales.
- **Estado “en línea”:** derivado de ingesta reciente; umbrales `SYSCOM_COMMS_STALE_OFFLINE_MS` y equivalentes `VITE_*` (ver `.env.example`).
- **LoRaWAN:** motor MAC integrado, colas de downlink, correlación con `GW_TX_ACK`; uplinks por UDP (por defecto puerto **1700**), HTTP o flujos Milesight MQTT según configuración.
- **Automatizaciones y webhooks:** reglas en servidor (ver `server/automation-runner.js` y UI **Automatización**).

### Autenticación y roles

- **JWT** de sesión, refresh y rate limiting en login (`server/server.js`, políticas en `.env.example`).
- **Setup inicial:** si la tabla de usuarios está **vacía** (`GET /api/setup/status` → `needsSetup: true`), la app muestra el formulario para crear el **primer superadministrador**. En cuanto existe **al menos un usuario**, se muestra el **login** habitual. La importación opcional de datos de demo desde `server/db.json` requiere `SYSCOM_IMPORT_LEGACY_DB_JSON=1` en `.env` (ver `.env.example`).
- **OAuth** Google / Microsoft / Yahoo: enlazan a usuarios existentes; roles y permisos vienen de SQLite (montaje en `server/*-auth-routes.js`).
- Política de contraseñas: `server/password-policy.js`; primer acceso forzado vía API (`/api/auth/first-password`).

### Integraciones y decodificadores

| Tema | Documentación |
|------|----------------|
| LNS Semtech UDP / GWMP, clase B, downlinks | [docs/LNS-SEMTECH-UDP.md](./docs/LNS-SEMTECH-UDP.md) |
| Capa de aplicación Shengda ALP v1.6 | [docs/SHENGDA-APP-LAYER-V1.6.md](./docs/SHENGDA-APP-LAYER-V1.6.md) |
| Medidor TimeWave (agua) | [docs/TIMEWAVE-WATER-METER.md](./docs/TIMEWAVE-WATER-METER.md) |
| Medidor Eastron SDM230 | [docs/EASTRON-SDM230.md](./docs/EASTRON-SDM230.md) |

Scripts operativos bajo `scripts/` (PowerShell y Node) para diagnóstico LNS: p. ej. `lns-diagnose-downlink.ps1`, `lns-udp-watch-1700.ps1`.

### Base de datos y “migraciones”

El esquema SQLite se **crea y evoluciona desde código** en `server/store.js` (`CREATE TABLE IF NOT EXISTS` y pasos de migración ligera inline). **No hay** carpeta de migraciones tipo Flyway/Liquibase ni comando npm dedicado a migraciones; copias de seguridad y ruta de archivo: `SYSCOM_SQLITE_PATH` y [docs/SYSCOM-SELFHOSTED.md](./docs/SYSCOM-SELFHOSTED.md).

### Docker

**No hay** `Dockerfile` ni `docker-compose` en la raíz de este subproyecto; el despliegue documentado es principalmente **VM / EC2** y guías en `docs/`.

## Antes de desplegar

Ejecutad en esta carpeta del subproyecto, en este orden, antes de publicar una versión:

```bash
npm run lint
npm run build
npm test
```

`npm run verify` es adicional para comprobar integraciones según `scripts/verify-integration.mjs`.

## Licencia

**MIT** — código de uso libre; texto legal en [LICENSE](../LICENSE) (raíz del monorepo). `"private": true` en `package.json` impide `npm publish` al registro público; no limita el uso del software bajo la licencia.
