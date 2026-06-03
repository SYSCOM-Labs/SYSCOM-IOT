# Despliegue 24/7 en Windows (LNS sin sesión web)

## Qué ocurre al cerrar sesión en el navegador

**Cerrar sesión web** solo elimina el token JWT en el navegador. **No detiene**:

- Motor LoRaWAN / LNS (UDP Semtech, puerto 1700 por defecto)
- Base de datos SQLite
- Automatizaciones por horario (`SYSCOM_SERVER_AUTOMATION_SCHEDULE=1`, activo por defecto)

Lo que **sí detiene** el motor es **cerrar la terminal** donde corre `npm start` o apagar el PC.

En desarrollo, `npm start` lanza API + Vite en un proceso padre; **Ctrl+C** o cerrar la ventana de PowerShell/CMD detiene LNS y las reglas horarias dejan de ejecutarse.

## Modo producción (recomendado en el gateway / PC servidor)

Desde `LoraWan-Monitoreo-y-Control`:

```powershell
Copy-Item .env.example .env   # si aún no existe
# Editar .env: JWT_SECRET, SYSCOM_SQLITE_PATH, PORT, LNS_UDP_PORT, etc.

npm install
npm run production
```

`npm run production` = `npm run build` + API en `NODE_ENV=production` sirviendo `dist/`.

Comprobar que el motor sigue activo **sin iniciar sesión en la web**:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/health/platform
```

Respuesta esperada (ejemplo):

```json
{
  "ok": true,
  "sessionRequired": false,
  "services": {
    "lnsMac": true,
    "lnsEngine": true,
    "lnsUdpActive": true,
    "automationServer": true,
    "automationSchedule": true
  }
}
```

En los logs del servidor, al entrar/salir de una ventana horaria:

```
[automation] Horario INICIO regla="..." usuario=...
[automation] Horario FIN regla="..." usuario=...
```

## Arranque automático al encender Windows

### Opción A — Tarea programada (sin software extra)

1. `npm run build` (una vez tras cada actualización de código)
2. Configurar `.env` con `JWT_SECRET` y rutas persistentes
3. Instalar la tarea:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-syscom-task.ps1
```

4. Probar: `Start-ScheduledTask -TaskName 'SyscomIoT-Production'`

### Opción B — Servicio Windows con NSSM

[NSSM](https://nssm.cc/) permite registrar Node como servicio del sistema (arranque antes del login).

```powershell
nssm install SyscomIoT "C:\Program Files\nodejs\node.exe" `
  "--experimental-sqlite" "--env-file=C:\ruta\app\.env" "C:\ruta\app\server\server.js"
nssm set SyscomIoT AppDirectory C:\ruta\app
nssm set SyscomIoT AppEnvironmentExtra NODE_ENV=production
nssm start SyscomIoT
```

Ajuste rutas según su instalación. Ejecute `npm run build` antes del primer arranque.

## Desarrollo vs producción

| Comando | Uso | ¿Sobrevive cerrar sesión web? | ¿Sobrevive cerrar terminal? |
|---------|-----|--------------------------------|-----------------------------|
| `npm start` | Desarrollo (API + Vite HMR) | Sí (si la terminal sigue abierta) | **No** |
| `npm run production` | Producción en consola | Sí | **No** |
| Tarea / servicio Windows | Gateway 24/7 | Sí | **Sí** |

## Firewall

Permita tráfico **UDP 1700** (Semtech GWMP) hacia el host donde corre el LNS, además del puerto HTTP (`PORT`, default 3001).

## Resolución de problemas

| Síntoma | Causa probable | Acción |
|---------|----------------|--------|
| Todos los dispositivos «Desconectado» tras irse | Proceso Node detenido | Usar tarea/servicio; verificar `/api/health/platform` |
| Vuelven «En línea» uno a uno al iniciar sesión | Servidor recién arrancado; uplinks repoblan BD | Mantener servidor 24/7; no depender del login |
| Regla horaria no ejecuta | Servidor apagado o `SYSCOM_SERVER_AUTOMATION_SCHEDULE=0` | Revisar logs `[automation] Horario` y health |
| Health OK pero sin uplinks | Gateway no alcanza UDP 1700 | Red/firewall; `scripts/lns-udp-watch-1700.ps1` |
