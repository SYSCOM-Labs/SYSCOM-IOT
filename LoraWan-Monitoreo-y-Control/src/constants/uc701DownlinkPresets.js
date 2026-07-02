/**
 * Downlinks UC701 (Milesight minisplit LoRaWAN).
 * Fuente: documentación de control de minisplit (system_switch, temperature_control_mode, etc.).
 * HEX sin espacios, minúsculas (formato Syscom al enviar downlinks).
 */
export const UC701_DOWNLINK_PRESETS = [
  // Encendido / apagado y modo
  { name: 'Encender sistema', hex: '6f01' },
  { name: 'Apagar sistema', hex: '6f00' },
  { name: 'Modo Calor', hex: '600000' },
  { name: 'Modo Frío', hex: '600002' },
  { name: 'Modo Auto', hex: '600003' },
  { name: 'Modo Deshumidificar', hex: '600004' },
  { name: 'Modo Ventilación', hex: '600005' },

  // Temperatura objetivo — Calor
  { name: 'Temp. objetivo Calor 16 °C', hex: '61004006' },
  { name: 'Temp. objetivo Calor 20 °C', hex: '6100d007' },
  { name: 'Temp. objetivo Calor 24 °C', hex: '61006009' },
  { name: 'Temp. objetivo Calor 25 °C', hex: '61008809' },
  { name: 'Temp. objetivo Calor 26 °C', hex: '6100280a' },
  { name: 'Temp. objetivo Calor 27 °C', hex: '6100c80a' },
  { name: 'Temp. objetivo Calor 28 °C', hex: '6100680b' },
  { name: 'Temp. objetivo Calor 29 °C', hex: '6100080c' },
  { name: 'Temp. objetivo Calor 30 °C', hex: '6100a80c' },

  // Temperatura objetivo — Frío
  { name: 'Temp. objetivo Frío 16 °C', hex: '61024006' },
  { name: 'Temp. objetivo Frío 18 °C', hex: '61020807' },
  { name: 'Temp. objetivo Frío 20 °C', hex: '6102d007' },
  { name: 'Temp. objetivo Frío 22 °C', hex: '61029808' },
  { name: 'Temp. objetivo Frío 24 °C', hex: '61026009' },
  { name: 'Temp. objetivo Frío 25 °C', hex: '61028809' },
  { name: 'Temp. objetivo Frío 26 °C', hex: '6102280a' },
  { name: 'Temp. objetivo Frío 27 °C', hex: '6102c80a' },
  { name: 'Temp. objetivo Frío 28 °C', hex: '6102680b' },
  { name: 'Temp. objetivo Frío 29 °C', hex: '6102080c' },
  { name: 'Temp. objetivo Frío 30 °C', hex: '6102a80c' },

  // Temperatura objetivo — Auto
  { name: 'Temp. objetivo Auto 16 °C', hex: '61034006' },
  { name: 'Temp. objetivo Auto 20 °C', hex: '6103d007' },
  { name: 'Temp. objetivo Auto 24 °C', hex: '61036009' },
  { name: 'Temp. objetivo Auto 25 °C', hex: '61038809' },
  { name: 'Temp. objetivo Auto 26 °C', hex: '6103280a' },
  { name: 'Temp. objetivo Auto 27 °C', hex: '6103c80a' },
  { name: 'Temp. objetivo Auto 28 °C', hex: '6103680b' },
  { name: 'Temp. objetivo Auto 29 °C', hex: '6103080c' },
  { name: 'Temp. objetivo Auto 30 °C', hex: '6103a80c' },

  // Ventilador
  { name: 'Ventilador Auto', hex: '700000' },
  { name: 'Ventilador Bajo', hex: '700003' },
  { name: 'Ventilador Medio', hex: '700004' },
  { name: 'Ventilador Alto', hex: '700005' },
  { name: 'Ventilación (solo ventilador)', hex: '700001' },
  { name: 'Ventilador Siempre Abierto', hex: '700002' },
  { name: 'Ventilador Deshabilitado', hex: '7000ff' },

  // Unidad y resolución de temperatura
  { name: 'Unidad °C (Celsius)', hex: '6400' },
  { name: 'Unidad °F (Fahrenheit)', hex: '6401' },
  { name: 'Resolución 0.5 °C', hex: '6500' },
  { name: 'Resolución 1 °C', hex: '6501' },

  // Consulta / estado
  { name: 'Consultar estado del dispositivo', hex: 'b9' },
  { name: 'Consultar todas las configuraciones', hex: 'ee' },
  { name: 'Consultar estado LoRaWAN', hex: 'bf' },
  { name: 'Sincronizar tiempo', hex: 'b8' },
  { name: 'Recolectar datos ahora', hex: 'b5' },

  // Reinicio / reconexión
  { name: 'Reiniciar dispositivo', hex: 'be' },
  { name: 'Reconectar a LoRaWAN', hex: 'b6' },

  // Ventana abierta
  { name: 'Habilitar detección ventana abierta', hex: '680001' },
  { name: 'Deshabilitar detección ventana abierta', hex: '680000' },
  { name: 'Ventana abierta — diferencia 2 °C', hex: '6802c800' },
  { name: 'Ventana abierta — diferencia 3 °C', hex: '68022c01' },
  { name: 'Ventana abierta — diferencia 5 °C', hex: '6802f401' },
  { name: 'Ventana abierta — parada 10 min', hex: '68030a00' },
  { name: 'Ventana abierta — parada 30 min', hex: '68031e00' },
  { name: 'Ventana abierta — parada 60 min', hex: '68033c00' },

  // Infrarrojos
  { name: 'Encender por IR', hex: '0481020000' },
  { name: 'Apagar por IR', hex: '0401020000' },

  // BLE
  { name: 'Habilitar BLE', hex: 'cd0001' },
  { name: 'Deshabilitar BLE', hex: 'cd0000' },
  { name: 'Nombre BLE "UC70101"', hex: 'd50755433730313031' },

  // Secuencias de uso común
  { name: 'Encender Frío 24 °C + ventilador Auto', hex: '6f0160000261026009700000' },
  { name: 'Encender Calor 25 °C + ventilador Medio', hex: '6f0160000061008809700004' },
  { name: 'Solo cambiar Frío 22 °C', hex: '61029808' },
];
