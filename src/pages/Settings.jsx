import React, { useRef, useState } from 'react';
import './Settings.css';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { Upload, Trash2 } from 'lucide-react';
import { DEFAULT_APP_LOGO_URL, LOGO_STORAGE_KEY } from '../constants/appLogo';

const SettingsPage = () => {
  const { refreshInterval, updateRefreshInterval, isAdmin } = useAuth();
  const { t } = useLanguage();
  const { isDarkMode, toggleTheme } = useTheme();

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
