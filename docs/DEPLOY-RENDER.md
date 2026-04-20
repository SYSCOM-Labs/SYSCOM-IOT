# Despliegue gratis en Render.com (SYSCOM IoT)

Un solo **Web Service** sirve la API Express y la UI (carpeta `dist/`). Sin coste en plan **Free** (el servicio se duerme tras ~15 min sin tráfico; el primer acceso puede tardar ~1 min en despertar).

## Requisitos

- Cuenta en [render.com](https://render.com) (GitHub/GitLab/Bitbucket conectado).
- Código en un repositorio Git (sube este proyecto).

## Opción A — Blueprint (recomendada)

1. En Render: **New +** → **Blueprint**.
2. Conecta el repo y elige la rama (p. ej. `main`).
3. Render detectará `render.yaml` y creará el servicio.
4. Si `JWT_SECRET` no se genera solo, en el servicio → **Environment** → añade:
   - `JWT_SECRET` = cadena larga aleatoria (no la compartas ni la subas al repo).

5. Tras el primer deploy, abre la URL tipo `https://syscom-iot.onrender.com`.

## Opción B — Manual

1. **New +** → **Web Service** → conecta el repo.
2. Configuración:
   - **Runtime:** Node
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Instance type:** Free
3. **Environment variables:**
   - `NODE_ENV` = `production`
   - `JWT_SECRET` = (valor aleatorio fuerte)
4. Opcional: **Node version** en variables o `NODE_VERSION` = `22.12.0` (como en `render.yaml`).

## Cómo funciona la API en el navegador

El front usa rutas relativas **`/api`** (archivo `src/config/apiBase.js`). En producción, el mismo dominio sirve React y Express, así que no hace falta configurar URL absoluta.

Si algún día separas front y API en dominios distintos, define en el build:

`VITE_API_BASE=https://tu-api.com/api`

## SQLite en plan gratuito

La base vive en disco del contenedor. **Puede perderse** al redeploy o si Render mueve la instancia. Es aceptable para **pruebas**; en producción de pago usa volumen persistente o base gestionada.

## Gateway / ingesta

En **Ajustes** la app mostrará la URL pública de ingesta usando el origen actual (`https://tu-servicio.onrender.com`). Configura el gateway para apuntar ahí.

### Semtech UDP (Packet Forward) y Render

El **LNS integrado por UDP** (por defecto `LNS_UDP_PORT=1700`, protocolo Semtech GWMP) **no** puede usarse en un Web Service de Render: solo entra tráfico **HTTP/HTTPS** al contenedor, no UDP. El blueprint [`render.yaml`](../render.yaml) fija `LNS_UDP_PORT=0` para no sugerir un GWMP “listo” sin UDP. Para Packet Forward **Semtech** hacia SYSCOM IoT use un servidor propio (VM, bare metal, Raspberry Pi con IP pública, etc.) o el ejemplo [`docker-compose.yml`](../docker-compose.yml) con **1700/udp** publicado y reenvío en el router. Las URLs **HTTPS** de ingesta siguen funcionando en Render.

## Desarrollo local (sin cambios)

1. Terminal 1: `npm start` (API en 3001).
2. Terminal 2: `npm run dev` (Vite en 5173 con proxy `/api` → 3001).
