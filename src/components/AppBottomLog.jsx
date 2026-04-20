import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Download, Pause, Play, Trash2 } from 'lucide-react';
import { APP_LOG_CATEGORY_LABELS, normalizeAppLogCategory } from '../constants/appLog';
import { useAppLog } from '../context/AppLogContext';
import './AppBottomLog.css';

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '—';
  }
}

function formatDetailJson(data) {
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export default function AppBottomLog() {
  const { logs, clear } = useAppLog();
  const [collapsed, setCollapsed] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [pauseScroll, setPauseScroll] = useState(false);
  const bodyRef = useRef(null);

  useLayoutEffect(() => {
    const reserve = collapsed ? '40px' : 'min(58vh, 560px)';
    document.documentElement.style.setProperty('--app-bottom-log-reserve', reserve);
    return () => {
      document.documentElement.style.removeProperty('--app-bottom-log-reserve');
    };
  }, [collapsed]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      const cat = normalizeAppLogCategory(l.category);
      if (categoryFilter !== 'all' && cat !== categoryFilter) return false;
      if (!q) return true;
      if (l.message.toLowerCase().includes(q)) return true;
      if (formatDetailJson(l.data).toLowerCase().includes(q)) return true;
      return false;
    });
  }, [logs, categoryFilter, search]);

  const lastFilteredLen = filtered.length;
  React.useEffect(() => {
    if (collapsed || pauseScroll || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [collapsed, pauseScroll, lastFilteredLen]);

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const exportLogs = () => {
    const payload = filtered.map((l) => ({
      ts: l.ts,
      time: new Date(l.ts).toISOString(),
      level: l.level,
      category: l.category,
      message: l.message,
      data: l.data,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `syscom-registro-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const categories = useMemo(() => ['all', ...Object.keys(APP_LOG_CATEGORY_LABELS)], []);

  return (
    <aside
      className={`app-bottom-log ${collapsed ? 'app-bottom-log--collapsed' : ''}`}
      aria-label="Registro de actividad de la aplicación"
    >
      <div className="app-bottom-log__bar">
        <h2 className="app-bottom-log__title">Registro</h2>
        <span className="app-bottom-log__count" title="Líneas totales en memoria (tras filtros se muestran menos)">
          {filtered.length}/{logs.length}
        </span>
        {!collapsed && (
          <>
            <label className="app-bottom-log__search">
              <span className="visually-hidden">Filtrar por texto</span>
              <input
                type="search"
                className="app-bottom-log__search-input"
                placeholder="Buscar en mensaje o JSON…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Buscar en el registro"
              />
            </label>
            <button
              type="button"
              className={`app-bottom-log__iconbtn ${pauseScroll ? 'app-bottom-log__iconbtn--active' : ''}`}
              onClick={() => setPauseScroll((p) => !p)}
              title={pauseScroll ? 'Reanudar scroll automático' : 'Pausar scroll automático'}
            >
              {pauseScroll ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button type="button" className="app-bottom-log__iconbtn" onClick={() => void exportLogs()} title="Exportar líneas filtradas (JSON)">
              <Download size={15} />
            </button>
          </>
        )}
        <button
          type="button"
          className="app-bottom-log__btn app-bottom-log__btn--danger"
          onClick={() => clear()}
          title="Vaciar registro"
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden />
          Vaciar
        </button>
        <button
          type="button"
          className="app-bottom-log__btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <>
              <ChevronUp size={14} strokeWidth={2} aria-hidden />
              Ampliar
            </>
          ) : (
            <>
              <ChevronDown size={14} strokeWidth={2} aria-hidden />
              Contraer
            </>
          )}
        </button>
      </div>
      {!collapsed && (
        <div className="app-bottom-log__filters" role="toolbar" aria-label="Filtros por categoría">
          {categories.map((key) => (
            <button
              key={key}
              type="button"
              className={`app-bottom-log__chip ${categoryFilter === key ? 'app-bottom-log__chip--on' : ''}`}
              onClick={() => setCategoryFilter(key)}
            >
              {key === 'all' ? 'Todas' : APP_LOG_CATEGORY_LABELS[key] || key}
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <div ref={bodyRef} className="app-bottom-log__body" role="log" aria-live="polite">
          {filtered.length === 0 ? (
            <div className="app-bottom-log__line app-bottom-log__msg--info">Sin entradas con los filtros actuales.</div>
          ) : (
            filtered.map((l) => {
              const cat = normalizeAppLogCategory(l.category);
              const hasData = l.data !== undefined && l.data !== null;
              const isOpen = expandedId === l.id;
              const json = hasData ? formatDetailJson(l.data) : '';
              const copyLine = `[${cat}] ${formatTime(l.ts)} ${l.message}${json ? `\n${json}` : ''}`;

              return (
                <div key={l.id} className={`app-bottom-log__entry app-bottom-log__entry--${l.level}`}>
                  <div className="app-bottom-log__rowline">
                    <button
                      type="button"
                      className="app-bottom-log__row"
                      onClick={() => {
                        if (!hasData) return;
                        setExpandedId((id) => (id === l.id ? null : l.id));
                      }}
                      disabled={!hasData}
                      title={hasData ? 'Clic para ver u ocultar detalle JSON' : undefined}
                    >
                      <span className={`app-bottom-log__badge app-bottom-log__badge--${cat}`}>{APP_LOG_CATEGORY_LABELS[cat] || cat}</span>
                      <span className="app-bottom-log__time">{formatTime(l.ts)}</span>
                      <span className={`app-bottom-log__msg app-bottom-log__msg--${l.level}`}>{l.message}</span>
                    </button>
                    <button
                      type="button"
                      className="app-bottom-log__iconbtn app-bottom-log__rowcopy"
                      onClick={() => void copyText(copyLine)}
                      title="Copiar línea"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                  {isOpen && hasData && <pre className="app-bottom-log__detail">{json}</pre>}
                </div>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}
