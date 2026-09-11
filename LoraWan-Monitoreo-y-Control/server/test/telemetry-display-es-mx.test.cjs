'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const statusUrl = pathToFileURL(path.join(__dirname, '../../src/utils/telemetryStatusEsMx.js')).href;

test('traduce estados típicos de widgets al español mexicano', async () => {
  const { translateTelemetryStatusLabel } = await import(statusUrl);
  assert.equal(translateTelemetryStatusLabel('Close'), 'Cerrado');
  assert.equal(translateTelemetryStatusLabel('Open'), 'Abierto');
  assert.equal(translateTelemetryStatusLabel('Standby'), 'En espera');
  assert.equal(translateTelemetryStatusLabel('on'), 'Encendido');
  assert.equal(translateTelemetryStatusLabel('OFF'), 'Apagado');
  assert.equal(translateTelemetryStatusLabel('Enable'), 'Activado');
  assert.equal(translateTelemetryStatusLabel('Disable'), 'Desactivado');
  assert.equal(translateTelemetryStatusLabel('Heat'), 'Calor');
  assert.equal(translateTelemetryStatusLabel('circulate'), 'Circular');
  assert.equal(translateTelemetryStatusLabel('short'), 'Corta');
  assert.equal(translateTelemetryStatusLabel('Input 1 On'), 'Entrada 1 encendida');
  assert.equal(translateTelemetryStatusLabel('Open', 'valve_status'), 'Abierta');
  assert.equal(translateTelemetryStatusLabel('Close', 'valve_status'), 'Cerrada');
  assert.equal(translateTelemetryStatusLabel('Encendido'), null);
  assert.equal(translateTelemetryStatusLabel('stage-1 cool'), 'Etapa 1 frío');
  assert.equal(translateTelemetryStatusLabel('stage-1 heat'), 'Etapa 1 calor');
  assert.equal(translateTelemetryStatusLabel('stage-2 cool'), 'Etapa 2 frío');
  assert.equal(translateTelemetryStatusLabel('on_cool'), 'Enfriando');
  assert.equal(translateTelemetryStatusLabel('em_heat'), 'Calor de emergencia');
  assert.equal(translateTelemetryStatusLabel('stage-5 cool'), 'Etapa 5 frío');
  assert.equal(translateTelemetryStatusLabel('class_a'), 'Clase A');
  assert.equal(translateTelemetryStatusLabel('freeze protection alarm'), 'Alarma anticongelante');
  assert.equal(translateTelemetryStatusLabel('home'), 'En casa');
});
