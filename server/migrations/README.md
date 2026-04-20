# Migraciones de base de datos (SQLite)

Las migraciones se aplican **automáticamente al arrancar** el servidor, en orden numérico, mediante `runMigrations()` en [`runMigrations.js`](./runMigrations.js). El estado queda en **`schema_migrations`** (id + fecha de aplicación).

## Convención de archivos

- Los scripts SQL viven en [`sql/`](./sql/) con nombres **`NNNN_descripcion.sql`** (cuatro dígitos y guión bajo, p. ej. `0001_initial_schema.sql`).
- El orden es por prefijo numérico (`0001` … `0009` … `0010` …).
- Si una migración necesita lógica en Node (condicionales, `crypto`, bucles), se implementa en [`migrationHooks.js`](./migrationHooks.js) con la **misma clave** que el id (p. ej. `0002_user_password_nullable`). El hook tiene prioridad sobre el `.sql` del mismo nombre cuando existan ambos.
- Las bases que ya tenían filas con ids antiguos (`001_` … `010_`) reciben automáticamente las filas equivalentes `0001_` … `0010_` para no volver a ejecutar cambios destructivos.

## Cómo añadir una migración

1. Crea `sql/NNNN_nombre_descriptivo.sql` con el SQL idempotente cuando sea posible (`IF NOT EXISTS`, etc.).
2. Si hace falta código, añade `migrationHooks['NNNN_nombre_descriptivo']` en [`migrationHooks.js`](./migrationHooks.js).
3. Para `ALTER TABLE … ADD COLUMN` repetidos en instalaciones mixtas, puedes registrar el id en `IGNORE_DUP_STATEMENTS` en [`runMigrations.js`](./runMigrations.js) para ignorar solo el error “duplicate column”.
4. Documenta aquí el propósito.

## Historial (orden aplicado)

| id | Descripción |
|----|-------------|
| `0001_initial_schema` | Tablas e índices iniciales ([`sql/0001_initial_schema.sql`](./sql/0001_initial_schema.sql)) |
| `0002_user_password_nullable` | `users.password` nullable (OAuth) si la columna seguía NOT NULL |
| `0003_user_legacy_columns` | Columnas `must_change_password`, `picture_url` en BDs antiguas |
| `0004_device_schema` | `device_decode_config`, columnas LoRa en `user_devices`, `device_license` + backfill |
| `0005_lns_core` | Tablas `lorawan_lns_sessions`, `lorawan_lns_downlink` |
| `0006_lns_extra_columns` | Columnas adicionales LNS |
| `0007_lns_tx_inflight` | Tabla `lorawan_lns_tx_inflight` |
| `0008_lns_ui_events` | Tabla `lns_ui_events` |
| `0009_roles_normalize` | `viewer`→`user`, admins sin creador→`superadmin`, correos bootstrap→`superadmin` |
| `0010_seed_bootstrap_superadmins` | Alta de superadministradores SYSCOM si no existen ([`bootstrap-admins.js`](./bootstrap-admins.js)) |
| `0011_device_decode_downlinks` | Columna `downlinks_json` en `device_decode_config` (plantilla aplicada) |
| `0012_device_decode_downlinks_repair` | Repite `ADD COLUMN` con tolerancia a duplicado si `0011` quedó registrada sin ejecutar el `ALTER` |
| `0013_purge_devaddr_pseudo_devices` | Borra telemetría y `user_devices` con `device_id` tipo `devaddr-*` (alta automática indebida) |
| `0014_device_decode_lorawan_class` | Columna `lorawan_class` en `device_decode_config` + backfill desde `user_devices` (clase alineada con plantilla) |

## Superadministradores de arranque

La migración **`0010_seed_bootstrap_superadmins`** inserta (si no existen) estos usuarios con rol `superadmin` y contraseña `NULL` (acceso vía OAuth). La lista vive en código en [`bootstrap-admins.js`](./bootstrap-admins.js); la migración **`0009_roles_normalize`** también fuerza `superadmin` para estos correos.

| Nombre | Correo |
|--------|--------|
| Michelle Güereque | michelle.guereque@syscom.mx |
| Joanna Molina | joanna.molina@syscom.mx |

Esos correos **no pueden degradarse** de `superadmin` desde la API (`server.js`).
