import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './Sidebar.css';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  LayoutDashboard,
  Tablet,
  History,
  Zap,
  Settings,
  Globe,
  X,
  Calculator,
  Users,
  Layers,
  RadioTower,
} from 'lucide-react';
import { DEFAULT_APP_LOGO_URL, getEffectiveLogoSrc } from '../constants/appLogo';
import { getPathForNavId, isMainNavActive } from '../constants/routes';

const Sidebar = ({ pathname, isOpen, onToggle, onAfterNavigate }) => {
  const navigate = useNavigate();
  const { isAdmin, isSuperAdmin } = useAuth();
  const { t, language, toggleLanguage } = useLanguage();

  const [logoSrc, setLogoSrc] = useState(() => getEffectiveLogoSrc());

  useEffect(() => {
    const onLogoChanged = () => setLogoSrc(getEffectiveLogoSrc());
    window.addEventListener('logo-changed', onLogoChanged);
    return () => window.removeEventListener('logo-changed', onLogoChanged);
  }, []);

  const menuItems = [
    { id: 'Dashboard', icon: <LayoutDashboard size={20} />, label: t('nav.dashboard') },
    { id: 'Devices', icon: <Tablet size={20} />, label: t('nav.devices') },
    { id: 'History', icon: <History size={20} />, label: t('nav.history') },
    { id: 'Gateway', icon: <RadioTower size={20} />, label: t('nav.gateway'), adminOnly: true },
    { id: 'Automations', icon: <Zap size={20} />, label: t('nav.automations'), adminOnly: true },
    { id: 'SpecialReport', icon: <Calculator size={20} />, label: t('nav.special_report') },
    { id: 'Settings', icon: <Settings size={20} />, label: t('nav.settings'), adminOnly: true },
    { id: 'Templates', icon: <Layers size={20} />, label: t('nav.templates'), superAdminOnly: true },
    { id: 'Users', icon: <Users size={20} />, label: t('nav.users'), adminOnly: true },
  ].filter(
    (item) =>
      (!item.adminOnly || isAdmin) && (!item.superAdminOnly || isSuperAdmin)
  );

  const go = (navId) => {
    navigate(getPathForNavId(navId));
    onAfterNavigate?.();
  };

  return (
    <aside className={`sidebar sidebar--premium ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-logo">
        <div className="sidebar-logo-brand">
          <img
            src={logoSrc}
            alt={t('brand.name')}
            className={
              logoSrc === DEFAULT_APP_LOGO_URL
                ? 'custom-logo-img custom-logo-img--bundled'
                : 'custom-logo-img'
            }
            decoding="async"
            loading="lazy"
          />
        </div>
        <button
          type="button"
          className="sidebar-close-btn"
          onClick={onToggle}
          aria-label={t('common.close')}
        >
          <X size={22} strokeWidth={2} />
        </button>
      </div>

      <nav className="sidebar-nav">
        {menuItems.map((item, index) => (
          <div
            key={index}
            className={`nav-item ${isMainNavActive(item.id, pathname) ? 'active' : ''}`}
            onClick={() => go(item.id)}
            onKeyDown={(e) => e.key === 'Enter' && go(item.id)}
            role="button"
            tabIndex={0}
          >
            {item.icon}
            <span className="nav-label">{item.label}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="nav-item lang-toggle" onClick={toggleLanguage}>
          <Globe size={20} />
          <span className="nav-label">{language === 'es' ? 'English' : 'Español'}</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
