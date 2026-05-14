import React, { useEffect } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import './FormToast.css';

/**
 * Aviso breve tipo toast (éxito / error / aviso) para formularios de alta.
 * @param {{ type: 'success'|'error'|'warning', message?: string, title?: string, onDismiss?: () => void, durationMs?: number, large?: boolean }} props
 */
export default function FormToast({ type, message, title, onDismiss, durationMs = 5000, large = false }) {
  const hasContent = Boolean((message && String(message).trim()) || (title && String(title).trim()));

  useEffect(() => {
    if (!hasContent || durationMs <= 0) return undefined;
    const t = setTimeout(() => onDismiss?.(), durationMs);
    return () => clearTimeout(t);
  }, [hasContent, durationMs, onDismiss]);

  if (!hasContent) return null;

  const iconSize = large ? 36 : 18;
  const cls = ['form-toast', `form-toast--${type}`, large ? 'form-toast--lg' : ''].filter(Boolean).join(' ');

  const icon =
    type === 'success' ? (
      <CheckCircle2 size={iconSize} aria-hidden className="form-toast__icon" />
    ) : type === 'warning' ? (
      <AlertTriangle size={iconSize} aria-hidden className="form-toast__icon" />
    ) : (
      <AlertCircle size={iconSize} aria-hidden className="form-toast__icon" />
    );

  const body = message && String(message).trim();

  return (
    <div className={cls} role={type === 'warning' ? 'status' : 'alert'}>
      {icon}
      {title ? (
        <div className="form-toast__text">
          <p className="form-toast__title">{title}</p>
          {body ? <p className="form-toast__detail">{body}</p> : null}
        </div>
      ) : (
        <span className="form-toast__single">{body}</span>
      )}
    </div>
  );
}
