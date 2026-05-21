'use strict';

/** Presets SMTP gratuitos (STARTTLS en 587 salvo SYSCOM_SMTP_SECURE=1 → 465). */
const SMTP_PROVIDERS = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    dailyLimit: 500,
    helpUrl: 'https://support.google.com/accounts/answer/185833',
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Hotmail / Live',
    host: 'smtp-mail.outlook.com',
    port: 587,
    dailyLimit: 300,
    helpUrl: 'https://support.microsoft.com/account-billing/using-app-passwords-with-apps-that-don-t-support-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944',
  },
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo Mail',
    host: 'smtp.mail.yahoo.com',
    port: 587,
    dailyLimit: 500,
    helpUrl: 'https://help.yahoo.com/kb/generate-third-party-passwords-sln15241.html',
  },
  gmx: {
    id: 'gmx',
    label: 'GMX',
    host: 'mail.gmx.com',
    port: 587,
    dailyLimit: 100,
    helpUrl: 'https://support.gmx.com/pop-imap/toggle.html',
  },
  custom: {
    id: 'custom',
    label: 'Otro (host manual)',
    host: '',
    port: 587,
    dailyLimit: 100,
    helpUrl: '',
  },
};

function normalizeProviderId(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  if (v && SMTP_PROVIDERS[v]) return v;
  return 'gmail';
}

function getProviderPreset(providerId) {
  return SMTP_PROVIDERS[normalizeProviderId(providerId)] || SMTP_PROVIDERS.gmail;
}

function listProviderPresetsPublic() {
  return Object.values(SMTP_PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    host: p.host,
    port: p.port,
    dailyLimit: p.dailyLimit,
    helpUrl: p.helpUrl || undefined,
  }));
}

module.exports = {
  SMTP_PROVIDERS,
  normalizeProviderId,
  getProviderPreset,
  listProviderPresetsPublic,
};
