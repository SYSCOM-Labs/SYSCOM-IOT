import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './CenteredAlertModal.css';

/** Contenedor fuera de `#root` para que `position:fixed` no lo rompan reglas del layout (p. ej. Dispositivos premium). */
function getCenteredAlertPortalRoot() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('syscom-centered-alert-portal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'syscom-centered-alert-portal';
    document.body.appendChild(el);
  }
  return el;
}

/** Escapa HTML y convierte `**negrita**` en <strong> (solo mensajes controlados por la app). */
export function formatCenteredAlertHtml(text) {
  if (!text) return '';
  const esc = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Sustituye `alert()` nativo: centrado, estilo glass/premium acorde al tema.
 */
export default function CenteredAlertModal({
  open,
  title = 'Aviso',
  message,
  onClose,
  variant = 'error',
  confirmLabel = 'Aceptar',
  /** Si se define, se muestra un segundo botón que solo ejecuta `onClose` (p. ej. «Cancelar»). */
  cancelLabel = null,
  /** Al pulsar el botón principal: si existe, se espera y luego se llama `onClose`; si no, solo `onClose`. */
  onConfirm = null,
  /** Estilo rojo para la acción principal (p. ej. eliminar). */
  confirmDanger = false,
  /** Informes largos (p. ej. plantillas «Ajustar»): modal más ancho. */
  wide = false,
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  if (!open || message == null || message === '') return null;

  const showCancel = Boolean(cancelLabel && String(cancelLabel).trim());

  const handlePrimary = async () => {
    if (busy) return;
    if (typeof onConfirm === 'function') {
      setBusy(true);
      try {
        await onConfirm();
      } catch {
        /* El padre suele mostrar el error (p. ej. `setBlockingAlert`). */
      } finally {
        setBusy(false);
        onClose?.();
      }
    } else {
      onClose?.();
    }
  };

  const html = formatCenteredAlertHtml(message);
  const modalClass = [
    'centered-alert-modal',
    'glass',
    'card',
    `centered-alert-modal--${variant}`,
    wide ? 'centered-alert-modal--wide' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const overlay = (
    <div
      className="centered-alert-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="centered-alert-title"
      aria-describedby="centered-alert-desc"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !(busy && typeof onConfirm === 'function')) onClose?.();
      }}
    >
      <div className={modalClass} onMouseDown={(e) => e.stopPropagation()}>
        <div className="centered-alert-head">
          <div className="centered-alert-head-main">
            <h2 id="centered-alert-title">{title}</h2>
          </div>
          <button
            type="button"
            className="btn-icon centered-alert-close"
            onClick={onClose}
            disabled={busy && typeof onConfirm === 'function'}
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>
        <div className="centered-alert-body">
          <div
            id="centered-alert-desc"
            className="centered-alert-message"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
        <div
          className={['centered-alert-footer', showCancel ? 'centered-alert-footer--split' : '']
            .filter(Boolean)
            .join(' ')}
        >
          {showCancel ? (
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              {cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={confirmDanger ? 'btn centered-alert-btn-danger' : 'btn btn-primary'}
            onClick={() => void handlePrimary()}
            disabled={busy && typeof onConfirm === 'function'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  const portalRoot = getCenteredAlertPortalRoot();
  return portalRoot ? createPortal(overlay, portalRoot) : overlay;
}
