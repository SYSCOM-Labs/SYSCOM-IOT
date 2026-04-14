# Eastron SDM230 (LoRaWAN / Modbus)

Referencia rápida para la plantilla **Eastron / SDM230-LoRaWAN** y el módulo `server/eastron-sdm230.js`.

## Subida activa LoRaWAN

Formato del payload de aplicación (sin cabecera LoRa):

| Campo | Tamaño | Descripción |
|--------|--------|-------------|
| Número de serie | 4 B | Entero big-endian |
| N | 1 B | Metadato de parámetros activos (según manual) |
| Longitud datos | 1 B | Bytes de datos siguientes (sin CRC); manual indica 0x0C para 3 floats |
| Datos | N×4 B | Float IEEE 754 **big-endian** |
| CRC | 2 B | CRC-16 Modbus sobre todo lo anterior, **little-endian** |

El **orden** de los floats coincide con la **configuración de subida activa** en el medidor (Tabla 1 del manual: 00 tensión, 01 frecuencia, …). El decodificador asigna por posición `voltage_v`, `frequency_hz`, … y claves genéricas si hay más de 20 valores.

## Modbus RTU en downlink

Los downlinks de ejemplo usan **trama Modbus RTU completa** (esclavo + PDU + CRC), en **hex minúsculas sin espacios**, igual que otros dispositivos de la app. **Esclavo por defecto: 1**; cambiar el primer byte si el medidor usa otro ID.

### FC 0x04 — Input registers (solo lectura)

Dirección PDU de inicio = registro documentado − **30001** (ej. 30001 → `0x0000`, 30007 → `0x0006`).

| Registro doc. | PDU inicio (hex) | Parámetro |
|---------------|------------------|-----------|
| 30001 | 0000 | Tensión L-N (V) |
| 30007 | 0006 | Corriente (A) |
| 30013 | 000C | Potencia activa (W) |
| 30019 | 0012 | Potencia aparente (VA) |
| 30031 | 001E | Factor de potencia |
| 30071 | 0046 | Frecuencia (Hz) |
| 30073 | 0048 | Energía activa importada (kWh) |

(El manual lista más registros; misma regla de dirección.)

### FC 0x03 / 0x10 — Holding

Dirección PDU holding = registro **4xxxx − 40001** (ej. 40013 → 12 = `0x000C`).

Escrituras de **float 4 B** en holding (p. ej. ancho de pulso 40013, tipo energía pulso 40087) usan FC **0x10** con dos registros consecutivos, valor float **big-endian**.

### Resets (manual)

Escritura FC **0x10** en dirección **0xF010** (registro especial documentado como 461457 / F0 10):

- `0x0000`: reset demanda máxima  
- `0x0003`: reset energía reseteable  

## API en el sandbox del decodificador

Objeto global **`Eastron`** (ver `server/payload-decoder.js`):

- `decodeActiveUpload(bytes)`
- `buildReadInputRegistersHex(slaveId, startPdu, qty)`
- `buildReadHoldingRegistersHex(slaveId, startPdu, qty)`
- `buildWriteFloatHoldingHex(slaveId, reg40001Style, floatVal)`
- `buildResetMaxDemandHex(slaveId)` / `buildResetResettableEnergyHex(slaveId)`
- `crc16Modbus(bytesArray)`

Notas del manual: el factor de potencia lleva signo según dirección de corriente; la demanda de potencia del sistema usa import − export.
