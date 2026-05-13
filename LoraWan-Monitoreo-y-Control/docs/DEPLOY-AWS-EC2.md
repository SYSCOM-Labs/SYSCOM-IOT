# Despliegue en AWS EC2 (Syscom IoT)

Guía para ejecutar la aplicación en una **instancia EC2** (Amazon Linux 2023 u otra distribución similar), con **Node.js**, **systemd**, **Nginx** opcional delante y persistencia **SQLite** en disco.

## Resumen

| Componente | Rol |
|------------|-----|
| **Node.js** `^20.19` o `>=22.12` | Motor (`package.json` → `engines`). |
| **`npm run build` + `npm start`** | Sirve API Express y la UI desde `dist/` en el puerto `PORT` (por defecto **3001**). |
| **SQLite** | Base en `SYSCOM_SQLITE_PATH` (recomendado: volumen EBS, no solo la imagen efímera). |
| **Nginx** (opcional) | HTTPS, proxy a `127.0.0.1:3001`, cabeceras `X-Forwarded-*`. |
| **Security Group** | TCP **22** (SSH), **80**/**443** (HTTP/HTTPS); si usáis **LNS UDP Semtech**, abrid **UDP 1700** (o el valor de `LNS_UDP_PORT`). |

## 1. Crear la instancia

1. **AMI**: *Amazon Linux 2023* (o Ubuntu 22.04; adaptá los comandos de paquetes).
2. **Tipo**: como mínimo **t3.small** para compilación y tráfico moderado (ajustad según carga).
3. **Almacenamiento**: disco raíz **≥ 20 GiB** (build + SQLite + logs); para más datos, volumen EBS adicional montado en p. ej. `/var/lib/syscom-iot`.
4. **Security Group**:
   - Entrada: SSH desde vuestra IP; HTTP/HTTPS desde Internet (o solo vuestra red).
   - Si el **gateway LoRa** envía **UDP Semtech** a esta máquina: regla **UDP** al puerto configurado (`LNS_UDP_PORT`, por defecto **1700**).
5. **Elastic IP** (opcional): IP fija para DNS del gateway y firewalls.

## 2. Node.js en la instancia

Instalad una versión compatible con `engines` (ejemplo con **NodeSource** para Node **22** en Amazon Linux 2023):

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs git
node -v   # debe ser >= 20.19 o >= 22.12
```

Alternativa: [Node Version Manager (nvm)](https://github.com/nvm-sh/nvm) bajo el usuario de despliegue.

## 3. Desplegar el código

Convención usada en los archivos de ejemplo: aplicación en **`/opt/syscom-iot/app`**.

```bash
sudo mkdir -p /opt/syscom-iot
sudo chown $USER:$USER /opt/syscom-iot
cd /opt/syscom-iot
git clone <URL-de-tu-repo> app
cd app
npm ci
npm run build
```

Producción:

```bash
export NODE_ENV=production
export JWT_SECRET='<cadena-larga-aleatoria>'
# Opcional: base de datos persistente
export SYSCOM_SQLITE_PATH=/var/lib/syscom-iot/data.sqlite
sudo mkdir -p /var/lib/syscom-iot
sudo chown $USER:$USER /var/lib/syscom-iot
npm start   # prueba manual; luego pasad a systemd
```

Copiad [`.env.example`](../.env.example) a **`/opt/syscom-iot/.env`** (no lo subáis a Git), editad al menos:

- `JWT_SECRET`
- `NODE_ENV=production`
- `SYSCOM_CORS_ORIGINS` (origen público del front, p. ej. `https://iot.ejemplo.com`)
- `SYSCOM_SQLITE_PATH`
- Si el front y la API comparten dominio detrás de Nginx, **no** hace falta `VITE_API_BASE` (rutas relativas `/api`).

Permisos:

```bash
chmod 600 /opt/syscom-iot/.env
```

## 4. Servicio systemd

Copiad el unit de ejemplo y adaptad usuario/rutas si no usáis `syscom`:

```bash
sudo useradd -r -s /usr/sbin/nologin -d /opt/syscom-iot/app syscom 2>/dev/null || true
sudo chown -R syscom:syscom /opt/syscom-iot/app /var/lib/syscom-iot
sudo cp deploy/ec2/syscom-iot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now syscom-iot
sudo systemctl status syscom-iot
```

El fichero arranca Node con `--experimental-sqlite` y `--env-file` (igual espíritu que `scripts/start-with-env.mjs`). Revisad **`User=`** y rutas en [`deploy/ec2/syscom-iot.service`](../deploy/ec2/syscom-iot.service).

## 5. Nginx + HTTPS (recomendado en Internet)

1. Instalación en Amazon Linux 2023:

```bash
sudo dnf install -y nginx
```

2. Copiad [`deploy/ec2/nginx-syscom-iot.conf.example`](../deploy/ec2/nginx-syscom-iot.conf.example) a `/etc/nginx/conf.d/syscom-iot.conf`, cambiad `server_name` y rutas de certificados.
3. Certificados **Let's Encrypt** (ejemplo con certbot):

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d iot.ejemplo.com
```

El ejemplo incluye **`proxy_buffering off`** en **`/api/events/stream`** para **SSE** (EventSource).

Recargad Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

El proceso Node puede seguir escuchando solo en **127.0.0.1:3001** si cerráis el puerto 3001 al mundo en el Security Group y dejáis solo **80/443** públicos.

## 6. Actualizar versión (despliegue)

```bash
cd /opt/syscom-iot/app
sudo -u syscom git pull
sudo -u syscom npm ci
sudo -u syscom npm run build
sudo systemctl restart syscom-iot
```

## 7. LNS UDP (Packet Forwarder)

En EC2 **sí** podéis exponer **UDP** al puerto del LNS (`LNS_UDP_PORT`), a diferencia de PaaS solo HTTP. Aseguráos de:

- Regla **Security Group** UDP entrante al puerto correcto.
- En router/firewall del gateway, destino = IP elástica / DNS del servidor.
- Variables `SYSCOM_LNS_*` según [LNS-SEMTECH-UDP.md](./LNS-SEMTECH-UDP.md).

## 8. Script de apoyo

[`deploy/ec2/bootstrap-amazon-linux-2023.sh`](../deploy/ec2/bootstrap-amazon-linux-2023.sh) instala Node 22 (NodeSource), herramientas básicas y crea directorios; ejecutarlo como **usuario con sudo** en una instancia nueva. **No** sustituye configurar `.env` ni clonar vuestro repo privado (necesitáis token SSH o credenciales).

## 9. Copias de seguridad

- Volcad periódicamente el archivo SQLite (`SYSCOM_SQLITE_PATH`) y el directorio de la app si guardáis uploads locales.
- Considerad **snapshot EBS** o backup a S3.

## 10. Incidencias habituales

| Síntoma | Comprobación |
|---------|----------------|
| 502 Bad Gateway | `systemctl status syscom-iot`, logs `journalctl -u syscom-iot -e`. |
| UI en blanco | ¿Existe `dist/`? Ejecutad `npm run build`. |
| CORS | `SYSCOM_CORS_ORIGINS` debe incluir el origen exacto del navegador (esquema + host). |
| SSE cortado | Nginx: `proxy_buffering off` en la ruta de stream (ver ejemplo). |
| LoRa no entra por UDP | Security Group, firewall local (`firewalld`/`iptables`), `LNS_UDP_PORT`. |
