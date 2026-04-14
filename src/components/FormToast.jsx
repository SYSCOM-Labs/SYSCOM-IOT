import React, { useEffect } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import './FormToast.css';

/**
 * Aviso breve tipo toast (éxito / error) para formularios de alta.
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
      {type === 'success' ? <CheckCircle2 size={18} aria-hidden /> : <AlertCircle size={18} aria-hidden />}
      <span>{message}</span>
    </div>
  );
}
