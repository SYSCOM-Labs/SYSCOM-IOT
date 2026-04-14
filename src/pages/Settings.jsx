import React, { useEffect, useRef, useState } from 'react';
import './Settings.css';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { getMe, getServerOrigin, updateUser } from '../services/localAuth';
import { Copy, RefreshCw, Upload, Trash2 } from 'lucide-react';
import { DEFAULT_APP_LOGO_URL, LOGO_STORAGE_KEY } from '../constants/appLogo';

const SettingsPage = () => {
  const { user, refreshInterval, updateRefreshInterval, isAdmin } = useAuth();
  const { t } = useLanguage();
  const { isDarkMode, toggleTheme } = useTheme();

  const [profile, setProfile] = useState(null);
  const [copyOk, setCopyOk] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  // Logo management: por defecto `/logo-syscom.svg`; un archivo subido sustituye y se guarda en localStorage.
  const logoInputRef = useRef(null);
  const [customLogo, setCustomLogo] = useState(() => localStorage.getItem(LOGO_STORAGE_KEY));
  const logoPreviewSrc = customLogo || DEFAULT_APP_LOGO_URL;

  const handleLogoChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      setCustomLogo(dataUrl);
      localStorage.setItem(LOGO_STORAGE_KEY, dataUrl);
      window.dispatchEvent(new CustomEvent('logo-changed'));
    };
    reader.readAsDataURL(file);
  };

  const handleLogoRemove = () => {
    setCustomLogo(null);
    localStorage.removeItem(LOGO_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('logo-changed'));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getMe();
        if (!cancelled) setProfile(p);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  const origin = getServerOrigin();
  const ingestUrl =
    profile?.id && profile?.ingestToken
      ? `${origin}/api/ingest/${profile.id}/${profile.ingestToken}`
      : '';
  const ingestUrlDedicated =
    profile?.id && profile?.ingestToken
      ? `Ej. con INGEST_PORT: http://<tu-servidor>:<INGEST_PORT>/ingest/${profile.id}/${profile.ingestToken}`
      : '';
  const lorawanUplinkUrl =
    profile?.id && profile?.ingestToken
      ? `${origin}/api/lorawan/uplink/${profile.id}/${profile.ingestToken}`
      : '';
  const milesightUplinkUrl =
    profile?.id && profile?.ingestToken
      ? `${origin}/api/milesight/uplink/${profile.id}/${profile.ingestToken}`
      : '';

  const regenerateToken = async () => {
    if (!profile?.id) return;
    if (!window.confirm('¿Regenerar token? Deberás actualizar la URL en todos los gateways.')) return;
    setRegenBusy(true);
    try {
      const updated = await updateUser(profile.id, { regenerateIngestToken: true });
      setProfile(updated);
    } catch (e) {
      alert(e.message || 'No se pudo regenerar el token');
    } finally {
      setRegenBusy(false);
    }
  };

  const copyIngest = async () => {
    if (!ingestUrl) return;
    try {
      await navigator.clipboard.writeText(ingestUrl);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    } catch {
      alert(ingestUrl);
    }
  };

  const [emailConfig, setEmailConfig] = useState(() => {
    const saved = localStorage.getItem('iot_email_config');
    return saved ? JSON.parse(saved) : { serviceId: '', templateId: '', publicKey: '' };
  });

  const handleSaveEmailConfig = () => {
    localStorage.setItem('iot_email_config', JSON.stringify(emailConfig));
    alert('Configuración de Email guardada.');
  };

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>{t('settings.page_title')}</h1>
      </div>

      <div className="settings-grid">
        <section className="settings-section card glass">
          <h3>Ingesta HTTP (estilo Datacake)</h3>
          <p className="description">
            Configura tu gateway o script para enviar telemetría con <code>POST</code> y cuerpo JSON. La URL incluye tu
            identificador de usuario y un token secreto; no la compartas públicamente. Referencia conceptual:{' '}
            <a href="https://docs.datacake.de/" target="_blank" rel="noreferrer">
              documentación Datacake
            </a>
            .
          </p>
          <p className="description" style={{ fontSize: '0.85rem' }}>
            El JSON puede llevar <code>device_id</code> / <code>deviceId</code> / <code>devEUI</code>, y mediciones en{' '}
            <code>data</code>, <code>properties</code>, <code>measurements</code> o en la raíz del objeto.
          </p>
          {ingestUrl ? (
            <>
              <div className="form-group">
                <label>URL de ingesta (mismo puerto que la API, por defecto 3001)</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input type="text" className="glass" readOnly value={ingestUrl} style={{ flex: 1, minWidth: '200px' }} />
                  <button type="button" className="btn btn-primary" onClick={copyIngest}>
                    <Copy size={16} style={{ marginRight: 6 }} />
                    {copyOk ? 'Copiado' : 'Copiar'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={regenerateToken} disabled={regenBusy}>
                    <RefreshCw size={16} style={{ marginRight: 6 }} className={regenBusy ? 'spin' : ''} />
                    Regenerar token
                  </button>
                </div>
              </div>
              <p className="description" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Opcional: variable de entorno <code>INGEST_PORT</code> en el servidor abre un segundo puerto solo para{' '}
                <code>POST /ingest/&lt;userId&gt;/&lt;token&gt;</code> (sin prefijo <code>/api</code>).
              </p>
              <p className="description mono" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                {ingestUrlDedicated}
              </p>
              <div className="form-group" style={{ marginTop: '1rem' }}>
                <label>Uplink LoRaWAN (ChirpStack, TTS, Milesight NS embebido, …)</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="glass"
                    readOnly
                    value={lorawanUplinkUrl}
                    style={{ flex: 1, minWidth: '200px' }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => lorawanUplinkUrl && navigator.clipboard.writeText(lorawanUplinkUrl)}
                  >
                    Copiar
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>Alias Milesight (<code>dataUpURL</code> en el gateway)</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="glass"
                    readOnly
                    value={milesightUplinkUrl}
                    style={{ flex: 1, minWidth: '200px' }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => milesightUplinkUrl && navigator.clipboard.writeText(milesightUplinkUrl)}
                  >
                    Copiar
                  </button>
                </div>
              </div>
              <div className="form-group" style={{ marginTop: '1.25rem' }}>
                <label>LNS integrado — Packet Forward Semtech (UDP)</label>
                <p className="description" style={{ fontSize: '0.85rem' }}>
                  Si el backend arranca con la variable de entorno <code>LNS_UDP_PORT</code> (p. ej. <code>1700</code>),
                  actúa como network server para el modo <strong>Semtech</strong> del gateway:{' '}
                  <strong>Server Address</strong> = IP o nombre DNS <em>público</em> de la máquina donde corre Node
                  (no uses la URL <code>https://…</code> de Render aquí). <strong>Port Up / Down</strong> = el mismo
                  valor que <code>LNS_UDP_PORT</code> (típicamente 1700). Antes, registre el gateway en{' '}
                  <strong>Gateways LoRaWAN</strong> con el mismo EUI que muestra el equipo; la ingesta se asocia al
                  usuario por ese EUI. En Render u otros PaaS solo HTTP <strong>no</strong> exponen UDP: use una VM,
                  Docker en su red, o túnel UDP. Pruebas sin alta de gateway:{' '}
                  <code>SYSCOM_LNS_DEFAULT_USER_ID</code> = su <code>userId</code> (solo desarrollo).
                </p>
              </div>
              {isAdmin && (
                <div className="form-group" style={{ marginTop: '1rem' }}>
                  <label>Tiempo casi real y métricas (autohospedado)</label>
                  <p className="description" style={{ fontSize: '0.85rem' }}>
                    El cliente mantiene <strong>SSE</strong> en <code>/api/events/stream</code> para actualizar listados y
                    panel al guardarse telemetría o eventos LNS. Métricas en memoria del proceso Node:{' '}
                    <code>GET /api/admin/syscom-metrics</code> (cabecera <code>Authorization: Bearer …</code>). Límites
                    por IP: login y POST de ingesta; ajuste opcional con <code>SYSCOM_LOGIN_RATE_MAX</code> y{' '}
                    <code>SYSCOM_INGEST_RATE_MAX</code>.
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="description">Inicia sesión de nuevo para cargar el token de ingesta.</p>
          )}
        </section>

        <section className="settings-section card glass">
          <h3>{t('settings.display_section')}</h3>
          <p className="description" style={{ marginBottom: '0.75rem' }}>
            {t('settings.dark_mode_hint')}
          </p>
          <div className="setting-item">
            <span>{t('settings.dark_mode')}</span>
            <div
              className={`toggle ${isDarkMode ? 'active' : ''}`}
              onClick={toggleTheme}
              onKeyDown={(e) => e.key === 'Enter' && toggleTheme()}
              role="button"
              tabIndex={0}
              style={{ cursor: 'pointer' }}
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
          <div className="setting-item" style={{ marginTop: '1rem', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
            <span>{t('settings.refresh_interval')}</span>
            <input
              type="number"
              className="glass"
              min={2000}
              step={1000}
              value={refreshInterval}
              onChange={(e) => updateRefreshInterval(Number(e.target.value) || 5000)}
              style={{ maxWidth: '120px' }}
            />
          </div>
        </section>

        {isAdmin && (
          <section className="settings-section card glass">
            <h3>Logotipo de la aplicación</h3>
            <p className="description">
              Por defecto se muestra el logotipo SYSCOM incluido en la aplicación. Si subes una imagen, se usa en la barra lateral y se guarda solo en este navegador.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <img
                src={logoPreviewSrc}
                alt="Logo actual"
                style={{ maxHeight: '52px', maxWidth: '220px', objectFit: 'contain', borderRadius: '8px', border: '1px solid var(--border-color)', padding: '6px', background: 'var(--bg-hover)' }}
              />
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="btn btn-primary" onClick={() => logoInputRef.current.click()}>
                  <Upload size={16} style={{ marginRight: 6 }} />
                  {customLogo ? 'Cambiar logotipo' : 'Subir logotipo'}
                </button>
                {customLogo && (
                  <button type="button" className="btn btn-secondary" onClick={handleLogoRemove}>
                    <Trash2 size={16} style={{ marginRight: 6 }} />
                    Restaurar predeterminado
                  </button>
                )}
              </div>
              <input type="file" ref={logoInputRef} accept="image/*" style={{ display: 'none' }} onChange={handleLogoChange} />
            </div>
          </section>
        )}

        <section className="settings-section card glass">
          <h3>Notificaciones de Email (EmailJS)</h3>
          <p className="description">Configura tu cuenta de EmailJS para recibir alertas reales.</p>
          <div className="form-group">
            <label>Service ID</label>
            <input
              type="text"
              className="glass"
              value={emailConfig.serviceId}
              onChange={(e) => setEmailConfig({ ...emailConfig, serviceId: e.target.value })}
              placeholder="e.g. service_xxxx"
            />
          </div>
          <div className="form-group">
            <label>Template ID</label>
            <input
              type="text"
              className="glass"
              value={emailConfig.templateId}
              onChange={(e) => setEmailConfig({ ...emailConfig, templateId: e.target.value })}
              placeholder="e.g. template_xxxx"
            />
          </div>
          <div className="form-group">
            <label>Public Key (User ID)</label>
            <input
              type="text"
              className="glass"
              value={emailConfig.publicKey}
              onChange={(e) => setEmailConfig({ ...emailConfig, publicKey: e.target.value })}
              placeholder="e.g. user_xxxx"
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={handleSaveEmailConfig}>
            Guardar Configuración de Email
          </button>
          <p className="description" style={{ fontSize: '0.8rem', marginTop: '10px' }}>
            Crea una cuenta gratuita en EmailJS.com para obtener estos datos.
          </p>
        </section>
      </div>
    </div>
  );
};

export default SettingsPage;
