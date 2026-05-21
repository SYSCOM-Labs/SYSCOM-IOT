import React, { useCallback, useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { SYSCOM_AUTOMATION_TOAST } from '../constants/automationEvents.js';
import './AutomationToastBridge.css';

function ToastCard({ id, appLabel, title, subtitle, variant, onClose }) {
  return (
    <div className="automation-desktop-toast" data-variant={variant || 'indigo'} role="status">
      <div className="automation-desktop-toast__icon" aria-hidden>
        <Bell size={72} strokeWidth={2.25} />
      </div>
      <div className="automation-desktop-toast__body">
        <div className="automation-desktop-toast__app">{appLabel || 'SYSCOM IoT'}</div>
        <p className="automation-desktop-toast__title">{title || 'Automatización'}</p>
        {subtitle ? <p className="automation-desktop-toast__subtitle">{subtitle}</p> : null}
      </div>
      <button type="button" className="automation-desktop-toast__close" onClick={() => onClose(id)} aria-label="Cerrar">
        <X size={66} />
      </button>
    </div>
  );
}

/**
 * Alertas de automatización (acción «toast»): centradas en pantalla, solo se cierran con X.
 */
export default function AutomationToastBridge() {
  const [items, setItems] = useState([]);

  const remove = useCallback((id) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  useEffect(() => {
    const onToast = (ev) => {
      const d = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setItems((prev) => [...prev, { id, ...d }]);
    };
    window.addEventListener(SYSCOM_AUTOMATION_TOAST, onToast);
    return () => window.removeEventListener(SYSCOM_AUTOMATION_TOAST, onToast);
  }, [remove]);

  return (
    <div className="automation-toast-host" aria-live="polite">
      {items.map((t) => (
        <ToastCard
          key={t.id}
          id={t.id}
          appLabel={t.appLabel}
          title={t.title}
          subtitle={t.subtitle}
          variant={t.variant}
          onClose={remove}
        />
      ))}
    </div>
  );
}
