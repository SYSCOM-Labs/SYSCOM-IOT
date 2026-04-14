import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, Edit2, Play, UserPlus, Trash2 } from 'lucide-react';
import './ActionMenu.css';

const ActionMenu = ({
  onEdit,
  onDownlink,
  onAssign,
  onPurgeFromSystem,
  isOpen,
  onToggle,
}) => {
  const triggerRef = useRef(null);
  const menuDropdownRef = useRef(null);
  const [coords, setCoords] = useState(null);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return undefined;
    const el = triggerRef.current;
    const update = () => {
      const r = el.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, right: r.right });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [isOpen]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!isOpen) return;
      const t = event.target;
      if (triggerRef.current?.contains(t)) return;
      if (menuDropdownRef.current?.contains(t)) return;
      onToggle(null);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isOpen, onToggle]);

  const dropdown =
    isOpen && coords ? (
      <div
        ref={menuDropdownRef}
        className="dropdown-menu dropdown-menu--portal glass card"
        style={{
          position: 'fixed',
          top: coords.top,
          left: coords.right,
          transform: 'translateX(-100%)',
          zIndex: 10050,
        }}
        role="menu"
      >
        {onEdit && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
              onToggle(null);
            }}
          >
            <Edit2 size={16} /> Editar
          </button>
        )}
        {onDownlink && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onDownlink();
              onToggle(null);
            }}
          >
            <Play size={16} /> Downlink
          </button>
        )}
        {onAssign && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onAssign();
              onToggle(null);
            }}
          >
            <UserPlus size={16} /> Asignar dispositivo
          </button>
        )}
        {onPurgeFromSystem && (
          <button
            type="button"
            className="dropdown-item dropdown-item--danger"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onPurgeFromSystem();
              onToggle(null);
            }}
          >
            <Trash2 size={16} /> Eliminar del sistema
          </button>
        )}
      </div>
    ) : null;

  return (
    <div className="action-menu-container">
      <button
        ref={triggerRef}
        type="button"
        className={`btn-icon ${isOpen ? 'active' : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <MoreVertical size={18} />
      </button>
      {typeof document !== 'undefined' && dropdown ? createPortal(dropdown, document.body) : null}
    </div>
  );
};

export default ActionMenu;
