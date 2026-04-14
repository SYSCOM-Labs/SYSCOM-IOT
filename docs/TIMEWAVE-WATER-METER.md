# Timewave — medidor de agua LoRaWAN (DLT/645)

Compatibilidad con **Wuhan TimeWave Network Technology Co., Ltd.** (tramas tipo **DLT/T 645** sobre payload de aplicación LoRaWAN).

## En la aplicación SYSCOM IoT

1. **Alta del dispositivo**  
   - **DevEUI** = identificador LoRaWAN del módulo.  
   - **Número de medidor** (12 hex, 6 BCD) debe coincidir con el que lleva la trama Timewave (ej. `022025001955`). Si no coincide, los comandos **válvula / intervalo** generados con otro número no aplicarán a ese contador.

2. **Decoder**  
   - Plantilla **Timewave → Water-Meter-LoRa** (en *Plantillas*) o pega el script que usa `Timewave.decodeFrame` (ver `seedDeviceTemplates.js`).  
   - El servidor inyecta el objeto global **`Timewave`** en el sandbox del decoder (no hace falta `require`).

3. **Downlinks**  
   - La API `POST /api/devices/:deviceId/downlink` envía el **payload de aplicación** = **trama completa** en hex (incluye `FEFEFEFE` … `16`).  
   - Los HEX de ejemplo en la plantilla son para el medidor **`022025001955`**. Para otro número, genera tramas en Node:

```bash
node -e "const t=require('./server/timewave-water-meter.js'); console.log(t.buildValveCommand('TU_MEDIDOR_12HEX',true).toString('hex'));"
```

4. **Checksum**  
   - Implementación: suma de bytes desde el primer `68` (tras el preámbulo) hasta el último byte de datos, **módulo 256**.  
   - Si un equipo envía otro criterio, verás `timewave_checksum_ok: false` pero los campos se decodifican igualmente para depuración.

## Campos decodificados (uplink)

| Clave (aprox.) | Significado |
|----------------|-------------|
| `timewave_protocol` | `true` |
| `timewave_meterNo` | Número de medidor 12 hex |
| `water_cumulative_m3` / `water_cumulative_m3_raw` | Lectura acumulada m³ (trama 91h) |
| `timewave_status` | Bits de estado (válvula, batería baja, alarma, etc.) |
| `battery_voltage_mv` | Tensión estimada (mV) según ficha |
| `battery_percent` | % si distinto de 0 tras decodificar |
| `timewave_frame` | `reading`, `valve_ack`, `interval_ack`, `command_fail`, … |
| `timewave_error` | En fallo D4h, bits de error |

## Módulo servidor

- `server/timewave-water-meter.js` — `decodeFrame`, `buildValveCommand`, `buildIntervalCommand`, utilidades `+33`/`-33`.

## Referencia del fabricante

Estructura de trama, códigos de control (`91`, `94`, `D4`, `14`), identificadores de datos y bits de estado: documento **Water Meter Data Protocol** (TimeWave).
