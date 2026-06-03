import contract from '../../shared/realtime-sse-contract.json';

/**
 * Nombres de `CustomEvent` en `window` tras SSE (`SyscomRealtimeBridge`).
 * Tipos SSE del servidor: `contract.sseTelemetry` / `contract.sseLns` en `shared/realtime-sse-contract.json`.
 */
export const SYSCOM_REALTIME_TELEMETRY = contract.windowTelemetryCustom;
export const SYSCOM_REALTIME_LNS = contract.windowLnsCustom;
/** SSE reconectado (p. ej. tras login): refrescar listados desde la BD del servidor. */
export const SYSCOM_SSE_CONNECTED = 'syscom-sse-connected';
