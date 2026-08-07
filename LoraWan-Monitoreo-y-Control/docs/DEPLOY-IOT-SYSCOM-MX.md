# Despliegue en producción — iot.syscom.mx (servidor propio)

Guía del **deploy inicial** realizado sobre el VPS de producción de SYSCOM IoT: Ubuntu 24.04, Node.js 22, systemd, nginx como reverse proxy y SQLite en `/var/lib/syscom-iot`. Para una guía genérica (AWS EC2) ved [DEPLOY-AWS-EC2.md](./DEPLOY-AWS-EC2.md); aquí solo se documenta lo **específico de este servidor**.

## Inventario del servidor

| Elemento | Valor |
|----------|-------|
| **Dominio** | `iot.syscom.mx` |
| **Alias de servidor** | `syscom-iot` (ver [§ Alias `syscom-iot`](#alias-syscom-iot)) |
| **IP pública** | ver `DEPLOY_HOST` (fuentes de valores abajo) |
| **Usuario SSH / deploy** | ver `DEPLOY_USER` |
| **SO** | Ubuntu 24.04.4 LTS, 2 vCPU, 3.4 GiB RAM, 50 GB disco |
| **App** | `/opt/syscom-iot/app` (usuario de servicio `syscom`, sin login) |
| **Env runtime** | `/opt/syscom-iot/.env` (`chmod 600`, propiedad de `syscom`) |
| **SQLite** | `/var/lib/syscom-iot/data.sqlite` |
| **Servicio** | `systemctl status syscom-iot` |
| **Reverse proxy** | nginx → `127.0.0.1:3001` (sitio `syscom-iot` en `sites-available`) |
| **Firewall local** | UFW: 22, 80, 443 TCP; **1700 UDP** (LNS Semtech) |

## Fuentes de valores (nada de secretos en este repo)

Las credenciales y secretos **no** viven en git. Referencias:

1. **Archivo original entregado por infraestructura:** `~/Downloads/temp-syscom-iot.rtf` (en la máquina local de operación) — IP, usuario, contraseña sudo y llave privada SSH (`ingenieria-iot.pem`).
2. **Copia local de trabajo (gitignored):** [`../.env.deploy.local`](../.env.deploy.local) en la raíz de este subproyecto — cubierto por `.gitignore` (`".env.*"`). Contiene `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PASSWORD`, `DEPLOY_SSH_KEY_PATH`, `DEPLOY_DOMAIN`, `DEPLOY_SERVER_ALIAS` y rutas del servidor.
3. **Llave SSH local:** `~/.ssh/ingenieria-iot.pem` (`chmod 600`).
4. **GitHub → Settings → Secrets and variables → Actions** (repo `SYSCOM-Labs/SYSCOM-IOT`): `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` — los consume [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml).
5. **Secretos de runtime** (JWT, CORS, etc.): solo en `/opt/syscom-iot/.env` del servidor; se generaron ahí mismo con `openssl rand -hex 32` en el deploy inicial.

## Alias `syscom-iot`

El servidor opera con hostname **`iot.syscom.mx`** y `syscom-iot` quedó configurado como **alias** en tres niveles:

| Nivel | Dónde | Efecto |
|-------|-------|--------|
| DNS local del servidor | `/etc/hosts`: `127.0.1.1 iot.syscom.mx syscom-iot iot` | `ping syscom-iot`, `getent hosts syscom-iot` resuelven en el propio servidor |
| HTTP | nginx: `server_name iot.syscom.mx syscom-iot;` | el sitio responde también si la petición llega con `Host: syscom-iot` |
| SSH (máquina local) | `~/.ssh/config`: bloque `Host syscom-iot` | `ssh syscom-iot` equivale a `ssh -i ~/.ssh/ingenieria-iot.pem ingenieria@<DEPLOY_HOST>` |

## Estado del despliegue

Hecho en el deploy inicial (fecha: 2026-08-07):

- Node.js 22 (NodeSource), nginx, rsync, UFW, certbot instalados.
- Usuario de servicio `syscom`; app en `/opt/syscom-iot/app`; SQLite en `/var/lib/syscom-iot`.
- `/opt/syscom-iot/.env` creado con `NODE_ENV=production`, `JWT_SECRET`, `LNS_INTEGRATION_JWT_SECRET`, `SYSCOM_CORS_ORIGINS`, `SYSCOM_SQLITE_PATH`, `SYSCOM_TRUST_PROXY=1`.
- Unidad systemd activa: derivada de [`deploy/ec2/syscom-iot.service`](../deploy/ec2/syscom-iot.service) con `ReadWritePaths=/opt/syscom-iot /var/lib/syscom-iot`.
- nginx sirviendo el sitio `syscom-iot` con **HTTPS :443 (certificado autofirmado)** y **redirección 80 → 443**; certs en `/etc/nginx/syscom-certs/` (fuera del app dir a propósito: el rsync `--delete` de `deploy.yml` borraría cualquier cert dentro de la app). SANs: `iot.syscom.mx`, `syscom-iot`, IP pública. El navegador mostrará aviso de certificado no confiable hasta sustituirlo por Let's Encrypt.
- Primer arranque verificado: `GET /api/setup/status` → `{"needsSetup":true}` (alta del superadmin pendiente vía UI).
- Sudoers acotado para CI en `/etc/sudoers.d/syscom-iot-deploy` (NOPASSWD solo para `rsync`, `chown` del app dir, `systemctl restart syscom-iot` y `npm` como `syscom` — lo que usa `deploy.yml`). El usuario conserva su sudo normal con contraseña.

### Pendiente (requiere consola del proveedor cloud / DNS)

1. **Security group del proveedor (Huawei Cloud México):** el firewall externo solo admite 22/TCP — desde Internet, 80/443 y 1700/UDP dan `ERR_TIMED_OUT` aunque UFW los permite. En la consola Huawei Cloud: **Consola ECS → instancia → pestaña "Security Groups" → "Add Rule"**, entrada (Inbound): **80/TCP**, **443/TCP** y **1700/UDP** desde `0.0.0.0/0` (o la IP/red de operación si se quiere restringir).
2. **DNS:** crear registro **A** `iot.syscom.mx` → IP del servidor (al 2026-08-07 aún no resuelve).
3. **Let's Encrypt (sustituir el autofirmado):** con 1 y 2 listos, en el servidor:

   ```bash
   sudo certbot --nginx -d iot.syscom.mx   # reescribe el sitio con los certs reales
   ```

   `SYSCOM_HTTPS=1` ya está en `/opt/syscom-iot/.env`; no hay que tocar nada más.

## Operación día a día

```bash
ssh syscom-iot                                  # entrar al servidor (alias local)
systemctl status syscom-iot                     # estado (sin sudo)
journalctl -u syscom-iot -f                     # logs en vivo (grupo systemd-journal, sin sudo)
echo '<DEPLOY_PASSWORD>' | sudo -S systemctl restart syscom-iot   # reinicio manual
```

Actualizaciones: cada `git push` a `main` dispara `deploy.yml` (runner self-hosted `iot`): compila el front, hace rsync a `/opt/syscom-iot/app/` y reinicia el servicio. También se puede lanzar manual desde **Actions → Deploy a producción → Run workflow**.

## Incidencias habituales

| Síntoma | Comprobación |
|---------|--------------|
| `iot.syscom.mx` no abre | ¿DNS propagado? `dig +short iot.syscom.mx`. ¿Security group abre 80/443? Mientras tanto: `https://<DEPLOY_HOST>` (aceptando el aviso del cert autofirmado) |
| El navegador advierte "conexión no privada" | Esperado con el cert autofirmado; desaparece al emitir Let's Encrypt (pendiente §) |
| 502 Bad Gateway | `systemctl status syscom-iot`, `journalctl -u syscom-iot -e` |
| El deploy CI falla en SSH | Secrets `DEPLOY_*` en GitHub; puerto 22 abierto; llave `~/.ssh/ingenieria-iot.pem` íntegra |
| El deploy CI falla en sudo | `sudo -l -U ingenieria` en el servidor; archivo `/etc/sudoers.d/syscom-iot-deploy` |
| LNS UDP sin tráfico | Security group (1700/UDP) **y** UFW; ver [LNS-SEMTECH-UDP.md](./LNS-SEMTECH-UDP.md) |
| Sesiones web caen tras reinicio | Falta `JWT_SECRET` fijo en `/opt/syscom-iot/.env` (no debería: se fijó en el deploy inicial) |
