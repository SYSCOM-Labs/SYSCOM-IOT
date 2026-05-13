# SYSCOM-IOT

Repositorio de productos **SYSCOM** para soluciones **IoT** y **LoRaWAN**. Agrupa el código operativo y espacio para proyectos relacionados que se irán incorporando.

## Contenido del repositorio

| Carpeta | Estado | Descripción |
|--------|--------|-------------|
| [LoraWan-Monitoreo-y-Control](./LoraWan-Monitoreo-y-Control/) | Activo | Plataforma web (React + Vite, API Express, SQLite, ingesta LoRaWAN, SSE, automatizaciones). Documentación técnica, scripts y despliegue en el README de esa carpeta. |
| [LoraWan-Control-Agua](./LoraWan-Control-Agua/) | **Pendiente** | Proyecto reservado para la línea de **control de agua** (integración, firmware o servicios asociados). Aún sin código versionado; el detalle se documentará aquí cuando arranque el desarrollo. |

## Cómo empezar

Todo el flujo detallado (variables de entorno, producción, guías LNS, despliegue, etc.) está en:

**[LoraWan-Monitoreo-y-Control/README.md](./LoraWan-Monitoreo-y-Control/README.md)**

### Desde la raíz del monorepo (recomendado)

La raíz incluye un `package.json` que **reenvía** los comandos a `LoraWan-Monitoreo-y-Control`, así podéis trabajar sin `cd` a la subcarpeta:

```bash
npm run install:app
npm start
```

`npm start` arranca API (puerto 3001) y Vite dev (puerto 5173) en un solo proceso con logs prefijados; **Ctrl+C** detiene ambos.

### Desde la carpeta del subproyecto

```bash
cd LoraWan-Monitoreo-y-Control
npm install
npm start
```

Puertos y variables `.env`: ver README del subproyecto.

## Requisitos

Node.js según `engines` en `LoraWan-Monitoreo-y-Control/package.json` (actualmente `^20.19.0` o `>=22.12.0`).

## Licencia

**MIT** — uso, copia, modificación y distribución libres, con los términos del archivo [LICENSE](./LICENSE) en la raíz de este repositorio. El campo `"private": true` en `package.json` del subproyecto solo evita publicación accidental en el registro npm; no restringe el código según la licencia.
