import { DASH_WIDGET, MULTI_INSTANCE_DASH_WIDGETS, dashboardWidgetBaseId } from './widgetConfigUtils';

const KNOWN_DASH_WIDGET_IDS = new Set(Object.values(DASH_WIDGET));

/** @typedef {{ i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }} BsdGridItem */

function isKnownDashboardGridId(idStr) {
  const id = String(idStr);
  if (KNOWN_DASH_WIDGET_IDS.has(id)) return true;
  const base = dashboardWidgetBaseId(id);
  if (!KNOWN_DASH_WIDGET_IDS.has(base)) return false;
  return MULTI_INSTANCE_DASH_WIDGETS.has(base) && id.startsWith(`${base}__`);
}

/**
 * @param {string} key
 * @returns {BsdGridItem[]}
 */
export function readStoredBsdGridLayout(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

/**
 * @param {Record<string, unknown>} visibilityMap
 * @param {string} id
 */
function vis(visibilityMap, id) {
  return visibilityMap[id] !== false;
}

/**
 * @param {'panel' | 'device'} variant
 * @param {number} panelDevicesLen
 * @param {Record<string, unknown>} visibilityMap
 * @returns {BsdGridItem[]}
 */
export function buildDefaultBsdGridLayout(variant, panelDevicesLen, visibilityMap) {
  /** Vista dispositivo: tablero vacío hasta que el usuario agregue widgets desde «Editar». */
  if (variant === 'device') {
    return [];
  }
  const out = /** @type {BsdGridItem[]} */ ([]);
  let y = 0;
  const V = (id) => vis(visibilityMap, id);

  if (variant === 'panel' && panelDevicesLen > 0 && V(DASH_WIDGET.PANEL_DEVICE_BAR)) {
    out.push({
      i: DASH_WIDGET.PANEL_DEVICE_BAR,
      x: 0,
      y,
      w: 12,
      h: 5,
      minW: 4,
      minH: 3,
    });
    y += 5;
  }

  if (V(DASH_WIDGET.SWITCH)) {
    out.push({ i: DASH_WIDGET.SWITCH, x: 0, y, w: 3, h: 8, minW: 3, minH: 5 });
    y += 8;
  }

  const dioIds = [DASH_WIDGET.DOWNLINK, DASH_WIDGET.IMAGE, DASH_WIDGET.MAP, DASH_WIDGET.TRACKING_MAP].filter((id) =>
    V(id)
  );
  if (dioIds.length) {
    const n = dioIds.length;
    const w = n >= 4 ? 3 : n === 3 ? 4 : n === 2 ? 6 : 3;
    let x = 0;
    for (const id of dioIds) {
      out.push({ i: id, x, y, w, h: 10, minW: 2, minH: 4 });
      x += w;
    }
    y += 10;
  }

  const kpiIds = [
    DASH_WIDGET.SATISFACTION,
    DASH_WIDGET.CONTAINER,
    DASH_WIDGET.BATTERY_LEVEL,
    DASH_WIDGET.METRIC_CIRCULAR,
    DASH_WIDGET.TEXT,
  ].filter((id) => V(id));
  /** Altura moderada tipo tarjeta compacta (coherente con vista dispositivo 3+3+6 cols). */
  const kpiRowH = 9;
  let kpiRowStartY = y;
  let kpiRowTailX = 0;
  if (kpiIds.length) {
    const n = kpiIds.length;
    /** Hasta 2 KPI a 3 cols dejan hueco (6/12) para gráfico de barras en la misma fila. */
    const w = n >= 3 ? 4 : 3;
    let x = 0;
    kpiRowStartY = y;
    for (const id of kpiIds) {
      out.push({ i: id, x, y: kpiRowStartY, w, h: kpiRowH, minW: 2, minH: 5 });
      x += w;
    }
    kpiRowTailX = x;
    y += kpiRowH;
  }

  const chartModerate = { w: 6, h: 9, minW: 4, minH: 6 };
  if (V(DASH_WIDGET.BAR_CHART)) {
    const fitsBesideKpi = kpiIds.length > 0 && kpiRowTailX + chartModerate.w <= 12;
    if (fitsBesideKpi) {
      out.push({
        i: DASH_WIDGET.BAR_CHART,
        x: kpiRowTailX,
        y: kpiRowStartY,
        ...chartModerate,
      });
    } else {
      out.push({
        i: DASH_WIDGET.BAR_CHART,
        x: 0,
        y,
        w: kpiIds.length ? 8 : chartModerate.w,
        h: kpiIds.length ? 10 : chartModerate.h,
        minW: 4,
        minH: 6,
      });
      y += kpiIds.length ? 10 : chartModerate.h;
    }
  }

  if (V(DASH_WIDGET.SENSOR_GRID)) {
    out.push({
      i: DASH_WIDGET.SENSOR_GRID,
      x: 0,
      y,
      w: 12,
      h: 11,
      minW: 4,
      minH: 6,
    });
    y += 11;
  }

  if (V(DASH_WIDGET.STREAM)) {
    out.push({ i: DASH_WIDGET.STREAM, x: 0, y, w: chartModerate.w, h: chartModerate.h, minW: 4, minH: 6 });
    y += chartModerate.h;
  }

  return out;
}

/**
 * Tamaño moderado al añadir un widget (galería / primera celda), alineado con tarjetas compactas en rejilla 12 cols.
 * @param {string} gridId id de celda (`dw_text` o `dw_text__…`)
 * @returns {BsdGridItem}
 */
export function buildModerateBsdGridTemplateForWidget(gridId) {
  const id = String(gridId);
  const base = dashboardWidgetBaseId(id);
  /** Plantilla base (x/y la rellena `placeNewBsdGridItem` al agregar desde la galería). */
  const slot = (dims) => ({ i: id, x: 0, y: 0, ...dims });
  switch (base) {
    case DASH_WIDGET.BAR_CHART:
      return slot({ w: 6, h: 9, minW: 4, minH: 6 });
    case DASH_WIDGET.SENSOR_GRID:
      return slot({ w: 12, h: 11, minW: 4, minH: 6 });
    case DASH_WIDGET.STREAM:
      return slot({ w: 6, h: 9, minW: 4, minH: 6 });
    case DASH_WIDGET.SWITCH:
      return slot({ w: 3, h: 9, minW: 3, minH: 5 });
    case DASH_WIDGET.PANEL_DEVICE_BAR:
      return slot({ w: 12, h: 5, minW: 4, minH: 3 });
    case DASH_WIDGET.MAP:
    case DASH_WIDGET.TRACKING_MAP:
    case DASH_WIDGET.IMAGE:
      return slot({ w: 4, h: 9, minW: 3, minH: 5 });
    case DASH_WIDGET.SATISFACTION:
    case DASH_WIDGET.CONTAINER:
    case DASH_WIDGET.BATTERY_LEVEL:
    case DASH_WIDGET.METRIC_CIRCULAR:
    case DASH_WIDGET.TEXT:
      return slot({ w: 3, h: 9, minW: 2, minH: 5 });
    default:
      return slot({ w: 3, h: 9, minW: 3, minH: 5 });
  }
}

/**
 * Evita celdas aplastadas (p. ej. react-grid-layout entrega h=1 al insertar): fuerza al menos el tamaño
 * moderado de plantilla por tipo de widget. No reduce tamaños mayores que el usuario haya definido.
 *
 * @param {BsdGridItem[] | null | undefined} layout
 * @returns {BsdGridItem[]}
 */
export function clampLayoutItemsToModerateMins(layout) {
  if (!Array.isArray(layout) || layout.length === 0) return [];
  return layout.map((it) => {
    if (!it || it.i == null) return it;
    const id = String(it.i);
    if (!isKnownDashboardGridId(id)) return it;
    const tmpl = buildModerateBsdGridTemplateForWidget(id);
    const tw = Math.min(12, Math.max(1, Math.round(Number(tmpl.w)) || 3));
    const th = Math.max(1, Math.round(Number(tmpl.h)) || 9);
    const minW =
      tmpl.minW != null && Number.isFinite(Number(tmpl.minW)) ? Math.round(Number(tmpl.minW)) : 2;
    const minH =
      tmpl.minH != null && Number.isFinite(Number(tmpl.minH)) ? Math.round(Number(tmpl.minH)) : 4;
    const curW = Math.round(Number(it.w));
    const curH = Math.round(Number(it.h));
    const w = Math.min(12, Math.max(minW, Number.isFinite(curW) && curW > 0 ? curW : tw));
    const h = Math.max(minH, Number.isFinite(curH) && curH > 0 ? curH : th);
    const out = {
      ...it,
      i: id,
      x: Math.max(0, Math.round(Number(it.x)) || 0),
      y: Math.max(0, Math.round(Number(it.y)) || 0),
      w,
      h,
    };
    if (tmpl.minW != null) out.minW = tmpl.minW;
    if (tmpl.minH != null) out.minH = tmpl.minH;
    return out;
  });
}

/**
 * Inserta una celda nueva sin solaparse con las existentes.
 * Orden de búsqueda: **por filas**, en cada fila de **izquierda a derecha**; la primera fila es la superior (y=0),
 * luego y=1, etc., de modo que se ocupa el ancho disponible antes de pasar a la fila inferior (lectura occidental).
 *
 * @param {BsdGridItem[] | null | undefined} layout
 * @param {BsdGridItem} slotTemplate debe incluir `i`, `w`, `h`, y opcionalmente `minW`/`minH`
 * @returns {BsdGridItem}
 */
export function placeNewBsdGridItem(layout, slotTemplate) {
  const items = normalizeLayoutForPersistence(layout || []);
  const w = Math.min(12, Math.max(1, Math.round(Number(slotTemplate.w)) || 1));
  const h = Math.max(1, Math.round(Number(slotTemplate.h)) || 1);
  const minW =
    slotTemplate.minW != null && Number.isFinite(Number(slotTemplate.minW))
      ? Math.round(Number(slotTemplate.minW))
      : undefined;
  const minH =
    slotTemplate.minH != null && Number.isFinite(Number(slotTemplate.minH))
      ? Math.round(Number(slotTemplate.minH))
      : undefined;
  const base = {
    i: String(slotTemplate.i),
    w,
    h,
    ...(minW != null ? { minW } : {}),
    ...(minH != null ? { minH } : {}),
  };
  if (!items.length) return { ...base, x: 0, y: 0 };

  const overlaps = (ax, ay, aw, ah) =>
    items.some((it) =>
      bsdGridRectsOverlap(
        { x: ax, y: ay, w: aw, h: ah },
        {
          x: Math.round(Number(it.x)) || 0,
          y: Math.round(Number(it.y)) || 0,
          w: Math.round(Number(it.w)) || 1,
          h: Math.round(Number(it.h)) || 1,
        }
      )
    );

  for (let yy = 0; yy < 480; yy += 1) {
    for (let xx = 0; xx <= 12 - w; xx += 1) {
      if (!overlaps(xx, yy, w, h)) return { ...base, x: xx, y: yy };
    }
  }
  const maxBottom = Math.max(0, ...items.map((it) => (Math.round(Number(it.y)) || 0) + (Math.round(Number(it.h)) || 0)));
  return { ...base, x: 0, y: maxBottom };
}

/**
 * Cierra huecos verticales y reubica celdas en orden de lectura (arriba→abajo, izquierda→derecha),
 * usando la misma colocación que `placeNewBsdGridItem` para cada pieza.
 *
 * @param {BsdGridItem[] | null | undefined} layout
 * @returns {BsdGridItem[]}
 */
export function compactBsdGridLayoutTopLeft(layout) {
  const items = normalizeLayoutForPersistence(layout || []);
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => {
    const dy = (Number(a.y) || 0) - (Number(b.y) || 0);
    if (dy !== 0) return dy;
    const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
    if (dx !== 0) return dx;
    return String(a.i).localeCompare(String(b.i));
  });
  const placed = [];
  for (const it of sorted) {
    const w = Math.round(Number(it.w)) || 1;
    const h = Math.round(Number(it.h)) || 1;
    const slot = placeNewBsdGridItem(placed, {
      i: String(it.i),
      w,
      h,
      ...(it.minW != null && Number.isFinite(Number(it.minW)) ? { minW: Math.round(Number(it.minW)) } : {}),
      ...(it.minH != null && Number.isFinite(Number(it.minH)) ? { minH: Math.round(Number(it.minH)) } : {}),
    });
    placed.push({
      ...it,
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: slot.h,
    });
  }
  return normalizeLayoutForPersistence(placed);
}

/**
 * Número finito guardado o, si no aplica, el valor por defecto.
 * No usar `||`: `0` es válido en x/y (columna 0, fila 0) y no debe caer al default.
 */
function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {BsdGridItem[]} stored
 * @param {BsdGridItem[]} defaults
 * @returns {BsdGridItem[]}
 */
function mergeOneStoredIntoTemplate(s, template) {
  const minW = template.minW ?? 1;
  const minH = template.minH ?? 1;
  const w = Math.min(12, Math.max(minW, finiteOr(s.w, template.w)));
  const x = Math.max(0, Math.min(finiteOr(s.x, template.x), 12 - w));
  const y = Math.max(0, finiteOr(s.y, template.y));
  const h = Math.max(minH, finiteOr(s.h, template.h));
  return {
    ...template,
    i: String(s.i),
    x,
    y,
    w,
    h,
  };
}

export function mergeStoredBsdGridLayout(stored, defaults) {
  if (!defaults || defaults.length === 0) {
    return normalizeLayoutForPersistence(Array.isArray(stored) ? stored : []);
  }
  const smap = new Map((stored || []).map((it) => [String(it.i), it]));
  const defaultById = new Map(defaults.map((d) => [String(d.i), d]));
  const mergedCore = defaults.map((d) => {
    const s = smap.get(String(d.i));
    if (!s) return { ...d };
    return mergeOneStoredIntoTemplate(s, d);
  });
  /** @type {BsdGridItem[]} */
  const extras = [];
  for (const [id, it] of smap) {
    if (defaultById.has(id)) continue;
    const base = dashboardWidgetBaseId(id);
    if (!MULTI_INSTANCE_DASH_WIDGETS.has(base)) continue;
    const tmpl = defaultById.get(base);
    if (!tmpl || id === base) continue;
    if (!String(id).startsWith(`${base}__`)) continue;
    extras.push(mergeOneStoredIntoTemplate(it, { ...tmpl, i: id }));
  }
  extras.sort((a, b) => String(a.i).localeCompare(String(b.i)));
  return [...mergedCore, ...extras];
}

/**
 * @param {'panel' | 'device'} variant
 * @param {string | number | null | undefined} deviceId
 * @param {string | null | undefined} [panelInstanceId] solo variant `panel` (defecto `main`)
 * @returns {string}
 */
/**
 * @param {string | null | undefined} [panelOwnerSegment] segmento de cuenta (Panel Control)
 */
export function dashboardGridLayoutStorageKey(variant, deviceId, panelInstanceId, panelOwnerSegment) {
  if (variant === 'device' && deviceId != null && String(deviceId).length)
    return `bsd_dash_grid_v1_device_${String(deviceId)}`;
  if (variant === 'panel') {
    const pid = panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
    const seg =
      panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
    if (seg) return `bsd_dash_grid_v1_panel_o_${seg}_${pid}`;
    return `bsd_dash_grid_v1_panel_${pid}`;
  }
  return `bsd_dash_grid_v1_default`;
}

/**
 * Elimina entradas de layout que ya no corresponden a widgets visibles (evita solapes por ids huérfanos).
 *
 * @param {BsdGridItem[] | null | undefined} layout
 * @param {BsdGridItem[]} defaultItems salida de `buildDefaultBsdGridLayout` (ids permitidos)
 * @returns {BsdGridItem[]}
 */
export function filterLayoutToAllowedDashboardItems(layout, defaultItems) {
  const defaultIds = new Set((defaultItems || []).map((d) => String(d.i)));
  if (!Array.isArray(layout)) return [];
  if (defaultIds.size === 0) {
    return normalizeLayoutForPersistence(layout.filter((it) => it && it.i != null && isKnownDashboardGridId(String(it.i))));
  }
  return normalizeLayoutForPersistence(
    layout.filter((it) => {
      if (!it) return false;
      const id = String(it.i);
      if (defaultIds.has(id)) return true;
      const base = dashboardWidgetBaseId(id);
      if (!defaultIds.has(base)) return false;
      if (!MULTI_INSTANCE_DASH_WIDGETS.has(base)) return false;
      return id === base || id.startsWith(`${base}__`);
    })
  );
}

/**
 * Layout limpio para estado / localStorage (sin flags efímeros de RGL). Orden estable por `i`.
 * `i` se fuerza a string (RGL a veces entrega número y antes se filtraba todo → grid vacío / crash).
 *
 * @param {BsdGridItem[] | null | undefined} layout
 * @returns {BsdGridItem[]}
 */
export function normalizeLayoutForPersistence(layout) {
  if (!Array.isArray(layout)) return [];
  return layout
    .filter((it) => it && it.i != null && String(it.i).length)
    .map((it) => {
      const base = {
        i: String(it.i),
        x: Math.round(Number(it.x)) || 0,
        y: Math.round(Number(it.y)) || 0,
        w: Math.round(Number(it.w)) || 1,
        h: Math.round(Number(it.h)) || 1,
      };
      const minW = it.minW != null && Number.isFinite(Number(it.minW)) ? Math.round(Number(it.minW)) : null;
      const minH = it.minH != null && Number.isFinite(Number(it.minH)) ? Math.round(Number(it.minH)) : null;
      if (minW != null) base.minW = minW;
      if (minH != null) base.minH = minH;
      return base;
    })
    .sort((a, b) => a.i.localeCompare(b.i));
}

/**
 * Firma estable para comparar sin bucles react-grid-layout ↔ setState.
 *
 * @param {BsdGridItem[] | null | undefined} layout
 */
export function normalizeLayoutSignature(layout) {
  return JSON.stringify(normalizeLayoutForPersistence(layout));
}

/**
 * @param {BsdGridItem[] | null | undefined} a
 * @param {BsdGridItem[] | null | undefined} b
 */
export function layoutsEqualStable(a, b) {
  return normalizeLayoutSignature(a) === normalizeLayoutSignature(b);
}

/**
 * @param {{ x: number; y: number; w: number; h: number }} a
 * @param {{ x: number; y: number; w: number; h: number }} b
 */
export function bsdGridRectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/**
 * Un solo paso ortogonal en la rejilla hacia la posición deseada (±1 en el eje dominante).
 * @returns {{ dx: number; dy: number }}
 */
function bsdDragDominantUnitStep(ox, oy, nx, ny) {
  const dx = nx - ox;
  const dy = ny - oy;
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 };
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx > 0) return { dx: 1, dy: 0 };
    if (dx < 0) return { dx: -1, dy: 0 };
    if (dy > 0) return { dx: 0, dy: 1 };
    if (dy < 0) return { dx: 0, dy: -1 };
    return { dx: 0, dy: 0 };
  }
  if (dy > 0) return { dx: 0, dy: 1 };
  if (dy < 0) return { dx: 0, dy: -1 };
  if (dx > 0) return { dx: 1, dy: 0 };
  if (dx < 0) return { dx: -1, dy: 0 };
  return { dx: 0, dy: 0 };
}

function bsdVerticalRangeOverlap(a, b) {
  return !(a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function bsdHorizontalRangeOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x);
}

/**
 * Vecino que comparte borde con `rect` en la dirección indicada (misma regla de “un hueco”).
 * @param {'R'|'L'|'D'|'U'} dir
 */
function bsdFindTouchingNeighbor(items, excludeId, rect, dir) {
  const ex = Math.round(Number(rect.x)) || 0;
  const ey = Math.round(Number(rect.y)) || 0;
  const ew = Math.round(Number(rect.w)) || 1;
  const eh = Math.round(Number(rect.h)) || 1;
  /** @type {BsdGridItem[]} */
  const hits = [];
  for (const o of items) {
    if (!o || o.i === excludeId) continue;
    const ox = Math.round(Number(o.x)) || 0;
    const oy = Math.round(Number(o.y)) || 0;
    const ow = Math.round(Number(o.w)) || 1;
    const oh = Math.round(Number(o.h)) || 1;
    if (dir === 'R' && ox === ex + ew && bsdVerticalRangeOverlap({ x: ex, y: ey, w: ew, h: eh }, o)) hits.push(o);
    if (dir === 'L' && ox + ow === ex && bsdVerticalRangeOverlap({ x: ex, y: ey, w: ew, h: eh }, o)) hits.push(o);
    if (dir === 'D' && oy === ey + eh && bsdHorizontalRangeOverlap({ x: ex, y: ey, w: ew, h: eh }, o)) hits.push(o);
    if (dir === 'U' && oy + oh === ey && bsdHorizontalRangeOverlap({ x: ex, y: ey, w: ew, h: eh }, o)) hits.push(o);
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  /** Varios apilados en el mismo borde: el más cercano al centro vertical (o horizontal) del arrastrado */
  const my = ey + eh / 2;
  const mx = ex + ew / 2;
  hits.sort((a, b) => {
    const acy = (Math.round(Number(a.y)) || 0) + (Math.round(Number(a.h)) || 1) / 2;
    const bcy = (Math.round(Number(b.y)) || 0) + (Math.round(Number(b.h)) || 1) / 2;
    const acx = (Math.round(Number(a.x)) || 0) + (Math.round(Number(a.w)) || 1) / 2;
    const bcx = (Math.round(Number(b.x)) || 0) + (Math.round(Number(b.w)) || 1) / 2;
    if (dir === 'R' || dir === 'L') {
      return Math.abs(acy - my) - Math.abs(bcy - my);
    }
    return Math.abs(acx - mx) - Math.abs(bcx - mx);
  });
  return hits[0];
}

function bsdApplySnapPositions(items, snap) {
  if (!Array.isArray(snap) || !snap.length) return;
  const m = new Map(snap.map((s) => [String(s.i), s]));
  for (const it of items) {
    const s = m.get(String(it.i));
    if (!s) continue;
    it.x = Math.round(Number(s.x)) || 0;
    it.y = Math.round(Number(s.y)) || 0;
    it.w = Math.round(Number(s.w)) || 1;
    it.h = Math.round(Number(s.h)) || 1;
  }
}

function bsdClampGridItem(it, cols) {
  const w = Math.max(1, Math.round(Number(it.w)) || 1);
  const h = Math.max(1, Math.round(Number(it.h)) || 1);
  it.w = w;
  it.h = h;
  it.x = Math.max(0, Math.min(Math.round(Number(it.x)) || 0, cols - w));
  it.y = Math.max(0, Math.round(Number(it.y)) || 0);
}

function bsdAnyPairOverlaps(list) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (bsdGridRectsOverlap(list[i], list[j])) return true;
    }
  }
  return false;
}

/** @param {BsdGridItem[] | null | undefined} layout */
export function bsdDashboardLayoutHasOverlap(layout) {
  const list = normalizeLayoutForPersistence(layout || []);
  if (list.length < 2) return false;
  return bsdAnyPairOverlaps(list);
}

/**
 * Si el tile `itemId` se solapa con otro (p. ej. tras `clampLayoutItemsToModerateMins`), lo mueve a la primera
 * celda libre con la misma lógica que la galería (`placeNewBsdGridItem`).
 *
 * @param {BsdGridItem[] | null | undefined} layout
 * @param {string} itemId
 * @returns {BsdGridItem[]}
 */
export function relocateBsdGridItemIfOverlapping(layout, itemId) {
  const id = String(itemId);
  let items = normalizeLayoutForPersistence(clampLayoutItemsToModerateMins(layout || []));
  const toRect = (it) => ({
    x: Math.round(Number(it.x)) || 0,
    y: Math.round(Number(it.y)) || 0,
    w: Math.round(Number(it.w)) || 1,
    h: Math.round(Number(it.h)) || 1,
  });
  for (let pass = 0; pass < 3; pass += 1) {
    const self = items.find((it) => String(it.i) === id);
    if (!self) return items;
    const rest = items.filter((it) => String(it.i) !== id);
    const rs = toRect(self);
    const overlaps = rest.some((o) => bsdGridRectsOverlap(rs, toRect(o)));
    if (!overlaps) return items;
    const moved = placeNewBsdGridItem(rest, {
      i: id,
      w: rs.w,
      h: rs.h,
      ...(self.minW != null && Number.isFinite(Number(self.minW)) ? { minW: Math.round(Number(self.minW)) } : {}),
      ...(self.minH != null && Number.isFinite(Number(self.minH)) ? { minH: Math.round(Number(self.minH)) } : {}),
    });
    items = normalizeLayoutForPersistence(
      clampLayoutItemsToModerateMins([...rest, { ...self, x: moved.x, y: moved.y, w: moved.w, h: moved.h }])
    );
  }
  return items;
}

/**
 * Arrastre en **un solo paso** de rejilla (±1 en el eje dominante del gesto):
 * - Si hay un vecino que comparte borde en esa dirección y el mismo tamaño → **intercambian** posiciones.
 * - Si no hay vecino y la casilla destino está libre → el widget se **desplaza** un paso.
 * - En cualquier otro caso → se **revierte** al layout del inicio del arrastre (`snap`).
 *
 * La colocación al **añadir** widgets sigue en `placeNewBsdGridItem` (fila superior, izquierda a derecha,
 * siguiente fila debajo si no cabe).
 *
 * @param {BsdGridItem[] | null | undefined} snap layout al `onDragStart` (obligatorio para revertir bien)
 * @param {{ i?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null} oldItem
 * @param {{ i?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null} newItem
 * @param {BsdGridItem[] | null | undefined} layoutFromRgl layout que entrega RGL al soltar
 * @param {number} [cols]
 * @returns {BsdGridItem[] | null} layout normalizado, o null si no hubo cambio respecto a RGL
 */
export function applyBsdDragChainPushLayout(snap, oldItem, newItem, layoutFromRgl, cols = 12) {
  if (!Array.isArray(layoutFromRgl) || !layoutFromRgl.length || !oldItem || !newItem) return null;

  const movedId = String(newItem.i ?? '');
  if (!movedId) return null;

  const snapNorm = Array.isArray(snap) && snap.length ? normalizeLayoutForPersistence(snap) : null;

  /** @type {BsdGridItem[]} */
  const items = layoutFromRgl
    .filter((it) => it && it.i != null)
    .map((it) => {
      const id = String(it.i);
      return {
        ...it,
        i: id,
        x: Math.round(Number(it.x)) || 0,
        y: Math.round(Number(it.y)) || 0,
        w: Math.round(Number(it.w)) || 1,
        h: Math.round(Number(it.h)) || 1,
      };
    });

  const moved = items.find((it) => it.i === movedId);
  if (!moved) return null;

  const ox = Math.round(Number(oldItem.x)) || 0;
  const oy = Math.round(Number(oldItem.y)) || 0;
  const nxp = Math.round(Number(newItem.x)) || 0;
  const nyp = Math.round(Number(newItem.y)) || 0;
  const nw = Math.round(Number(newItem.w)) || Math.round(Number(moved.w)) || 1;
  const nh = Math.round(Number(newItem.h)) || Math.round(Number(moved.h)) || 1;
  moved.w = nw;
  moved.h = nh;

  const step = bsdDragDominantUnitStep(ox, oy, nxp, nyp);
  if (step.dx === 0 && step.dy === 0) {
    if (nxp === ox && nyp === oy) return null;
    if (snapNorm) {
      bsdApplySnapPositions(items, snapNorm);
      for (const it of items) bsdClampGridItem(it, cols);
      return normalizeLayoutForPersistence(items);
    }
    moved.x = ox;
    moved.y = oy;
    for (const it of items) bsdClampGridItem(it, cols);
    return normalizeLayoutForPersistence(items);
  }

  /** @type {'R'|'L'|'D'|'U'} */
  let dir = 'R';
  if (step.dx > 0) dir = 'R';
  else if (step.dx < 0) dir = 'L';
  else if (step.dy > 0) dir = 'D';
  else dir = 'U';

  const rect = { x: ox, y: oy, w: nw, h: nh };
  const neighbor = bsdFindTouchingNeighbor(items, movedId, rect, dir);

  if (neighbor) {
    const sameSize =
      Math.round(Number(neighbor.w)) === nw && Math.round(Number(neighbor.h)) === nh;
    if (sameSize) {
      const oxO = neighbor.x;
      const oyO = neighbor.y;
      neighbor.x = ox;
      neighbor.y = oy;
      moved.x = oxO;
      moved.y = oyO;
      for (const it of items) bsdClampGridItem(it, cols);
      if (!bsdAnyPairOverlaps(items)) {
        return normalizeLayoutForPersistence(items);
      }
      neighbor.x = oxO;
      neighbor.y = oyO;
      moved.x = ox;
      moved.y = oy;
    }
  }

  const candX = ox + step.dx;
  const candY = oy + step.dy;
  moved.x = candX;
  moved.y = candY;
  for (const it of items) bsdClampGridItem(it, cols);
  if (!bsdAnyPairOverlaps(items)) {
    return normalizeLayoutForPersistence(items);
  }

  moved.x = ox;
  moved.y = oy;
  if (snapNorm) {
    bsdApplySnapPositions(items, snapNorm);
    for (const it of items) bsdClampGridItem(it, cols);
    return normalizeLayoutForPersistence(items);
  }
  for (const it of items) bsdClampGridItem(it, cols);
  return normalizeLayoutForPersistence(items);
}

/**
 * Fusiona la salida de react-grid-layout con el layout previo (ids que RGL a veces omite en `next`)
 * y filtra a widgets permitidos. Sin efectos secundarios.
 *
 * @param {BsdGridItem[] | null | undefined} next
 * @param {BsdGridItem[] | null | undefined} prev
 * @param {'panel' | 'device'} variant
 * @param {number} panelDevicesLen
 * @param {Record<string, unknown>} visibilityMap
 * @returns {BsdGridItem[] | null}
 */
export function computeBsdDashboardNormalizedLayout(next, prev, variant, panelDevicesLen, visibilityMap) {
  const defaults = buildDefaultBsdGridLayout(
    variant,
    variant === 'panel' ? panelDevicesLen : 0,
    visibilityMap
  );
  if (!defaults.length) {
    const raw = normalizeLayoutForPersistence((next || []).filter((it) => it && it.i != null));
    const clamped = normalizeLayoutForPersistence(clampLayoutItemsToModerateMins(raw));
    const filtered = filterLayoutToAllowedDashboardItems(clamped, []);
    return filtered.length ? filtered : null;
  }
  const defaultIds = new Set(defaults.map((d) => String(d.i)));
  const allowed = new Set(defaultIds);
  for (const arr of [next, prev]) {
    for (const it of arr || []) {
      if (!it || it.i == null) continue;
      const id = String(it.i);
      const base = dashboardWidgetBaseId(id);
      if (!defaultIds.has(base)) continue;
      if (!MULTI_INSTANCE_DASH_WIDGETS.has(base)) continue;
      if (id === base || id.startsWith(`${base}__`)) allowed.add(id);
    }
  }
  const cleaned = normalizeLayoutForPersistence((next || []).filter((it) => it && allowed.has(String(it.i))));
  const prevMap = new Map((prev || []).map((it) => [String(it.i), it]));
  const cleanedIds = new Set(cleaned.map((it) => String(it.i)));
  const merged = [...cleaned];
  for (const [id, item] of prevMap) {
    if (!cleanedIds.has(id) && allowed.has(id)) merged.push(item);
  }
  /**
   * RGL a veces entrega `next` incompleto (solo celdas tocadas) o vacío al persistir.
   * Sin rellenar contra `defaults`, un widget visible (p. ej. Circular) desaparecía del layout
   * guardado aunque `visibilityMap` siguiera en true.
   */
  const reconciled = normalizeLayoutForPersistence(mergeStoredBsdGridLayout(merged, defaults));
  const filtered = filterLayoutToAllowedDashboardItems(reconciled, defaults);
  return normalizeLayoutForPersistence(clampLayoutItemsToModerateMins(filtered));
}
