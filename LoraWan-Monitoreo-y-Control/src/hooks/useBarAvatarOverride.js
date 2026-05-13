import { useState, useEffect } from 'react';
import { readBarAvatarOverride, BAR_PREFS_CHANGED_EVENT } from '../utils/barAppearancePrefs';

/** Data URL de foto personalizada o null (entonces se usa Gravatar del servidor). */
export function useBarAvatarOverride() {
  const [url, setUrl] = useState(readBarAvatarOverride);
  useEffect(() => {
    const sync = () => setUrl(readBarAvatarOverride());
    window.addEventListener(BAR_PREFS_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(BAR_PREFS_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return url;
}
