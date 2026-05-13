import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'server', 'data', 'syscom.db');

console.log('--- Iniciando limpieza de base de datos ---');
console.log('Ruta DB:', DB_PATH);

try {
  const db = new DatabaseSync(DB_PATH);
  
  // 1. Contar registros antes
  const countBefore = db.prepare('SELECT COUNT(*) as total FROM telemetry').get().total;
  console.log(`Registros de telemetría actuales: ${countBefore}`);

  // 2. Ejecutar limpieza
  // Eliminamos telemetría de dispositivos que NO están en user_devices Y que NO son gateways
  const result = db.exec(`
    DELETE FROM telemetry 
    WHERE device_id NOT IN (SELECT DISTINCT device_id FROM user_devices)
    AND device_id NOT LIKE 'gateway-%';
  `);
  
  // 3. Limpiar etiquetas huérfanas
  db.exec(`
    DELETE FROM device_labels 
    WHERE device_id NOT IN (SELECT DISTINCT device_id FROM user_devices)
    AND device_id NOT LIKE 'gateway-%';
  `);

  // 4. Limpiar dashboards huérfanos
  db.exec(`
    DELETE FROM device_dashboard 
    WHERE device_id NOT IN (SELECT DISTINCT device_id FROM user_devices);
  `);

  db.exec(`
    DELETE FROM device_bsd_preferences
    WHERE device_id NOT IN (SELECT DISTINCT device_id FROM user_devices);
  `);

  const countAfter = db.prepare('SELECT COUNT(*) as total FROM telemetry').get().total;
  console.log(`Registros de telemetría después: ${countAfter}`);
  console.log(`Eliminados: ${countBefore - countAfter} registros.`);
  
  console.log('\n--- Limpieza completada con éxito ---');
} catch (error) {
  console.error('Error durante la limpieza:', error.message);
  process.exit(1);
}
