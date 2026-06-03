# Auditoría de Seguridad e Infraestructura — SYSCOM IoT

**Proyecto:** `LoraWan-Monitoreo-y-Control` (React 19 + Express 4 + SQLite vía `node:sqlite`)
**Fecha:** 2026-06-02
**Alcance:** pruebas dinámicas en local (API/web + capa LoRaWAN UDP) + auditoría estática de configuración de despliegue. No se atacó producción.
**Método:** suite reproducible `scripts/security-test.mjs` (22 comprobaciones) + `server/test/security-lorawan.test.cjs` (4 pruebas UDP) + `npm audit` + revisión de `deploy/`, `.env.example`, `nginx`, `systemd`.

## Cómo reproducir

```bash
cd LoraWan-Monitoreo-y-Control
node scripts/security-test.mjs --json          # API/web → docs/security-findings.json
node --test server/test/security-lorawan.test.cjs   # capa UDP/LoRaWAN
npm audit                                       # dependencias
```

---

## Resumen ejecutivo

| Severidad | Confirmados | Hallazgos |
|-----------|-------------|-----------|
| **ALTA**  | 2 | SEC-01 (UDP auto-registro no autenticado), SEC-02 (secreto JWT por defecto sin gate de `NODE_ENV`) |
| **MEDIA** | 7 | SEC-03 CORS permisivo en prod, SEC-04 sin cabeceras de seguridad, SEC-05 sin anti-replay de ingesta, SEC-06 deps vulnerables, SEC-07 nginx sin TLS/headers, SEC-08 datos sensibles en claro en SQLite, SEC-09 JWT en URL de SSE |
| **BAJA**  | 4 | SEC-10 gracia de refresh amplia, SEC-11 systemd sin hardening, SEC-12 token en localStorage, SEC-13 sin CI/escaneo |

**Aspectos verificados como CORRECTOS** (no requieren acción — ver §3): parametrización SQL, rechazo de `alg=none`, rate limit de login, política de contraseña, aislamiento de autorización (IDOR vertical y horizontal), idempotencia de setup, límite de tamaño de body, gate de arranque de `JWT_SECRET` en producción, verificación TLS del cliente UG65 por defecto.

> **Nota de corrección de la exploración inicial:** dos suposiciones previas resultaron **falsas** tras verificación: (a) el cliente del gateway UG65 **sí** valida TLS por defecto (`rejectUnauthorized !== false`); (b) la dependencia `lora-packet` **no** aparece en `npm audit`. Las vulnerabilidades reales de dependencias son otras (ver SEC-06).

---

## Estado de remediación (aplicado en esta auditoría)

| ID | Acción aplicada | Estado | Verificación |
|----|-----------------|--------|--------------|
| SEC-01 | Documentado riesgo + firewall UDP 1700 en `.env.example` (default ON conservado por decisión) | **Documentado** | `security-lorawan.test.cjs` #1 (demuestra), #2 (mitigación con flag OFF) |
| SEC-02 | Secreto dev ahora **aleatorio por arranque** (no constante pública); prod ya abortaba | **Corregido** | `security-test.mjs` AUTH-01 → OK (forja rechazada) |
| SEC-03 | Prod sin `SYSCOM_CORS_ORIGINS` ahora **aborta** el arranque | **Corregido** | CORS-02 → OK (exit 1) |
| SEC-04 | `helmet` añadido (HSTS, nosniff, X-Frame-Options, Referrer-Policy, CSP afinada) | **Corregido** | HDR-01 → OK (todas presentes) |
| SEC-05 | Guard anti-replay por fCnt en `saveIngestEntry` (rejoin/rollover contemplados) | **Corregido** | INGEST-02 → OK (replay rechazado) |
| SEC-06 | `npm audit fix` → **12 → 1** vulns. La HIGH restante (nodemailer) **no es alcanzable**: el transport no usa la opción `name` (vector CRLF). Bump a nodemailer@8 diferido | **Mitigado** | `npm audit` |
| SEC-07 | `nginx-*.conf.example` ampliado con bloque 443/TLS, redirección 80→443 y cabeceras | **Corregido** | revisión + `nginx -t` en despliegue |
| SEC-08 | Pendiente: cifrado/permisos de datos sensibles | **Pendiente** | — |
| SEC-09 | Pendiente: token efímero para SSE | **Pendiente** | — |
| SEC-10 | Ventana de gracia de refresh reducida **30 → 7 días** | **Corregido** | AUTH-02b → OK (8d rechazado) |
| SEC-11 | `syscom-iot.service` con directivas de hardening systemd | **Corregido** | revisión |
| SEC-12 | Mitigado parcialmente por CSP (SEC-04); cookie HttpOnly a futuro | **Mitigado** | — |
| SEC-13 | Workflow `.github/workflows/ci-security.yml` (build, test, suites de seguridad, audit) | **Corregido** | CI |

**Resultado de la suite tras remediación:** `scripts/security-test.mjs` → **0 hallazgos VULNERABLE** (22 comprobaciones); `security-lorawan.test.cjs` → 4/4; `npm test` → 5/5; `npm run build` → OK.

**Pendientes (requieren más trabajo o decisión):** SEC-08 (cifrado en reposo de tokens/claves), SEC-09 (rediseño del transporte de SSE). 

**Fuera de alcance / preexistente:** `npm run verify` y `npm run lint` fallan en `main` por causas **no relacionadas con seguridad** (desajuste de forma en `verify-integration.mjs` con `/properties/history`, y 63 errores ESLint en `src/`). No fueron introducidos por esta auditoría; conviene sanearlos para reactivarlos como gates de CI.

---

## 1. Hallazgos confirmados (con evidencia)

### SEC-01 — UDP 1700 no autenticado auto-registra gateways arbitrarios · **ALTA**
**Componente:** `server/semtech-udp-lns.js:193`, `server/lib/auto-fleet-sync.cjs` (`ensureGatewaysAutoRegistered`, `autoRegisterGatewayEnabled` → **default `true`**).
**Evidencia:** prueba `security-lorawan.test.cjs` #1 — un único datagrama `PUSH_DATA` con un EUI inventado (`aa11bb22cc33dd44`), sin credencial alguna, **registra un gateway en la cuenta superadmin**. El puerto bindea `0.0.0.0:1700`.
**Impacto:** cualquiera con alcance de red al puerto 1700 puede contaminar la flota e inyectar telemetría atribuida al tenant superadmin (integridad de datos, ruido operativo, posible DoS de almacenamiento). El EUI no necesita conocerse de antemano: el auto-registro lo crea.
**Por qué:** `SYSCOM_LNS_AUTO_REGISTER_GATEWAY` viene activo por defecto para "plug-and-play", pero combinado con un puerto abierto y sin auth es explotable.

### SEC-02 — Secreto JWT por defecto reutilizable sin gate de entorno · **ALTA**
**Componente:** `server/server.js:135` (`JWT_SECRET || 'syscom-iot-dev-insecure-jwt-secret-change-me'`). Gate solo en `NODE_ENV=production` (L129-134).
**Evidencia:** `security-test.mjs` AUTH-01 — un JWT forjado con el secreto por defecto y el `id` del superadmin obtiene `GET /api/users → 200` (suplantación total). `authMiddleware` re-lee rol/nav de la BD, así que forjar el id del superadmin = takeover completo.
**Impacto:** un despliegue que **olvide `NODE_ENV=production`** (error común) corre con un secreto público y conocido → cualquiera forja sesiones de cualquier usuario. El gate de producción mitiga el caso correcto, pero no el descuido.

### SEC-03 — CORS refleja cualquier Origin en producción sin lista · **MEDIA**
**Componente:** `server/server.js:183-187` (`origin: true` cuando `SYSCOM_CORS_ORIGINS` no está en prod).
**Evidencia:** `security-test.mjs` CORS-02 — instancia en `NODE_ENV=production` sin `SYSCOM_CORS_ORIGINS` responde `Access-Control-Allow-Origin: https://evil.example`.
**Impacto:** cualquier sitio puede invocar la API desde el navegador de un usuario autenticado. Mitigado parcialmente porque el JWT va en header `Authorization` (no en cookie), pero abre la puerta a fuga de respuestas si se añadieran cookies o a abuso de endpoints.

### SEC-04 — Sin cabeceras de seguridad HTTP (no usa `helmet`) · **MEDIA**
**Componente:** `server/server.js` (no hay `helmet`).
**Evidencia:** `security-test.mjs` HDR-01 — faltan `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`.
**Impacto:** sin CSP/X-Frame-Options aumenta el riesgo de clickjacking y de explotación de XSS; sin HSTS, downgrade a HTTP. Relevante porque el frontend guarda el token en `localStorage` (SEC-12).

### SEC-05 — Ingesta HTTP sin protección anti-replay (fCnt/nonce) · **MEDIA**
**Componente:** `server/server.js` (`runUplinkPipeline`, `/api/ingest/...`), dedup en `server/store.js:1981-1993`.
**Evidencia:** `security-test.mjs` INGEST-02 — reenviar uplinks con `fCnt` variable genera 5 registros. El único control es un dedup de **payload idéntico dentro de 8 s** (`SYSCOM_TELEMETRY_DEDUP_MS`), pensado para reducir ruido, **no** para rechazar replays. No se valida el frame counter LoRaWAN ni un nonce/HMAC en el endpoint HTTP.
**Impacto:** un atacante con un token de ingesta (o que capture uplinks) puede inyectar telemetría duplicada/falsa. El token de ingesta es la única credencial y viaja en la URL.

### SEC-06 — Dependencias con vulnerabilidades conocidas · **MEDIA** (1 HIGH)
**Componente:** `package.json` / `package-lock.json`. `npm audit`: **12 vulnerabilidades (9 moderadas, 3 altas)**.
**Evidencia destacada:**
- **`nodemailer` (HIGH)** — inyección de comandos SMTP vía CRLF en el nombre de transporte (GHSA-vvjj-xcjg-gr5g). Usado en notificaciones por correo.
- `qs` / `body-parser` / `express` (moderada) — DoS por `qs.stringify` (GHSA-q8mj-m7cp-5q26).
- `ws` (moderada) — divulgación de memoria no inicializada (GHSA-58qx-3vcg-4xpx).
**Impacto:** depende del vector; nodemailer es el más serio si se exponen entradas controladas al envío de correo.

### SEC-07 — Config nginx de ejemplo sin TLS ni cabeceras · **MEDIA**
**Componente:** `deploy/ec2/nginx-syscom-iot.conf.example` — solo `listen 80;`, sin `ssl`, sin `add_header`.
**Evidencia:** revisión estática; no hay bloque `443/ssl_certificate` ni cabeceras de seguridad en el proxy.
**Impacto:** quien siga el ejemplo al pie de la letra queda en HTTP plano (intercepción de tokens) y sin headers. La doc menciona certbot pero el ejemplo no lo plasma.

### SEC-08 — Datos sensibles en claro en SQLite · **MEDIA**
**Componente:** `server/store.js` — `ingest_token`, claves de sesión LoRaWAN (`nwk_skey`, `app_skey`), credenciales MQTT/SMTP en `server_settings`.
**Evidencia:** revisión de esquema. Sin cifrado en reposo; permisos del archivo dependen del SO (`SYSCOM_SQLITE_PATH`).
**Impacto:** lectura del archivo `.db` (backup mal protegido, acceso al host, export `/api/admin/database/export`) expone tokens y claves criptográficas reutilizables.

### SEC-09 — JWT de sesión en query string de SSE · **MEDIA**
**Componente:** `src/config/apiBase.js` (`getEventsStreamUrl` → `/api/events/stream?token=...`); server `authFromBearerOrQuery` (`server.js:2334`).
**Evidencia:** revisión; `EventSource` no admite cabeceras, por eso el token va en la URL.
**Impacto:** el token puede quedar en logs de nginx/proxies, historiales y referrers. Mitigado por HTTPS, pero los logs son el riesgo.

### SEC-10 — Ventana de gracia de refresh de 30 días · **BAJA** (diseño)
**Componente:** `server/server.js:153-156`, `refreshAuthMiddleware` (L1953).
**Evidencia:** `security-test.mjs` AUTH-02 — un token caducado hace 24 h se renueva (200). Más allá de 30 días sí se rechaza (AUTH-02b OK).
**Impacto:** un token caducado robado sigue siendo renovable hasta 30 días. Es una decisión deliberada para kioscos 24/7; se documenta como riesgo aceptado configurable.

### SEC-11 — Servicio systemd sin directivas de hardening · **BAJA**
**Componente:** `deploy/ec2/syscom-iot.service` — solo `User=syscom`; falta `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `RestrictAddressFamilies`, etc.
**Impacto:** menor contención si el proceso es comprometido. El `.env` con secretos se pasa por `--env-file`; revisar permisos `600`.

### SEC-12 — Token en `localStorage` (exposición a XSS) · **BAJA/MEDIA**
**Componente:** `src/context/AuthContext.jsx`, `src/services/api.js` (`local_token`).
**Impacto:** cualquier XSS exfiltra el token. Vinculado a SEC-04 (sin CSP) y SEC-09.

### SEC-13 — Sin CI ni escaneo de seguridad automatizado · **BAJA** (proceso)
**Componente:** no hay `.github/workflows/`; `npm audit` no está en ningún script.
**Impacto:** las regresiones de seguridad y los CVEs nuevos pasan desapercibidos.

---

## 2. Plan de remediación (qué hacer, en orden)

> Cada corrección se acompaña de su caso en `security-test.mjs` / `security-lorawan.test.cjs`: la suite debe pasar de roja a verde sin romper `npm run lint`, `npm run build`, `npm test` ni `npm run verify`.

### Prioridad ALTA
1. **SEC-01 — UDP:** cambiar el **default de `SYSCOM_LNS_AUTO_REGISTER_GATEWAY` a `false`** (opt-in explícito), documentar el firewall obligatorio en UDP 1700, y registrar un `log` claro cuando llegue un EUI desconocido. *Verifica:* test UDP #1 debe pasar a "no registra" salvo opt-in.
2. **SEC-02 — JWT:** no permitir el secreto por defecto fuera de desarrollo explícito. Opción robusta: si `NODE_ENV !== 'production'` **y** `JWT_SECRET` no está, generar un secreto **aleatorio por arranque** (sesiones no persisten entre reinicios en dev) en lugar de una constante pública; mantener el `exit(1)` en producción. Documentar `openssl rand -hex 32`.

### Prioridad MEDIA
3. **SEC-04 — `helmet`:** añadir `helmet()` tras crear `app` (HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP afinada para el SPA). Cierra de un golpe HDR-01.
4. **SEC-03 — CORS:** en `buildCorsOptions`, si `IS_PRODUCTION` y no hay `SYSCOM_CORS_ORIGINS`, **abortar el arranque** (como con JWT) en vez de `origin: true`.
5. **SEC-06 — deps:** `npm audit fix` para lo no disruptivo (qs, ws); evaluar el salto mayor de `nodemailer@8` o sanear el nombre de transporte; fijar en CI un umbral de `npm audit`.
6. **SEC-05 — anti-replay:** dedup por `deviceId + fCnt` (o `deviceId + ts` exacto) en `runUplinkPipeline`; opcionalmente HMAC del cuerpo con el token de ingesta. Documentar que el token de ingesta no debe ir en logs.
7. **SEC-07 — nginx:** ampliar el ejemplo con bloque `443 ssl` + `Strict-Transport-Security` y redirección 80→443; nota de certbot.
8. **SEC-08 — datos sensibles:** permisos `600` del `.db`, cifrado de credenciales MQTT/SMTP en `server_settings` (ya existe `SYSCOM_SMTP_ENCRYPTION_KEY`; extender), y advertir sobre la protección del export.
9. **SEC-09 — SSE:** migrar a token efímero de un solo uso para SSE o cookie `HttpOnly`; mientras tanto, `proxy_set_header`/log scrubbing para no registrar el query.

### Prioridad BAJA / proceso
10. **SEC-10:** reducir el default de `SYSCOM_JWT_REFRESH_GRACE_MS` (p. ej. 7 días) o documentar explícitamente el trade-off de kiosco.
11. **SEC-11:** añadir directivas de hardening al unit systemd.
12. **SEC-12:** mitigado por CSP (SEC-04); valorar a futuro cookie `HttpOnly`.
13. **SEC-13:** workflow `.github/workflows/ci-security.yml` con `lint`, `test`, `verify`, `npm audit`, `node scripts/security-test.mjs` y la suite UDP.

---

## 3. Verificado como correcto (sin acción)

| Comprobación | Resultado | Evidencia |
|---|---|---|
| Inyección SQL (parametrización) | OK | INJ-01: payloads no rompen ni alteran la BD (`db.prepare`) |
| JWT `alg=none` | OK | AUTH-03: rechazado (jsonwebtoken exige HS256 con secreto) |
| Rate limit de login | OK | AUTH-04: 429 al superar el límite |
| Política de contraseña | OK | AUTH-05: rechaza débiles |
| Idempotencia de setup | OK | AUTH-07: segundo setup → 409 |
| Endpoints protegidos exigen token | OK | AUTHZ-01: 401 sin token |
| Escalada vertical de privilegios | OK | AUTHZ-02/03: user → 403 |
| IDOR horizontal (dispositivos) | OK | AUTHZ-04: bob no accede a dispositivos de alice |
| Token de ingesta inválido | OK | INGEST-01: 401 |
| Límite de tamaño de body | OK | INJ-04: 2 MB → 413 (`express.json limit:'2mb'`) |
| Gate de `JWT_SECRET` en producción | OK | PROD-01: `exit(1)` sin secreto |
| TLS del cliente UG65 | OK | `rejectUnauthorized !== false` por defecto (server.js:1018/1039/2410) |
| Robustez del listener UDP | OK | test UDP #3: basura no tumba el proceso |
| Aislamiento UDP con auto-register OFF | OK | test UDP #2: EUI desconocido no se registra |
