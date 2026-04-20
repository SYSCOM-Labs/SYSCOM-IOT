import React, { useEffect } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import './FormToast.css';

/**
 * Aviso tipo toast (éxito / error). Si durationMs <= 0 no se cierra solo; use la X cuando hay onDismiss.
 * @param {{ type: 'success'|'error', message: string, onDismiss?: () => void, durationMs?: number }} props
 */
export default function FormToast({ type, message, onDismiss, durationMs = 5000 }) {
  useEffect(() => {
    if (!message || durationMs <= 0) return undefined;
    const t = setTimeout(() => onDismiss?.(), durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  return (
    <div className={`form-toast form-toast--${type}`} role="alert">
      {type === 'success' ? <CheckCircle2 size={18} aria-hidden className="form-toast-icon" /> : <AlertCircle size={18} aria-hidden className="form-toast-icon" />}
      <span className="form-toast-text">{message}</span>
      {onDismiss ? (
        <button type="button" className="form-toast-dismiss" onClick={onDismiss} aria-label="Cerrar aviso">
          <X size={16} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
