# Timewave — medidor de agua LoRaWAN (DLT/645)

Compatibilidad con **Wuhan TimeWave Network Technology Co., Ltd.** — protocolo **Water Meter Data** (basado en DLT/645) sobre el **FRMPayload** LoRaWAN.

## Estructura de trama (resumen)

| Tramo | Contenido |
|--------|-------------|
| `FE FE FE FE` | Preámbulo fijo |
| `68` | Inicio |
| 6 B | **N.º de medidor** en orden de transmisión (en pantalla lógica: **invertir bytes** → 12 hex, ej. `022025001955`) |
| `68` | Inicio |
| `XX` | Código de control (`91` lectura, `94` éxito comando, `D4` fallo, `14` comando hacia contador) |
| `XX` | Longitud de datos (bytes desde el siguiente byte hasta **excluir** el checksum) |
| … | Identificador de datos + datos (BCD / estado; bytes en aire con **+0x33** y orden según ficha) |
| `XX` | **Checksum**: suma byte a byte desde el **primer `68`** (tras preámbulo) hasta el byte **anterior** al checksum, **mod 256** |
| `16` | Fin |

**Datos «en claro»** respecto al aire: restar **0x33** a cada byte con préstamo en cadena e **invertir** el bloque; al generar comando: invertir y sumar **0x33** con acarreo (implementación `dataUnscramble` / `dataScramble` en `server/timewave-water-meter.js`).

## Comportamiento LoRaWAN (ficha)

- Medidor a **pilas**, habitualmente **clase A**: despierta, informa o ejecuta y vuelve a dormir; las lecturas suelen ser **automáticas** (no hace falta polling continuo).
- **Lectura éxito (`91h`)**: ver campos decodificados abajo.
- **Corte / reconexión (`14h` → `94h` / `D4h`)** y **cambio de intervalo de subida** (`14h` con DI intervalo → `94h` corto o `D4h`): el comando se aplica en el **próximo** despertar del contador.

## Bits de estado (§3.1, palabra 16 bit tras −33 e invertir)

| Bit(s) | Significado |
|--------|-------------|
| 1–0 | Válvula: `00` abierta, `01` cerrada, otro excepción |
| 2 | Alimentación: `1` = baja |
| 3 | Alarma |
| 4 | Sobregiro (overdraft) |
| 5 | Interferencia magnética fuerte |
| 6 | Force status (`1` = ON) |
| 15–8 | No usados (reservados) |

Objeto `timewave_status` en JSON de ingesta (p. ej. `valveOpen`, `lowPowerSupply`, …).

## Byte de error en `D4h` (§3.2)

| Bit | Significado |
|-----|-------------|
| 0 | Otros errores |
| 1 | Fallo al obtener datos |
| 2 | Contraseña incorrecta / no autorizado |
| 3 | Timeout de comunicación del equipo |

Objeto `timewave_error` en ingesta.

## Batería (§2.1.1)

Tras −33 e invertir el byte de batería en la trama de lectura: valor decimal **× 15,37 ≈ mV** (`battery_voltage_mv`). El siguiente byte puede ser **%** de batería restante (`00` = no disponible).

## Identificador de intervalo / ACK

El bloque en aire `3534A337` corresponde al identificador sin cifrar **`04 70 01 02`** (comando de intervalo). La respuesta corta `94h` con solo esos 4 B de datos usa el **mismo** DI; algunas tablas PDF citan `04 50 01 05` para el mismo patrón en aire, lo cual **no** encaja con la transformación +33/−33 usada en firmware de referencia.

## En la aplicación Syscom IoT

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
   - Implementación: suma de bytes desde el primer `68` (tras el preámbulo) hasta el último byte de datos, **módulo 256** (un octeto).  
   - Si el PDF de ejemplo difiere en un dígito o el firmware usa variante, `timewave_checksum_ok` será `false` y se exponen `timewave_checksum_expected` / `timewave_checksum_got`; el resto del decodificado sigue siendo útil para diagnóstico.

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

Documento **Water Meter Data Protocol** — *Wuhan TimeWave Network Technology Co., Ltd.* (lectura `91h`, válvula `14h`/`94h`/`D4h`, intervalo `14h`/`94h`/`D4h`, bits de estado §3.1–3.2).
