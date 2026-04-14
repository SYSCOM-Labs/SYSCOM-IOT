# SYSCOM IoT — contexto para agentes

Resumen ejecutivo del repo; ampliar en `README.md` y `docs/` cuando haga falta.

## Qué es

- Plataforma **IoT auto-hospedada**: **React + Vite** (`src/`), API **Express** (`server/server.js`), datos **SQLite** vía `server/store.js` (Node `--experimental-sqlite`).
- **LoRaWAN / LNS**: HTTP, MQTT, UDP Semtech GWMP (`server/lns/`, integraciones).
- Tiempo casi real: **SSE** (`server/realtime/`, rutas `/api/events/stream`).
- **Auth**: principalmente **Google OAuth** (redirect); JWT en `Authorization: Bearer`. Roles: `superadmin` > `admin` > `user`.

## Arranque local

- Requisito: **Node ≥ 20.19**.
- Desarrollo recomendado: `npm run dev:all` (API + Vite). Vite suele ser `https://127.0.0.1:5173` y proxifica `/api` al backend (p. ej. `:3001`).
- Variables: copiar `.env.example` → `.env` (Google OAuth, `JWT_SECRET` en producción).

## Dónde tocar qué

| Área | Ubicación |
|------|-----------|
| Rutas UI (URLs en español) | `src/constants/routes.js` |
| API cliente | `src/services/localAuth.js`, `api.js` |
| Auth React | `src/context/AuthContext.jsx` |
| Servidor, rutas, middleware auth | `server/server.js` |
| Persistencia / SQL | `server/store.js`, migraciones `server/migrations/` |
| Superadmins semilla | `server/migrations/bootstrap-admins.js` + hooks en `migrationHooks.js` |

## Convenciones útiles

- **Cambios mínimos**: no refactors masivos ni archivos no pedidos; seguir estilo existente.
- **Rutas amigables**: `/panel`, `/dispositivos`, `/usuarios`, `/plantillas`, etc.
- **Producción**: `npm run build` + `NODE_ENV=production` y `JWT_SECRET` obligatorio.
- **i18n**: textos compartidos en `src/constants/translations.js`; sidebar usa `t('nav.*')` donde aplique.

## Tests / calidad

- `npm run lint`, `npm run build`, `npm test` antes de considerar listo un cambio grande.
- Tests de integración: `server/test/` (pueden requerir entorno coherente).

## Documentación adicional

- `README.md`: instalación, env, estructura, despliegue.
- `server/migrations/README.md`: orden de migraciones SQL.
- `docs/`: despliegue e integración de dispositivos.
