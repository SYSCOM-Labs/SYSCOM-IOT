import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Settings as SettingsIcon, Upload, Trash2, User, Database, Download, Globe, RadioTower } from 'lucide-react';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './Settings.css';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { updateUser } from '../services/localAuth';
import {
  BAR_AVATAR_STORAGE_KEY,
  BAR_AVATAR_MAX_BYTES,
  notifyBarPrefsChanged,
  readBarAvatarOverride,
} from '../utils/barAppearancePrefs';
import {
  browserNotificationsSupported,
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
} from '../utils/browserNotifications';
import {
  exportDatabaseBackupBlob,
  importDatabaseBackupFile,
  fetchBackupConfig,
  saveBackupConfig,
  fetchAppTimezone,
  saveAppTimezone,
  fetchSmtpSettings,
  saveSmtpSettings,
  testSmtpSettings,
} from '../services/api';
import AppActivityLogDock from '../components/AppActivityLogDock';
import { APP_TIMEZONE_OPTIONS, browserTimezone } from '../constants/timezones';
import { probeEg71Gateway, probeEg71GatewaySaved } from '../services/eg71GatewayApi';
import { DEMO_PLAYGROUND_MESSAGE } from '../utils/demoPlayground';

const LOGO_STORAGE_KEY = 'syscom_iot_logo';
const LOGO_CHANGED_EVENT = 'syscom-custom-logo-changed';
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

function notifyLogoChanged() {
  window.dispatchEvent(new CustomEvent(LOGO_CHANGED_EVENT));
}

const SettingsPage = () => {
  const { t } = useLanguage();
  const { isDarkMode, toggleTheme } = useTheme();
  const { user, userProfile, resyncSession, hasNavPage, isDemo } = useAuth();
  const logoFileRef = useRef(null);
  const barAvatarFileRef = useRef(null);
  const dbImportFileRef = useRef(null);
  const [dbExportBusy, setDbExportBusy] = useState(false);
  const [dbImportBusy, setDbImportBusy] = useState(false);
  const [nasDestination, setNasDestination] = useState('');
  const [nasSaveBusy, setNasSaveBusy] = useState(false);
  const [appTimezoneDraft, setAppTimezoneDraft] = useState('America/Mexico_City');
  const [appTimezoneStatus, setAppTimezoneStatus] = useState(null);
  const [appTimezoneSaveBusy, setAppTimezoneSaveBusy] = useState(false);
  const browserTz = useMemo(() => browserTimezone(), []);
  const [eg71BaseUrl, setEg71BaseUrl] = useState('');
  const [eg71Username, setEg71Username] = useState('admin');
  const [eg71Password, setEg71Password] = useState('');
  const [eg71HasSavedPassword, setEg71HasSavedPassword] = useState(false);
  const [eg71RejectInsecureTls, setEg71RejectInsecureTls] = useState(false);
  const [eg71SaveBusy, setEg71SaveBusy] = useState(false);
  const [eg71ProbeBusy, setEg71ProbeBusy] = useState(false);
  const [customLogo, setCustomLogo] = useState(() => localStorage.getItem(LOGO_STORAGE_KEY) || null);
  const [barAvatarDataUrl, setBarAvatarDataUrl] = useState(() => readBarAvatarOverride());
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [barProfileSaving, setBarProfileSaving] = useState(false);
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const activityLogWrapRef = useRef(null);
  const isSuperAdmin = user?.role === 'superadmin';

  const rejectDemoWrite = () => {
    if (!isDemo) return false;
    window.alert(DEMO_PLAYGROUND_MESSAGE);
    return true;
  };

  useEffect(() => {
    const n =
      (userProfile?.profileName && String(userProfile.profileName).trim()) ||
      (user?.profileName && String(user.profileName).trim()) ||
      '';
    setProfileDisplayName(n);
  }, [userProfile?.profileName, user?.profileName]);

  useEffect(() => {
    const g = userProfile?.eg71Gateway || user?.eg71Gateway;
    if (!g) return;
    setEg71BaseUrl(String(g.baseUrl || ''));
    setEg71Username(String(g.apiUsername || 'admin'));
    setEg71HasSavedPassword(Boolean(g.hasApiPassword));
    setEg71RejectInsecureTls(g.rejectUnauthorized === false);
  }, [userProfile?.eg71Gateway, user?.eg71Gateway]);

  useEffect(() => {
    if (!hasNavPage('Settings')) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBackupConfig();
        if (!cancelled) setNasDestination(String(data?.nasDestination ?? ''));
      } catch {
        /* sin sesión o sin permiso */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasNavPage]);

  useEffect(() => {
    if (!hasNavPage('Settings')) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAppTimezone();
        if (cancelled) return;
        setAppTimezoneStatus(data);
        setAppTimezoneDraft(String(data?.timezone || data?.configured || 'America/Mexico_City'));
      } catch {
        /* sin sesión */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasNavPage]);

  useEffect(() => {
    if (!hasNavPage('Settings')) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchSmtpSettings();
        if (cancelled) return;
        setSmtpStatus(data);
        setSmtpForm((prev) => ({
          ...prev,
          provider: data?.provider || 'gmail',
          host: data?.host || '',
          port: data?.port || 587,
        }));
      } catch {
        /* sin permiso */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasNavPage]);

  useEffect(() => {
    if (!activityLogOpen) return;
    const id = requestAnimationFrame(() => {
      activityLogWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [activityLogOpen]);

  const [smtpForm, setSmtpForm] = useState({
    provider: 'gmail',
    user: '',
    password: '',
    host: '',
    port: 587,
  });
  const [smtpStatus, setSmtpStatus] = useState(null);
  const [smtpSaveBusy, setSmtpSaveBusy] = useState(false);
  const [smtpTestTo, setSmtpTestTo] = useState('');
  const [smtpTestBusy, setSmtpTestBusy] = useState(false);

  const [browserNotifyPerm, setBrowserNotifyPerm] = useState(() =>
    browserNotificationsSupported() ? getBrowserNotificationPermission() : 'unsupported'
  );

  const handleRequestBrowserNotifications = async () => {
    if (!browserNotificationsSupported()) {
      alert('Su navegador no ofrece notificaciones del sistema, o el sitio no usa HTTPS (necesario salvo en localhost).');
      return;
    }
    const r = await requestBrowserNotificationPermission();
    setBrowserNotifyPerm(getBrowserNotificationPermission());
    if (r === 'denied') {
      alert(
        'Permiso denegado. Revise el icono de candado o de sitio en la barra de direcciones y permita notificaciones para esta URL.'
      );
    }
  };

  const handleSaveSmtpConfig = async () => {
    if (rejectDemoWrite()) return;
    if (!isSuperAdmin) {
      alert('Solo el super administrador puede guardar la configuración SMTP.');
      return;
    }
    const userEmail = String(smtpForm.user || '').trim();
    if (!userEmail) {
      alert('Indique el correo saliente (cuenta SMTP).');
      return;
    }
    const pass = String(smtpForm.password || '').trim();
    if (!smtpStatus?.hasPassword && !smtpStatus?.credentialsFromEnv && !pass) {
      alert('Indique la contraseña de aplicación SMTP, o defina SYSCOM_SMTP_PASS en el archivo .env del servidor.');
      return;
    }
    setSmtpSaveBusy(true);
    try {
      const data = await saveSmtpSettings({
        provider: smtpForm.provider,
        user: userEmail,
        password: pass || undefined,
        host: smtpForm.provider === 'custom' ? smtpForm.host : undefined,
        port: smtpForm.port,
      });
      setSmtpStatus(data);
      setSmtpForm((f) => ({ ...f, password: '' }));
      alert(
        'SMTP guardado. Las automatizaciones «Enviar email» se envían desde el servidor (no hace falta tener el navegador abierto).'
      );
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || 'No se pudo guardar SMTP.');
    } finally {
      setSmtpSaveBusy(false);
    }
  };

  const handleTestSmtp = async () => {
    if (rejectDemoWrite()) return;
    if (!isSuperAdmin) {
      alert('Solo el super administrador puede enviar correos de prueba.');
      return;
    }
    const to = String(smtpTestTo || user?.email || '').trim();
    if (!to) {
      alert('Indique un correo de prueba.');
      return;
    }
    const fromUser = String(smtpForm.user || '').trim();
    const fromPass = String(smtpForm.password || '').trim();
    if (!smtpStatus?.configured && !smtpStatus?.credentialsFromEnv && (!fromUser || !fromPass)) {
      alert(
        'Complete el correo saliente y la contraseña de aplicación en el formulario, o defina SYSCOM_SMTP_USER y SYSCOM_SMTP_PASS en el .env del servidor.'
      );
      return;
    }
    setSmtpTestBusy(true);
    try {
      const data = await testSmtpSettings({
        to,
        user: fromUser || undefined,
        password: fromPass || undefined,
        provider: smtpForm.provider,
        host: smtpForm.provider === 'custom' ? smtpForm.host : undefined,
        port: smtpForm.port,
      });
      if (data?.queued) {
        alert('Correo encolado (límite diario o reintento). Se enviará automáticamente más tarde.');
      } else {
        alert(`Correo de prueba enviado a ${to}. Revise bandeja de entrada y spam.`);
      }
      const st = await fetchSmtpSettings();
      setSmtpStatus(st);
    } catch (e) {
      const st = e?.response?.status;
      const code = e?.response?.data?.code;
      let msg = e?.response?.data?.error || e?.message || 'Envío fallido';
      if (st === 404) {
        msg =
          'No se encontró la ruta de prueba SMTP (404). Reinicie el backend (npm start) y compruebe que VITE_API_BASE termina en /api (p. ej. http://localhost:3001/api) o déjelo vacío para usar el proxy /api de Vite.';
      }
      alert(code ? `${msg} (${code})` : msg);
    } finally {
      setSmtpTestBusy(false);
    }
  };

  const handleLogoFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (rejectDemoWrite()) return;
    if (!file || !file.type.startsWith('image/')) {
      if (file) alert('Seleccione un archivo de imagen (PNG, JPG, SVG, etc.).');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      alert('La imagen es demasiado grande. Pruebe con un archivo menor (por ejemplo bajo 2 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      localStorage.setItem(LOGO_STORAGE_KEY, dataUrl);
      setCustomLogo(dataUrl);
      notifyLogoChanged();
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    if (rejectDemoWrite()) return;
    localStorage.removeItem(LOGO_STORAGE_KEY);
    setCustomLogo(null);
    notifyLogoChanged();
  };

  const handleSaveBarProfileName = async () => {
    if (rejectDemoWrite()) return;
    if (!user?.id || !resyncSession) return;
    setBarProfileSaving(true);
    try {
      await updateUser(user.id, { profileName: String(profileDisplayName).trim() });
      await resyncSession();
      alert(t('settings.bar_profile_saved'));
    } catch (e) {
      alert(e?.message || 'Error al guardar el nombre.');
    } finally {
      setBarProfileSaving(false);
    }
  };

  const handleBarAvatarFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (rejectDemoWrite()) return;
    if (!file || !file.type.startsWith('image/')) {
      if (file) alert('Seleccione un archivo de imagen (PNG, JPG, SVG, etc.).');
      return;
    }
    if (file.size > BAR_AVATAR_MAX_BYTES) {
      alert('La imagen es demasiado grande. Pruebe con un archivo más pequeño.');
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      localStorage.setItem(BAR_AVATAR_STORAGE_KEY, dataUrl);
      setBarAvatarDataUrl(dataUrl);
      notifyBarPrefsChanged();
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveBarAvatar = () => {
    if (rejectDemoWrite()) return;
    localStorage.removeItem(BAR_AVATAR_STORAGE_KEY);
    setBarAvatarDataUrl(null);
    notifyBarPrefsChanged();
  };

  const handleSaveEg71Gateway = async () => {
    if (rejectDemoWrite()) return;
    if (!user?.id) return;
    const baseUrl = String(eg71BaseUrl || '').trim();
    if (!baseUrl) {
      alert(t('settings.eg71_base_url_required'));
      return;
    }
    setEg71SaveBusy(true);
    try {
      const payload = {
        eg71Gateway: {
          baseUrl,
          apiUsername: String(eg71Username || 'admin').trim() || 'admin',
          rejectUnauthorized: !eg71RejectInsecureTls,
        },
      };
      if (eg71Password.trim()) payload.eg71Gateway.apiPassword = eg71Password.trim();
      await updateUser(user.id, payload);
      await resyncSession();
      setEg71Password('');
      setEg71HasSavedPassword(Boolean(eg71Password.trim()) || eg71HasSavedPassword);
      alert(t('settings.eg71_saved'));
    } catch (e) {
      alert(e?.message || t('settings.eg71_save_error'));
    } finally {
      setEg71SaveBusy(false);
    }
  };

  const handleProbeEg71Gateway = async () => {
    if (rejectDemoWrite()) return;
    setEg71ProbeBusy(true);
    try {
      const baseUrl = String(eg71BaseUrl || '').trim();
      let data;
      if (baseUrl && (eg71Password.trim() || !eg71HasSavedPassword)) {
        data = await probeEg71Gateway({
          baseUrl,
          apiUsername: String(eg71Username || 'admin').trim() || 'admin',
          apiPassword: eg71Password.trim(),
          rejectUnauthorized: !eg71RejectInsecureTls,
        });
      } else {
        data = await probeEg71GatewaySaved();
      }
      alert(data?.message || t('settings.eg71_probe_ok'));
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || t('settings.eg71_probe_error'));
    } finally {
      setEg71ProbeBusy(false);
    }
  };

  const handleDatabaseExport = async () => {
    if (rejectDemoWrite()) return;
    setDbExportBusy(true);
    try {
      const blob = await exportDatabaseBackupBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `syscom-backup-${new Date().toISOString().slice(0, 10)}.db`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg = e?.message || t('settings.database_export_error');
      alert(msg);
    } finally {
      setDbExportBusy(false);
    }
  };

  const handleSaveNasDestination = async () => {
    if (rejectDemoWrite()) return;
    setNasSaveBusy(true);
    try {
      await saveBackupConfig({ nasDestination });
      alert(t('settings.database_nas_saved'));
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || 'Error al guardar.');
    } finally {
      setNasSaveBusy(false);
    }
  };

  const handleSaveAppTimezone = async () => {
    if (rejectDemoWrite()) return;
    setAppTimezoneSaveBusy(true);
    try {
      const data = await saveAppTimezone(appTimezoneDraft);
      setAppTimezoneStatus(data);
      setAppTimezoneDraft(String(data?.timezone || appTimezoneDraft));
      alert(t('settings.timezone_saved'));
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || t('settings.timezone_save_error'));
    } finally {
      setAppTimezoneSaveBusy(false);
    }
  };

  const timezoneSourceLabel = (source) => {
    if (source === 'settings') return t('settings.timezone_source_settings');
    if (source === 'env') return t('settings.timezone_source_env');
    return t('settings.timezone_source_default');
  };

  const handleDatabaseImportPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (rejectDemoWrite()) return;
    if (!file) return;
    if (!String(file.name || '').toLowerCase().endsWith('.db')) {
      alert('Seleccione un archivo .db exportado desde este servidor.');
      return;
    }
    if (!window.confirm(t('settings.database_import_confirm'))) return;
    setDbImportBusy(true);
    try {
      const data = await importDatabaseBackupFile(file);
      alert(data?.message || t('settings.database_import_done'));
    } catch (err) {
      alert(err?.message || t('settings.database_import_error'));
    } finally {
      setDbImportBusy(false);
    }
  };

  return (
    <div
      className={`device-list-page device-list-page--premium premium-shell settings-page${activityLogOpen ? ' settings-page--log-open' : ''}`}
    >
      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <SettingsIcon size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">{t('settings.page_title')}</span>
          </h1>
          {isDemo && (
            <p className="device-page-header-sub">
              Puede probar los formularios. Al guardar verá un aviso: nada se aplica en el sistema.
            </p>
          )}
        </div>
      </div>

      <div className="table-container glass card">
        <div className="settings-premium-inner">
        <section className="settings-section settings-section-premium">
          <h3>{t('settings.display_section')}</h3>
          <p className="description" style={{ marginBottom: '0.75rem' }}>
            {t('settings.dark_mode_hint')}
          </p>
          <div className="settings-dark-mode-row">
            <span className="settings-dark-mode-label">{t('settings.dark_mode')}</span>
            <div
              className={`toggle settings-dark-mode-toggle ${isDarkMode ? 'active' : ''}`}
              onClick={toggleTheme}
              onKeyDown={(e) => e.key === 'Enter' && toggleTheme()}
              role="button"
              tabIndex={0}
              aria-pressed={isDarkMode}
            >
              <div
                className="toggle-thumb"
                style={{
                  width: '16px',
                  height: '16px',
                  backgroundColor: 'white',
                  borderRadius: '50%',
                  transform: isDarkMode ? 'translateX(16px)' : 'translateX(0)',
                  transition: 'transform 0.2s',
                }}
              />
            </div>
          </div>
        </section>

        <section className="settings-section settings-section-premium">
          <h3>
            <Globe size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} aria-hidden />
            {t('settings.timezone_section')}
          </h3>
          <p className="description settings-logo-hint">{t('settings.timezone_hint')}</p>
          <div className="settings-timezone-block glass">
            <label className="settings-timezone-label" htmlFor="syscom-app-timezone">
              {t('settings.timezone_label')}
            </label>
            <select
              id="syscom-app-timezone"
              className="glass settings-timezone-select"
              value={appTimezoneDraft}
              onChange={(e) => setAppTimezoneDraft(e.target.value)}
            >
              {APP_TIMEZONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.value})
                </option>
              ))}
            </select>
            {appTimezoneStatus ? (
              <div className="settings-timezone-meta">
                <p className="settings-timezone-now">
                  {t('settings.timezone_now')}: <strong>{appTimezoneStatus.nowLocal}</strong>
                </p>
                <p className="settings-timezone-source">
                  {t('settings.timezone_active')}: <code>{appTimezoneStatus.timezone}</code>
                  {' · '}
                  {timezoneSourceLabel(appTimezoneStatus.source)}
                </p>
                {appTimezoneStatus.envFallback ? (
                  <p className="settings-timezone-env">
                    {t('settings.timezone_env_fallback')}: <code>{appTimezoneStatus.envFallback}</code>
                  </p>
                ) : null}
                {browserTz ? (
                  <p className="settings-timezone-browser">
                    {t('settings.timezone_browser')}: <code>{browserTz}</code>
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="settings-timezone-save-wrap">
              <button
                type="button"
                className="btn btn-primary"
                disabled={appTimezoneSaveBusy}
                onClick={() => void handleSaveAppTimezone()}
              >
                {appTimezoneSaveBusy ? '…' : t('settings.timezone_save')}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section-premium">
          <h3>
            <RadioTower size={18} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} aria-hidden />
            {t('settings.eg71_section')}
          </h3>
          <p className="description settings-logo-hint">{t('settings.eg71_hint')}</p>
          <div className="settings-gateway-block glass">
            <label className="settings-timezone-label" htmlFor="syscom-eg71-base-url">
              {t('settings.eg71_base_url')}
            </label>
            <input
              id="syscom-eg71-base-url"
              type="url"
              className="glass settings-gateway-input"
              placeholder="https://192.168.1.10"
              value={eg71BaseUrl}
              onChange={(e) => setEg71BaseUrl(e.target.value)}
              autoComplete="off"
            />
            <label className="settings-timezone-label" htmlFor="syscom-eg71-user">
              {t('settings.eg71_username')}
            </label>
            <input
              id="syscom-eg71-user"
              type="text"
              className="glass settings-gateway-input"
              value={eg71Username}
              onChange={(e) => setEg71Username(e.target.value)}
              autoComplete="username"
            />
            <label className="settings-timezone-label" htmlFor="syscom-eg71-pass">
              {t('settings.eg71_password')}
              {eg71HasSavedPassword ? ` (${t('settings.eg71_password_saved')})` : ''}
            </label>
            <input
              id="syscom-eg71-pass"
              type="password"
              className="glass settings-gateway-input"
              placeholder={eg71HasSavedPassword ? '••••••••' : ''}
              value={eg71Password}
              onChange={(e) => setEg71Password(e.target.value)}
              autoComplete="new-password"
            />
            <label className="settings-gateway-check checkbox-label">
              <input
                type="checkbox"
                checked={eg71RejectInsecureTls}
                onChange={(e) => setEg71RejectInsecureTls(e.target.checked)}
              />
              <span>{t('settings.eg71_allow_insecure_tls')}</span>
            </label>
            <div className="settings-gateway-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={eg71ProbeBusy || eg71SaveBusy}
                onClick={() => void handleProbeEg71Gateway()}
              >
                {eg71ProbeBusy ? '…' : t('settings.eg71_probe')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={eg71SaveBusy || eg71ProbeBusy}
                onClick={() => void handleSaveEg71Gateway()}
              >
                {eg71SaveBusy ? '…' : t('settings.eg71_save')}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section-premium">
          <h3>{t('settings.logo_section')}</h3>
          <p className="description settings-logo-hint">{t('settings.logo_hint')}</p>
          <input
            ref={logoFileRef}
            type="file"
            accept="image/*"
            className="settings-logo-file-input"
            aria-hidden
            tabIndex={-1}
            onChange={handleLogoFile}
          />
          <div className="settings-logo-block glass">
            <div className="settings-logo-canvas">
              {customLogo ? (
                <img src={customLogo} alt={t('settings.logo_section')} className="settings-logo-preview" />
              ) : (
                <img
                  src="/syscom-iot-logo.png"
                  alt=""
                  className="settings-logo-preview settings-logo-preview--builtin"
                />
              )}
            </div>
            <div className="settings-logo-actions">
              <button type="button" className="btn btn-primary" onClick={() => logoFileRef.current?.click()}>
                <Upload size={18} aria-hidden />
                {t('settings.logo_choose')}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleRemoveLogo}
                disabled={!customLogo}
              >
                <Trash2 size={18} aria-hidden />
                {t('settings.logo_remove')}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section-premium">
          <h3>
            <User size={20} className="premium-hero-title-icon" style={{ verticalAlign: 'middle', marginRight: 6 }} aria-hidden />
            {t('settings.bar_profile_section')}
          </h3>
          <p className="description settings-logo-hint">{t('settings.bar_profile_hint')}</p>
          <div className="form-group">
            <label>{t('settings.bar_profile_name_label')}</label>
            <input
              type="text"
              className="glass"
              value={profileDisplayName}
              onChange={(e) => setProfileDisplayName(e.target.value)}
              placeholder={user?.email || ''}
              autoComplete="name"
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginBottom: '1.25rem' }}
            onClick={handleSaveBarProfileName}
            disabled={barProfileSaving || !user?.id}
          >
            {barProfileSaving ? '…' : t('settings.bar_profile_save_name')}
          </button>
          <h4 className="settings-subsection-title">{t('settings.bar_profile_photo_section')}</h4>
          <p className="description settings-logo-hint">{t('settings.bar_profile_photo_hint')}</p>
          <input
            ref={barAvatarFileRef}
            type="file"
            accept="image/*"
            className="settings-logo-file-input"
            aria-hidden
            tabIndex={-1}
            onChange={handleBarAvatarFile}
          />
          <div className="settings-logo-block glass">
            <div className="settings-logo-canvas settings-logo-canvas--round">
              {barAvatarDataUrl ? (
                <img src={barAvatarDataUrl} alt="" className="settings-logo-preview settings-bar-avatar-preview" />
              ) : (
                <div className="settings-logo-fallback settings-bar-avatar-fallback">
                  <span className="settings-logo-fallback-label">{t('settings.bar_profile_choose_photo')}</span>
                </div>
              )}
            </div>
            <div className="settings-logo-actions">
              <button type="button" className="btn btn-primary" onClick={() => barAvatarFileRef.current?.click()}>
                <Upload size={18} aria-hidden />
                {t('settings.bar_profile_choose_photo')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleRemoveBarAvatar} disabled={!barAvatarDataUrl}>
                <Trash2 size={18} aria-hidden />
                {t('settings.bar_profile_remove_photo')}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section-premium">
          <h3>{t('settings.notifications_section')}</h3>
          <div className="setting-item settings-browser-notify-row" style={{ flexWrap: 'wrap', gap: '12px' }}>
            <span>
              Estado:{' '}
              <strong>
                {browserNotifyPerm === 'unsupported'
                  ? 'No disponible'
                  : browserNotifyPerm === 'granted'
                    ? 'Permitido'
                    : browserNotifyPerm === 'denied'
                      ? 'Bloqueado'
                      : 'Sin decidir aún'}
              </strong>
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleRequestBrowserNotifications}
              disabled={browserNotifyPerm === 'unsupported' || browserNotifyPerm === 'granted'}
            >
              {browserNotifyPerm === 'granted' ? 'Ya activo' : 'Permitir notificaciones del navegador'}
            </button>
          </div>
        </section>

        <section className="settings-section settings-section-premium">
          <h3>{t('settings.email_section')}</h3>
          <p className="description settings-logo-hint">{t('settings.smtp_hint')}</p>
          {!isSuperAdmin && (
            <p className="description settings-logo-hint">
              Solo el superadmin puede cambiar la cuenta SMTP. Las subcuentas envían alertas por email usando esta
              configuración global en sus reglas de automatización.
            </p>
          )}
          {smtpStatus?.credentialsFromEnv && (
            <p className="description settings-logo-hint">
              Las credenciales activas vienen de variables de entorno del servidor (SYSCOM_SMTP_USER / SYSCOM_SMTP_PASS).
              El formulario solo actualiza la cuenta si no están definidas en .env.
            </p>
          )}
          {smtpStatus && (
            <p className="description settings-logo-hint">
              Hoy: {smtpStatus.dailySent ?? 0} / {smtpStatus.dailyLimit ?? '—'} envíos · Cola pendiente:{' '}
              {smtpStatus.outboxPending ?? 0}
              {smtpStatus.configured ? ' · SMTP listo' : ' · SMTP sin configurar'}
            </p>
          )}
          <div className="form-group">
            <label>Proveedor</label>
            <select
              className="glass"
              value={smtpForm.provider}
              disabled={!isSuperAdmin}
              onChange={(e) => setSmtpForm({ ...smtpForm, provider: e.target.value })}
            >
              {(smtpStatus?.providers || [
                { id: 'gmail', label: 'Gmail' },
                { id: 'outlook', label: 'Outlook' },
                { id: 'yahoo', label: 'Yahoo' },
                { id: 'gmx', label: 'GMX' },
                { id: 'custom', label: 'Otro' },
              ]).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {smtpForm.provider === 'custom' && (
            <div className="form-group">
              <label>Host SMTP</label>
              <input
                type="text"
                className="glass"
                disabled={!isSuperAdmin}
                value={smtpForm.host}
                onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })}
                placeholder="smtp.ejemplo.com"
              />
            </div>
          )}
          <div className="form-group">
            <label>Correo saliente</label>
            <input
              type="email"
              className="glass"
              disabled={!isSuperAdmin}
              value={smtpForm.user}
              onChange={(e) => setSmtpForm({ ...smtpForm, user: e.target.value })}
              placeholder={
                smtpStatus?.fromEmail
                  ? `Configurado: ${smtpStatus.fromEmail}`
                  : 'notificaciones@su-dominio.com'
              }
              autoComplete="username"
            />
          </div>
          <div className="form-group">
            <label>Contraseña de aplicación</label>
            <input
              type="password"
              className="glass"
              disabled={!isSuperAdmin}
              value={smtpForm.password}
              onChange={(e) => setSmtpForm({ ...smtpForm, password: e.target.value })}
              placeholder={smtpStatus?.hasPassword ? 'Dejar vacío para no cambiar' : 'Contraseña de aplicación (no la normal)'}
              autoComplete="new-password"
            />
          </div>
          <p className="description settings-logo-hint">
            Guía detallada: <code>docs/SMTP_NOTIFICACIONES.md</code> en el proyecto. En producción use{' '}
            <code>SYSCOM_SMTP_USER</code> y <code>SYSCOM_SMTP_PASS</code> en el .env del servidor.
          </p>
          <div className="form-group">
            <label>Correo de prueba</label>
            <input
              type="email"
              className="glass"
              value={smtpTestTo}
              onChange={(e) => setSmtpTestTo(e.target.value)}
              placeholder={user?.email || 'destino@ejemplo.com'}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSaveSmtpConfig}
              disabled={!isSuperAdmin || smtpSaveBusy}
            >
              {smtpSaveBusy ? 'Guardando…' : 'Guardar SMTP'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestSmtp}
              disabled={!isSuperAdmin || smtpTestBusy}
            >
              {smtpTestBusy ? 'Enviando…' : 'Enviar prueba'}
            </button>
          </div>
        </section>

        {hasNavPage('Settings') && (
          <section className="settings-section settings-section-premium">
            <h3>
              <Database size={20} className="premium-hero-title-icon" style={{ verticalAlign: 'middle', marginRight: 6 }} aria-hidden />
              {t('settings.database_backup_section')}
            </h3>
            <p className="description settings-logo-hint">{t('settings.database_backup_hint')}</p>
            <div className="settings-db-backup-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDatabaseExport}
                disabled={dbExportBusy || dbImportBusy}
              >
                <Download size={18} aria-hidden />
                {dbExportBusy ? t('settings.database_export_busy') : t('settings.database_export')}
              </button>
              <input
                ref={dbImportFileRef}
                type="file"
                accept=".db,application/octet-stream"
                className="settings-logo-file-input"
                aria-label={t('settings.database_import_pick')}
                tabIndex={-1}
                onChange={handleDatabaseImportPick}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => dbImportFileRef.current?.click()}
                disabled={dbExportBusy || dbImportBusy}
              >
                <Upload size={18} aria-hidden />
                {dbImportBusy ? t('settings.database_import_busy') : t('settings.database_import')}
              </button>
            </div>
            <div className="form-group settings-nas-block" style={{ marginTop: '1.25rem' }}>
              <label htmlFor="syscom-nas-destination">{t('settings.database_nas_label')}</label>
              <textarea
                id="syscom-nas-destination"
                className="glass"
                rows={3}
                value={nasDestination}
                onChange={(e) => setNasDestination(e.target.value)}
                placeholder={t('settings.database_nas_placeholder')}
                spellCheck={false}
              />
              <div className="settings-nas-example glass" aria-label={t('settings.database_nas_example_title')}>
                <div className="settings-nas-example-title">{t('settings.database_nas_example_title')}</div>
                <code className="settings-nas-example-code">{t('settings.database_nas_example_code')}</code>
              </div>
              <details className="settings-nas-commands-details glass">
                <summary className="settings-nas-commands-summary">{t('settings.database_nas_commands_summary')}</summary>
                <div className="settings-nas-commands-body">
                  <p className="description">{t('settings.database_nas_commands_intro')}</p>
                  <p className="description">{t('settings.database_nas_cmd_line_builtin')}</p>
                  <pre className="settings-nas-command-pre">{t('settings.database_nas_cmd_pre')}</pre>
                  <p className="description settings-nas-commands-override">{t('settings.database_nas_cmd_override')}</p>
                </div>
              </details>
              <div className="settings-nas-save-wrap">
                <button
                  type="button"
                  className="btn btn-primary settings-nas-save-btn"
                  onClick={handleSaveNasDestination}
                  disabled={nasSaveBusy || dbExportBusy || dbImportBusy}
                >
                  {nasSaveBusy ? '…' : t('settings.database_nas_save')}
                </button>
              </div>
            </div>
          </section>
        )}
        </div>

        <div className="settings-log-footer">
          <button
            type="button"
            className={activityLogOpen ? 'btn btn-secondary settings-log-footer__btn' : 'btn btn-primary settings-log-footer__btn'}
            title={t('settings.activity_log_hint')}
            onClick={() => setActivityLogOpen((o) => !o)}
          >
            {activityLogOpen ? t('settings.activity_log_hide') : t('settings.activity_log_btn')}
          </button>
        </div>

        {activityLogOpen && (
          <div className="settings-activity-log-wrap" ref={activityLogWrapRef}>
            <AppActivityLogDock
              embedded
              panelTitle={t('settings.activity_log_panel_title')}
              onRequestClose={() => setActivityLogOpen(false)}
              hidePanelLabel={t('settings.activity_log_hide')}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPage;
