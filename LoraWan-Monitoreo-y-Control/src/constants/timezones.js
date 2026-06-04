/** Zonas IANA habituales en México, LATAM y despliegues en nube. */
export const APP_TIMEZONE_OPTIONS = [
  { value: 'America/Mexico_City', label: 'Hora central (México)' },
  { value: 'America/Cancun', label: 'Quintana Roo (sin horario de verano)' },
  { value: 'America/Merida', label: 'Sureste (Mérida)' },
  { value: 'America/Monterrey', label: 'Noreste (Monterrey)' },
  { value: 'America/Chihuahua', label: 'Chihuahua' },
  { value: 'America/Mazatlan', label: 'Pacífico (Mazatlán)' },
  { value: 'America/Tijuana', label: 'Pacífico (Tijuana)' },
  { value: 'America/Bogota', label: 'Colombia' },
  { value: 'America/Lima', label: 'Perú' },
  { value: 'America/Santiago', label: 'Chile' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina (Buenos Aires)' },
  { value: 'America/New_York', label: 'Este (EE.UU.)' },
  { value: 'America/Chicago', label: 'Central (EE.UU.)' },
  { value: 'America/Denver', label: 'Montaña (EE.UU.)' },
  { value: 'America/Los_Angeles', label: 'Pacífico (EE.UU.)' },
  { value: 'Europe/Madrid', label: 'España' },
  { value: 'UTC', label: 'UTC' },
];

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}
