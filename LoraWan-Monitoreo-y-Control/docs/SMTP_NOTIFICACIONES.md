# Notificaciones por correo (SMTP gratuito)

SYSCOM IoT envía correos de automatización desde el **servidor** (Node.js + nodemailer), sin EmailJS ni servicios de pago.

## Configuración rápida

### Desarrollo

1. En la carpeta `LoraWan-Monitoreo-y-Control`, copie `.env.example` → `.env`.
2. Defina al menos:

```env
SYSCOM_SMTP_PROVIDER=gmail
SYSCOM_SMTP_USER=su-cuenta@gmail.com
SYSCOM_SMTP_PASS=contraseña-de-aplicación-16-caracteres
```

3. Ejecute `npm install` (instala `nodemailer`).
4. Reinicie el backend (`npm start` o `npm run start:api`).
5. En la app: **Ajustes** → sección SMTP → **Enviar prueba**.

### Producción

- **Nunca** suba `.env` al repositorio.
- Use variables del sistema o del panel del hosting (`SYSCOM_SMTP_USER`, `SYSCOM_SMTP_PASS`).
- Las variables de entorno **tienen prioridad** sobre lo guardado en Ajustes.
- En Ajustes solo el **superadmin** puede guardar o probar SMTP.

---

## Cuentas gratuitas: pasos por proveedor

### Gmail (@gmail.com o Google Workspace)

1. Cuenta Google con **verificación en dos pasos** activada.
2. [Contraseñas de aplicación](https://myaccount.google.com/apppasswords) → crear una para «Correo» / «Otro».
3. Use esa contraseña de 16 caracteres en `SYSCOM_SMTP_PASS` (no la contraseña normal).
4. Variables recomendadas:

```env
SYSCOM_SMTP_PROVIDER=gmail
SYSCOM_SMTP_USER=tu@gmail.com
SYSCOM_SMTP_PASS=xxxx xxxx xxxx xxxx
```

**Límite orientativo:** ~**500 correos/día** por cuenta (cuenta personal). Google puede reducir el límite si detecta uso automatizado o spam.

### Outlook / Hotmail / Live (@outlook.com, @hotmail.com, @live.com)

1. Active **autenticación en dos pasos** en la cuenta Microsoft.
2. [Contraseñas de aplicación](https://account.live.com/proofs/AppPassword) (o Seguridad avanzada → contraseñas de aplicación).
3. SMTP: `smtp-mail.outlook.com`, puerto **587**, STARTTLS.

```env
SYSCOM_SMTP_PROVIDER=outlook
SYSCOM_SMTP_USER=tu@outlook.com
SYSCOM_SMTP_PASS=contraseña-de-aplicación
```

**Límite orientativo:** ~**300 correos/día** (cuenta gratuita de consumo). Microsoft 365 gratuito puede variar.

### Yahoo Mail

1. Activar verificación en dos pasos.
2. [Generar contraseña de aplicación](https://help.yahoo.com/kb/generate-third-party-passwords-sln15241.html).
3. `smtp.mail.yahoo.com:587`.

**Límite orientativo:** ~**500 correos/día** (puede variar según reputación de la cuenta).

### GMX

1. En GMX: activar acceso **POP3/IMAP/SMTP** en ajustes de la cuenta.
2. Usar contraseña de la cuenta o contraseña específica si GMX la ofrece.
3. `mail.gmx.com:587`.

**Límite orientativo:** ~**100 correos/día** (GMX es más restrictivo; ideal como cuenta secundaria de respaldo).

---

## Límites y cola en SYSCOM

| Proveedor | Límite diario (referencia) | Host |
|-----------|---------------------------|------|
| Gmail | ~500 | smtp.gmail.com:587 |
| Outlook | ~300 | smtp-mail.outlook.com:587 |
| Yahoo | ~500 | smtp.mail.yahoo.com:587 |
| GMX | ~100 | mail.gmx.com:587 |

La app lleva un **contador diario (UTC)** y, al llegar al límite configurado (`SYSCOM_SMTP_DAILY_LIMIT` o el del proveedor), **encola** los mensajes en SQLite (`email_outbox`) y los reintenta tras medianoche UTC o cuando el worker detecta capacidad.

Variables útiles:

| Variable | Efecto |
|----------|--------|
| `SYSCOM_SMTP_DAILY_LIMIT` | Tope local (por debajo del del proveedor para margen) |
| `SYSCOM_SMTP_RATE_PER_MIN` | Máximo de envíos por ciclo de cola (defecto 10) |
| `SYSCOM_SMTP_QUEUE_INTERVAL_MS` | Cada cuánto se procesa la cola (defecto 60000) |

---

## Errores habituales

| Síntoma | Causa probable | Qué hacer |
|---------|----------------|-----------|
| `AUTH_FAILED` | Contraseña normal en lugar de contraseña de app | Crear contraseña de aplicación |
| `TIMEOUT` | Firewall bloquea 587/465 | Abrir salida TCP 587 o usar 465 + `SYSCOM_SMTP_SECURE=1` |
| `RATE_LIMIT` | Límite diario del proveedor | Esperar o rotar a otra cuenta gratuita |
| `SPAM_POLICY` | Contenido o reputación | Acortar mensajes, evitar muchos enlaces; pedir marcar «No es spam» |
| Correo no llega | Carpeta spam | Revisar spam; usar remitente coherente con la cuenta SMTP |

Los logs del servidor muestran destinatarios **enmascarados** (`ab***@gmail.com`), nunca la contraseña.

---

## Si Gmail bloquea el envío

1. Comprobar [https://www.google.com/accounts/DisplayUnlockCaptcha](https://accounts.google.com/DisplayUnlockCaptcha) (sesión reciente).
2. Reducir frecuencia de reglas de automatización (cooldown / reactivación).
3. Cambiar a **Outlook** o **GMX** con otra cuenta dedicada solo a alertas IoT.
4. Repartir alertas entre dos cuentas (dos despliegues o rotación manual de `SYSCOM_SMTP_USER` en mantenimiento).

Todo sigue siendo **gratuito**; no se requiere SendGrid, Mailgun ni similar.

---

## Seguridad

- Credenciales en **`.env`** en producción.
- Contraseña en SQLite (si se guarda desde Ajustes) cifrada con AES-256-GCM usando `SYSCOM_SMTP_ENCRYPTION_KEY` o `JWT_SECRET`.
- No registrar contraseñas ni cuerpos completos de correo en logs.
- Automatizaciones: el destinatario va en cada acción «Enviar email» de la regla; el servidor solo usa la cuenta saliente global.

---

## Automatizaciones

Las reglas con acción **Enviar email** se ejecutan en el **servidor** al llegar telemetría (igual que los downlinks). No hace falta tener el navegador abierto.

**Subcuentas:** todas las cuentas de tipo usuario pueden disparar correos con el **mismo SMTP global** que configuró el superadmin. No necesitan permiso de «Ajustes» ni ser superadmin. Sí necesitan tener reglas propias (el superadmin puede otorgar permiso «Automatización» para crearlas, o crearlas desde su cuenta y asignar dispositivos a la subcuenta).

Los **downlinks** automáticos siguen requiriendo el permiso de navegación **Automatización**.

Campos de la acción:

- **Destinatario:** correo del campo «target» de la acción.
- **Asunto / cuerpo:** opcionales; si están vacíos se generan desde el nombre de la regla y las condiciones.
