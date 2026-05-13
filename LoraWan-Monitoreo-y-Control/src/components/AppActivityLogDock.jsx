import React, { useEffect, useId, useRef } from 'react';
import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { useAppActivityLog } from '../context/AppActivityLogContext';
import './AppActivityLogPanel.css';

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

function detailToString(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Panel del registro de actividad (telemetría, LNS, navegación, errores).
 * @param {{ embedded?: boolean, panelTitle?: string, onRequestClose?: () => void, hidePanelLabel?: string }} props
 */
export default function AppActivityLogDock({
  embedded = false,
  panelTitle = 'Actividad',
  onRequestClose,
  hidePanelLabel = 'Ocultar',
}) {
  const { lines, clear, autoScroll, setAutoScroll, expanded, setExpanded } = useAppActivityLog();
  const bodyRef = useRef(null);
  const autoscrollId = useId();

  useEffect(() => {
    if (embedded) setExpanded(true);
  }, [embedded, setExpanded]);

  useEffect(() => {
    if (!expanded || !autoScroll || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, expanded, autoScroll]);

  const toggleExpand = () => setExpanded((e) => !e);
  const last = lines[lines.length - 1];

  return (
    <section
      className={`app-activity-log glass ${embedded ? 'app-activity-log--embedded' : ''} ${expanded ? 'app-activity-log--expanded' : 'app-activity-log--collapsed'}`}
      aria-label={panelTitle}
    >
      <div
        className="app-activity-log__bar"
        onClick={toggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpand();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <span className="app-activity-log__title">{panelTitle}</span>
        {!expanded && last && (
          <span className="app-activity-log__preview" title={last.message}>
            [{last.tag}] {last.message}
          </span>
        )}
        <div className="app-activity-log__actions" onClick={(e) => e.stopPropagation()}>
          <label
            htmlFor={autoscrollId}
            style={{
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              margin: 0,
            }}
          >
            <input
              id={autoscrollId}
              name={autoscrollId}
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Auto-scroll</span>
          </label>
          <button type="button" title="Vaciar registro" onClick={clear}>
            <Trash2 size={14} aria-hidden />
          </button>
          {embedded && typeof onRequestClose === 'function' && (
            <button type="button" className="app-activity-log__close-embedded" title={hidePanelLabel} onClick={onRequestClose}>
              <X size={16} aria-hidden />
            </button>
          )}
          <button type="button" title={expanded ? 'Contraer' : 'Expandir'} onClick={toggleExpand}>
            {expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="app-activity-log__body" ref={bodyRef}>
          {lines.map((line, i) => (
            <React.Fragment key={`${line.ts}-${i}`}>
              <div className={`app-activity-log__line app-activity-log__line--${line.level || 'info'}`}>
                <span className="app-activity-log__time">{formatTime(line.ts)}</span>
                <span className="app-activity-log__tag">{line.tag}</span>
                <span className="app-activity-log__msg">{line.message}</span>
              </div>
              {line.detail != null && String(detailToString(line.detail)).length > 0 && (
                <div className="app-activity-log__detail">{detailToString(line.detail)}</div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
}
