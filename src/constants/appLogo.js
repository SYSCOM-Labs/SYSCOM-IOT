/** Logotipo incluido en el despliegue (`public/logo-syscom.svg`). */
export const DEFAULT_APP_LOGO_URL = `${import.meta.env.BASE_URL}logo-syscom.svg`.replace(/\/{2,}/g, '/');

export const LOGO_STORAGE_KEY = 'syscom_iot_logo';

export function getEffectiveLogoSrc() {
  if (typeof window === 'undefined') return DEFAULT_APP_LOGO_URL;
  return window.localStorage.getItem(LOGO_STORAGE_KEY) || DEFAULT_APP_LOGO_URL;
}

export function hasCustomLogo() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.localStorage.getItem(LOGO_STORAGE_KEY));
}
