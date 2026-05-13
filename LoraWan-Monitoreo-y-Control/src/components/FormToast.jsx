import React, { useEffect } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import './FormToast.css';

/**
 * Aviso breve tipo toast (éxito / error) para formularios de alta.
 * @param {{ type: 'success'|'error', message: string, onDismiss?: () => void, durationMs?: number, large?: boolean }} props
 */
export default function FormToast({ type, message, onDismiss, durationMs = 5000, large = false }) {
  useEffect(() => {
    if (!message || durationMs <= 0) return undefined;
    const t = setTimeout(() => onDismiss?.(), durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  const iconSize = large ? 36 : 18;
  const cls = ['form-toast', `form-toast--${type}`, large ? 'form-toast--lg' : ''].filter(Boolean).join(' ');

  return (
    <div className={cls} role="alert">
      {type === 'success' ? (
        <CheckCircle2 size={iconSize} aria-hidden className="form-toast__icon" />
      ) : (
        <AlertCircle size={iconSize} aria-hidden className="form-toast__icon" />
      )}
      <span>{message}</span>
    </div>
  );
}
