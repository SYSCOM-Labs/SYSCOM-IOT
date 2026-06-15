# Integración API Milesight EG71

El EG71 expone **REST** (`/api/*` con JWT) y **CGI** (`POST /cgi` con token `login=user;td`).  
Esta aplicación actúa como **proxy autenticado** (mismo patrón que UG65): las credenciales se guardan en el perfil del usuario y el servidor habla con el gateway.

## Configuración

1. **Ajustes → Gateway Milesight EG71 (API)**
2. URL base (ej. `https://192.168.44.114`)
3. Usuario / contraseña (cifrado AES-128-CBC en el login, según firmware EG71)
4. **Probar conexión** → **Guardar EG71**

## LoRaWAN / downlinks

Como con UG65/UG63: el EG71 debe enviar **Packet Forwarder Semtech** al LNS integrado de esta app (`LNS_UDP_PORT`, defecto 1700).  
**No** use la API REST del EG71 para downlinks de aplicación; use `POST /api/devices/:id/downlink` o el LNS API.

## Endpoints proxy (JWT sesión SYSCOM)

| Método | Ruta SYSCOM | Uso |
|--------|-------------|-----|
| POST | `/api/milesight-eg71-gateway/probe` | Probar credenciales (body) |
| POST | `/api/milesight-eg71-gateway/probe-saved` | Probar credenciales guardadas |
| POST | `/api/milesight-eg71-gateway/islogin` | Estado de sesión EG71 |
| GET | `/api/milesight-eg71-gateway/page-init` | Bundle init (islogin, CGI dashboard, etc.) |
| POST | `/api/milesight-eg71-gateway/cgi` | Proxy CGI genérico (rate limit ≥500 ms) |
| POST | `/api/milesight-eg71-gateway/rest` | Proxy REST `{ method, path, body }` |
| POST | `/api/milesight-eg71-gateway/devices/list` | Lista dispositivos (`/api/dsdevices/device`) |
| GET | `/api/milesight-eg71-gateway/access-network` | Redes de acceso |
| GET | `/api/milesight-eg71-gateway/payloadcodecs-short` | Codecs |
| GET | `/api/milesight-eg71-gateway/urprofiles` | Perfiles LoRaWAN |
| GET | `/api/milesight-eg71-gateway/dsforward` | Reglas de reenvío |

## Cliente frontend

Ver `src/services/eg71GatewayApi.js`.

## Modelos de gateway

Catálogo: `shared/gateway-models.json` (UG65, UG67, UG63, **EG71**).

## Notas técnicas

- **CGI rate limit:** el cliente servidor encola peticiones CGI con intervalo mínimo de 500 ms.
- **JWT REST:** caché ~23 h por usuario + URL base.
- **CGI token:** caché ~55 min; se renueva en 401.
- Plantilla de dispositivos LoRaWAN: sin cambios; el EG71 comparte el mismo LNS y catálogo de codecs Milesight vía API.
