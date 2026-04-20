-- Elimina pseudo-dispositivos creados a partir de uplinks Semtech sin OTAA (device_id devaddr-*, etc.)
-- y datos asociados. Los equipos reales usan DevEUI (16 hex) como device_id o en user_devices.

DELETE FROM telemetry WHERE lower(device_id) LIKE 'devaddr-%';

DELETE FROM device_dashboard WHERE lower(device_id) LIKE 'devaddr-%';

DELETE FROM device_decode_config WHERE lower(device_id) LIKE 'devaddr-%';

DELETE FROM device_labels WHERE lower(device_id) LIKE 'devaddr-%';

DELETE FROM device_license WHERE lower(device_id) LIKE 'devaddr-%';

DELETE FROM user_devices WHERE lower(device_id) LIKE 'devaddr-%';
