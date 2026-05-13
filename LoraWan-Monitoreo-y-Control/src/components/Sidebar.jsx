import React, { useState, useEffect } from 'react';
import './Sidebar.css';
import { useAuth } from '../context/AuthContext';
import { useBarAvatarOverride } from '../hooks/useBarAvatarOverride';
import { useLanguage } from '../context/LanguageContext';
import {
  LayoutDashboard,
  Tablet,
  History,
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
  const { logout, isAdmin, isSuperAdmin, user, userProfile } = useAuth();
  const barAvatarOverride = useBarAvatarOverride();

  const sidebarRoleLabel = () => {
    const r = user?.role;
    if (r === 'superadmin') return 'Super administrador';
    if (r === 'admin') return 'Administrador';
    return 'Usuario';
  };

  const avatarUrl = barAvatarOverride || userProfile?.avatarUrl || user?.avatarUrl;
  const displayName =
    (userProfile?.profileName && String(userProfile.profileName).trim()) ||
    (user?.profileName && String(user.profileName).trim()) ||
    user?.email?.split('@')[0] ||
    '';

  const userInitials = () => {
    const n = (displayName || user?.email || '?').trim();
    if (!n) return '?';
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  };
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
    { id: 'Gateway', icon: <RadioTower size={20} />, label: t('nav.gateway'), adminOnly: true },
    { id: 'Automations', icon: <Zap size={20} />, label: t('nav.automations'), adminOnly: true },
    { id: 'History', icon: <History size={20} />, label: t('nav.history') },
    { id: 'SpecialReport', icon: <Calculator size={20} />, label: t('nav.special_report') },
    { id: 'Users', icon: <Users size={20} />, label: 'Usuarios', adminOnly: true },
    { id: 'Templates', icon: <Layers size={20} />, label: 'Plantillas', superAdminOnly: true },
    { id: 'Settings', icon: <Settings size={20} />, label: t('nav.settings'), adminOnly: true },
  ].filter(
    (item) =>
      (!item.adminOnly || isAdmin) && (!item.superAdminOnly || isSuperAdmin)
  );

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

      <div className="sidebar-user-card">
        <div className={`sidebar-user-avatar${avatarUrl ? ' sidebar-user-avatar--photo' : ''}`} aria-hidden>
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="sidebar-user-photo" referrerPolicy="no-referrer" />
          ) : (
            userInitials()
          )}
        </div>
        <div className="sidebar-user-meta">
          {displayName ? <div className="sidebar-user-name">{displayName}</div> : null}
          <div className="sidebar-user-role">{sidebarRoleLabel()}</div>
        </div>
      </div>

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
