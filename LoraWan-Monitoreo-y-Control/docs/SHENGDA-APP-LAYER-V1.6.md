# Shengda Application Layer Protocol V1.6

Integración en **Syscom IoT**: el servidor decodifica tramas de aplicación con cabecera **`0x24`** (uplink habitual) y verifica **CS** (suma acumulada de todos los bytes excepto el último, mod 256).

## Uso en la app

1. **Plantilla de dispositivo** (galería o decode-config): elija la plantilla **«Medidor / Shengda (ALP v1.6)»** o pegue el script que llama a `Shengda.decodeFrame`.
2. **FPort**: ajuste el canal al **FPort real** del firmware (p. ej. `1` o el que use su operador).
3. **Clase LoRaWAN**: debe coincidir con el modo real del módulo (el tipo **0x09** en telemetría rellena `lorawan_class`). La clase que usa el LNS al enviar downlinks sale de lo guardado en servidor (`device_decode_config` tras aplicar/propagar plantilla, luego `user_devices`), no solo de la tabla «Plantillas» local — consulte **`GET /api/devices/:deviceId/lora-profile`** (`lorawanClassSource`).

## Campos telemetría frecuentes

| Clave | Significado |
|--------|-------------|
| `shengda_protocol` | `true` si la trama coincide con el formato |
| `shengda_checksum_ok` | Verificación CS |
| `lorawan_class` | Derivado de **0x09** (Class A / B / C / dual) |
| `shengda_class_b_downlink_period_ms` | De **0x11** (fórmula documento: `122880 / (128 / 2^X)` ms) |
| `shengda_battery_v` | Tensión batería a partir de **0x1A** (raw / 16.4 V) |
| `shengda_module_time` | **0x1C** (fecha/hora módulo) |
| `shengda_frozen_data_time_ymd` | **0x1D** (congelación mensual/anual) |
| `shengda_status_word_1_bits` | Desglose **0x33** (contador de agua, bits según manual) |
| `shengda_monthly_frozen_cumulative_flow` / `shengda_yearly_frozen_cumulative_flow` | Valores enteros big-endian |

## Limitaciones

- No se implementa el **frame 0x26** de comandos hacia el módulo como uplink (solo downlink desde plataforma).
- **0x22** histórico: se expone texto/hex; el TLV interno puede ampliarse según modelos.
- Tipos **0x2F**, **0x30–0x32** y extensiones: si aparecen, conviene ampliar `server/shengda-app-layer.js`.

## Referencia

Especificación completa: manual del fabricante **Shengda Application Layer Protocol V1.6** (TV, TLV, `T(T0T1)V`, endian big-endian, reglas de modo LoRaWAN, válvula, etc.).
