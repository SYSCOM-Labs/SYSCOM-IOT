import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  LayoutGrid,
  History,
  Braces,
  RefreshCw,
  Loader,
  Radio,
  Cpu,
  ClipboardList,
  Clock,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { fetchDeviceHistory } from '../../services/api';
import { expandNestedGatewayTelemetry } from '../../utils/gatewayPayload';
import { formatTelemetryForSummaryRow } from '../../utils/telemetryDisplayFormat';
import { getTelemetryLabelHintsForDevice } from '../../services/deviceTemplates';
import './DeviceDataModal.css';

const INTERNAL_FIELDS = new Set([
  'deviceId',
  'name',
  'sn',
  'model',
  'connectStatus',
  'lastUpdateTime',
  'registered',
  'registeredOnly',
  'id',
  'userId',
  'updatedAt',
  'createdAt',
  'licenseExpired',
  'licenseGrace',
  'licenseValidUntil',
  'licenseType',
]);

const CONNECTIVITY_KEYS = new Set([
  'rssi',
  'snr',
  'lsnr',
  'freq',
  'datr',
  'datarate',
  'dr',
  'gateway_id',
  'gw',
  'devaddr',
  'fcnt',
  'fport',
  'spreadingfactor',
  'bandwidth',
]);

function formatScalar(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 120 ? `${s.slice(0, 117)}…` : s;
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function buildViewTelemetry(device, snapshot) {
  if (snapshot && snapshot.properties && typeof snapshot.properties === 'object') {
    return expandNestedGatewayTelemetry({ ...snapshot.properties });
  }
  if (!device) return {};
  const base = {};
  for (const [k, v] of Object.entries(device)) {
    if (!INTERNAL_FIELDS.has(k)) base[k] = v;
  }
  return expandNestedGatewayTelemetry(base);
}

function partitionCards(viewTelemetry) {
  const connectivity = {};
  const telemetry = {};
  for (const [k, v] of Object.entries(viewTelemetry)) {
    if (INTERNAL_FIELDS.has(k)) continue;
    const low = k.toLowerCase();
    if (CONNECTIVITY_KEYS.has(low)) connectivity[k] = v;
    else telemetry[k] = v;
  }
  return { connectivity, telemetry };
}

function SummaryCard({ glyph, title, children, accent }) {
  return (
    <div className={`device-data-premium-card device-data-premium-card--${accent}`}>
      <div className="device-data-premium-card__head">
        <span className="device-data-premium-card__icon" aria-hidden>
          {React.createElement(glyph, { size: 18, strokeWidth: 1.75 })}
        </span>
        <h4>{title}</h4>
      </div>
      <div className="device-data-premium-card__body">{children}</div>
    </div>
  );
}

function KeyValueRows(entries, model, hintMap) {
  if (!entries.length) {
    return <p className="device-data-premium-empty">Sin datos en esta sección.</p>;
  }
  const m = model != null ? String(model) : '';
  return (
    <dl className="device-data-premium-kv">
      {entries.map(([k, v]) => {
        const shown = formatTelemetryForSummaryRow(m, k, v, formatScalar, hintMap);
        return (
          <div key={k} className="device-data-premium-kv__row">
            <dt>{k}</dt>
            <dd title={typeof v === 'object' ? JSON.stringify(v) : String(v)}>{shown}</dd>
          </div>
        );
      })}
    </dl>
  );
}

const DeviceDataModal = ({ device, onClose }) => {
  const { credentials, token } = useAuth();
  const [tab, setTab] = useState('summary');
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState(null);
  const historyAutoFetchRef = useRef(false);

  const deviceId = device?.deviceId != null ? String(device.deviceId) : '';

  useEffect(() => {
    historyAutoFetchRef.current = false;
    setHistoryRows([]);
    setHistoryError(null);
    setSelectedSnapshot(null);
  }, [deviceId]);

  const viewTelemetry = useMemo(
    () => buildViewTelemetry(device, selectedSnapshot),
    [device, selectedSnapshot]
  );

  const { connectivity, telemetry } = useMemo(() => partitionCards(viewTelemetry), [viewTelemetry]);

  const telemetryHintMap = useMemo(
    () => (deviceId ? getTelemetryLabelHintsForDevice(deviceId) : null),
    [deviceId]
  );

  const telemetryEntries = useMemo(() => Object.entries(telemetry).sort(([a], [b]) => a.localeCompare(b)), [telemetry]);
  const connectivityEntries = useMemo(
    () => Object.entries(connectivity).sort(([a], [b]) => a.localeCompare(b)),
    [connectivity]
  );

  const managementEntries = useMemo(() => {
    if (!device) return [];
    const pairs = [
      ['deviceId', device.deviceId],
      ['name', device.name],
      ['model', device.model],
      ['sn', device.sn],
      ['connectStatus', device.connectStatus],
      ['lastUpdateTime', device.lastUpdateTime],
      ['licenseValidUntil', device.licenseValidUntil],
      ['licenseType', device.licenseType],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    return pairs;
  }, [device]);

  const loadHistory = useCallback(async () => {
    if (!deviceId || !token) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const resp = await fetchDeviceHistory(deviceId, { pageSize: 100 }, credentials, token);
      const list = resp.list || resp.data?.list || [];
      const normalized = (Array.isArray(list) ? list : []).map((row, fetchOrder) => ({
        /** Clave estable al reordenar por fecha (el API no devuelve `id` por fila). */
        histId: `${row.timestamp != null ? Number(row.timestamp) : row.ts != null ? Number(row.ts) : 0}-${fetchOrder}`,
        timestamp: row.timestamp != null ? Number(row.timestamp) : row.ts != null ? Number(row.ts) : 0,
        properties: row.properties && typeof row.properties === 'object' ? row.properties : {},
      }));
      normalized.sort((a, b) => b.timestamp - a.timestamp);
      setHistoryRows(normalized);
      setSelectedSnapshot((prev) => {
        if (!prev?.timestamp) return prev;
        const prevJson = JSON.stringify(prev.properties || {});
        const found = normalized.find(
          (r) => r.timestamp === prev.timestamp && JSON.stringify(r.properties || {}) === prevJson
        );
        if (!found) return null;
        return { histId: found.histId, timestamp: found.timestamp, properties: found.properties };
      });
    } catch (e) {
      setHistoryError(e?.response?.data?.errMsg || e?.message || 'No se pudo cargar el historial');
      setHistoryRows([]);
      setSelectedSnapshot(null);
    } finally {
      setHistoryLoading(false);
    }
  }, [deviceId, token, credentials]);

  useEffect(() => {
    if (tab !== 'history') {
      historyAutoFetchRef.current = false;
      return;
    }
    if (historyAutoFetchRef.current) return;
    historyAutoFetchRef.current = true;
    loadHistory();
  }, [tab, loadHistory]);

  const jsonRaw = useMemo(() => {
    const ts =
      selectedSnapshot?.timestamp != null
        ? selectedSnapshot.timestamp
        : device?.lastUpdateTime != null
          ? device.lastUpdateTime
          : null;
    return JSON.stringify(
      {
        deviceId: device?.deviceId,
        name: device?.name,
        viewedAt: ts,
        properties: viewTelemetry,
      },
      null,
      2
    );
  }, [device, selectedSnapshot, viewTelemetry]);

  if (!device) return null;

  return (
    <div className="modal-overlay device-data-premium-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-content device-data-premium-shell"
        role="dialog"
        aria-labelledby="device-data-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="device-data-premium-header">
          <div className="device-data-premium-title">
            <span className="device-data-premium-title__glow" aria-hidden />
            <LayoutGrid size={22} strokeWidth={1.75} />
            <div>
              <h2 id="device-data-modal-title">Dispositivo</h2>
              <p className="device-data-premium-sub">
                {device.name || device.deviceId}
                {device.deviceId ? (
                  <>
                    {' '}
                    · <span className="device-data-premium-mono">{device.deviceId}</span>
                  </>
                ) : null}
              </p>
            </div>
          </div>
          <button type="button" className="device-data-premium-close" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </header>

        {selectedSnapshot && (
          <div className="device-data-premium-snapshot-bar">
            <Clock size={16} />
            <span>
              Vista histórica:{' '}
              <strong>
                {new Date(selectedSnapshot.timestamp).toLocaleString('es-MX', {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                })}
              </strong>
            </span>
            <div className="device-data-premium-snapshot-actions">
              <button type="button" className="device-data-premium-snapshot-link" onClick={() => setTab('summary')}>
                Resumen
              </button>
              <button type="button" className="device-data-premium-snapshot-link" onClick={() => setTab('json')}>
                JSON raw
              </button>
            </div>
            <button type="button" className="device-data-premium-snapshot-clear" onClick={() => setSelectedSnapshot(null)}>
              Volver a tiempo real
            </button>
          </div>
        )}

        <nav className="device-data-premium-tabs" role="tablist" aria-label="Secciones del dispositivo">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'summary'}
            className={`device-data-premium-tab ${tab === 'summary' ? 'is-active' : ''}`}
            onClick={() => setTab('summary')}
          >
            <LayoutGrid size={16} />
            Resumen
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'history'}
            className={`device-data-premium-tab ${tab === 'history' ? 'is-active' : ''}`}
            onClick={() => setTab('history')}
          >
            <History size={16} />
            Historial
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'json'}
            className={`device-data-premium-tab ${tab === 'json' ? 'is-active' : ''}`}
            onClick={() => setTab('json')}
          >
            <Braces size={16} />
            JSON raw
          </button>
        </nav>

        <div className="device-data-premium-body">
          {tab === 'summary' && (
            <div className="device-data-premium-grid">
              <SummaryCard glyph={Cpu} title="Telemetría" accent="violet">
                {KeyValueRows(telemetryEntries, device?.model, telemetryHintMap)}
              </SummaryCard>
              <SummaryCard glyph={Radio} title="Conectividad" accent="cyan">
                {KeyValueRows(connectivityEntries, device?.model, telemetryHintMap)}
              </SummaryCard>
              <SummaryCard glyph={ClipboardList} title="Gestión" accent="amber">
                {KeyValueRows(managementEntries, device?.model, telemetryHintMap)}
              </SummaryCard>
            </div>
          )}

          {tab === 'history' && (
            <div className="device-data-premium-history">
              <div className="device-data-premium-toolbar">
                <span className="device-data-premium-muted">
                  {historyLoading ? 'Cargando…' : `${historyRows.length} registro(s)`}
                </span>
                <button type="button" className="device-data-premium-btn" onClick={loadHistory} disabled={historyLoading}>
                  {historyLoading ? <Loader size={16} className="spin" /> : <RefreshCw size={16} />}
                  Actualizar
                </button>
              </div>
              {historyError && <div className="device-data-premium-alert">{historyError}</div>}
              {historyLoading && historyRows.length === 0 ? (
                <div className="device-data-premium-muted device-data-premium-center">
                  <Loader size={22} className="spin" /> Cargando historial…
                </div>
              ) : historyRows.length === 0 ? (
                <p className="device-data-premium-muted">No hay historial almacenado para este dispositivo.</p>
              ) : (
                <ul className="device-data-premium-history-list">
                  {historyRows.map((row, idx) => {
                    const active = selectedSnapshot && selectedSnapshot.histId === row.histId;
                    const label = new Date(row.timestamp).toLocaleString('es-MX', {
                      dateStyle: 'medium',
                      timeStyle: 'medium',
                    });
                    return (
                      <li key={row.histId || `${row.timestamp}-${idx}`}>
                        <button
                          type="button"
                          className={`device-data-premium-history-item ${active ? 'is-active' : ''}`}
                          onClick={() => {
                            setSelectedSnapshot({
                              histId: row.histId,
                              timestamp: row.timestamp,
                              properties: row.properties,
                            });
                            setTab('summary');
                          }}
                        >
                          <span className="device-data-premium-history-time">{label}</span>
                          <span className="device-data-premium-history-hint">
                            Clic para abrir el Resumen de este envío · {Object.keys(row.properties || {}).length} campo(s)
                            {' · '}
                            <span className="device-data-premium-history-hint-strong">JSON raw</span> en la barra superior
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {tab === 'json' && (
            <pre className="device-data-premium-json" tabIndex={0}>
              {jsonRaw}
            </pre>
          )}
        </div>

        <footer className="device-data-premium-footer">
          <button type="button" className="device-data-premium-btn device-data-premium-btn--ghost" onClick={onClose}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  );
};

export default DeviceDataModal;
