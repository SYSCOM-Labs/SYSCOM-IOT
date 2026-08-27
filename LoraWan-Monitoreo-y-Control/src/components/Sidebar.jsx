import React, { useState, useEffect } from 'react';
import './Sidebar.css';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  LayoutDashboard,
  Tablet,
  FileSpreadsheet,
  Zap,
  Settings,
  LogOut,
  Globe,
  X,
  Calculator,
  Users,
  Layers,
  RadioTower,
} from 'lucide-react';

const Sidebar = ({ activePage, onNavigate, isOpen, onToggle }) => {
  const { logout, hasNavPage } = useAuth();
  const { t, language, toggleLanguage } = useLanguage();
  const [logo, setLogo] = useState(() => localStorage.getItem('syscom_iot_logo') || null);

  useEffect(() => {
    const syncLogo = () => {
      setLogo(localStorage.getItem('syscom_iot_logo') || null);
    };
    window.addEventListener('syscom-custom-logo-changed', syncLogo);
    return () => window.removeEventListener('syscom-custom-logo-changed', syncLogo);
  }, []);

  const menuItems = [
    { id: 'Dashboard', icon: <LayoutDashboard size={20} />, label: t('nav.dashboard') },
    { id: 'Devices', icon: <Tablet size={20} />, label: t('nav.devices') },
    { id: 'Gateway', icon: <RadioTower size={20} />, label: t('nav.gateway') },
    { id: 'Automations', icon: <Zap size={20} />, label: t('nav.automations') },
    { id: 'History', icon: <FileSpreadsheet size={20} />, label: t('nav.history') },
    { id: 'SpecialReport', icon: <Calculator size={20} />, label: t('nav.special_report') },
    { id: 'Users', icon: <Users size={20} />, label: 'Usuarios' },
    { id: 'Templates', icon: <Layers size={20} />, label: 'Plantillas' },
    { id: 'Settings', icon: <Settings size={20} />, label: t('nav.settings') },
  ].filter((item) => hasNavPage(item.id));

  return (
    <aside className={`sidebar sidebar--premium ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-logo" title={t('brand.logo_sidebar_hint')}>
        {logo ? (
          <img src={logo} alt="" className="custom-logo-img" />
        ) : (
          <div className="sidebar-brand-row">
            <img src="/syscom-iot-logo.png" alt="" className="sidebar-default-logo-img" />
            <span className="logo-text logo-text--sycom">{t('brand.name')}</span>
          </div>
        )}
        <button type="button" className="sidebar-close-btn" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          <X size={24} />
        </button>
      </div>

      <nav className="sidebar-nav">
        {menuItems.map((item, index) => (
          <div
            key={index}
            className={`nav-item ${activePage === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            onKeyDown={(e) => e.key === 'Enter' && onNavigate(item.id)}
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
        <div className="nav-item logout-item" onClick={logout}>
          <LogOut size={20} />
          <span className="nav-label">{t('nav.logout')}</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
