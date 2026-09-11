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
});
