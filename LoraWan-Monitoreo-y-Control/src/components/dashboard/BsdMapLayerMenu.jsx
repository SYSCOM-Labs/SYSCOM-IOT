import React, { useEffect, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import { MAP_BASE_LAYER_OPTIONS, normalizeMapBaseLayerId } from './mapWidgetLayers';

/**
 * Selector compacto de capa base (icono capas + menú).
 * @param {{ value: string; onChange: (id: string) => void; disabled?: boolean }} props
 */
export default function BsdMapLayerMenu({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const v = normalizeMapBaseLayerId(value);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="bsd-map-layer-menu" ref={rootRef}>
      <button
        type="button"
        className="bsd-map-layer-menu__trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Capas del mapa"
        title="Capas del mapa"
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((o) => !o);
        }}
      >
        <Layers size={18} strokeWidth={2} aria-hidden />
      </button>
      {open ? (
        <ul className="bsd-map-layer-menu__list" role="listbox" aria-label="Tipo de mapa">
          {MAP_BASE_LAYER_OPTIONS.map((opt) => (
            <li key={opt.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={opt.id === v}
                className={`bsd-map-layer-menu__opt${opt.id === v ? ' is-active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(opt.id);
                  setOpen(false);
                }}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
