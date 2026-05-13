import React, { Children, Fragment, isValidElement, useMemo } from 'react';
import { calcGridItemPosition } from 'react-grid-layout';

/**
 * `react-grid-layout` y nuestro tablero estático usan `React.Children.forEach` / `map` solo sobre hijos
 * directos; un `<>…</>` (Fragment) cuenta como **un** hijo (p. ej. key `.0`), no como los widgets con
 * `key={DASH_WIDGET.*}` — el layout deja de coincidir y el tablero queda vacío en edición o al guardar.
 */
export function flattenDashboardGridChildren(nodes) {
  const out = [];
  Children.forEach(nodes, (node) => {
    if (node == null || typeof node === 'boolean') return;
    if (isValidElement(node) && node.type === Fragment) {
      out.push(...flattenDashboardGridChildren(node.props.children));
      return;
    }
    out.push(node);
  });
  return out;
}

/** Tablero bloqueado: posiciones fijas (misma geometría que RGL) sin grid interactivo. */
export default function BsdStaticDashboardGrid({
  layout,
  width,
  cols = 12,
  rowHeight = 36,
  margin = [18, 18],
  containerPadding = [0, 0],
  children,
}) {
  const positionParams = useMemo(
    () => ({
      margin,
      containerPadding,
      containerWidth: Math.max(1, width),
      cols,
      rowHeight,
      maxRows: 1_000_000,
    }),
    [margin, containerPadding, width, cols, rowHeight]
  );

  const byId = useMemo(() => new Map(layout.map((it) => [String(it.i), it])), [layout]);

  const minHeight = useMemo(() => {
    let m = 0;
    const [, py] = containerPadding;
    for (const it of layout) {
      const pos = calcGridItemPosition(positionParams, it.x, it.y, it.w, it.h);
      m = Math.max(m, pos.top + pos.height + py);
    }
    return Math.max(m + 12, 120);
  }, [layout, positionParams, containerPadding]);

  const leafChildren = useMemo(() => flattenDashboardGridChildren(children), [children]);

  return (
    <div className="bsd-dash-static-layout" style={{ position: 'relative', width: '100%', minHeight }}>
      {leafChildren.flatMap((child) => {
        if (!isValidElement(child) || child.key == null) return [];
        const id = String(child.key);
        const item = byId.get(id);
        if (!item) return [];
        const pos = calcGridItemPosition(positionParams, item.x, item.y, item.w, item.h);
        return [
          <div
            key={id}
            className="bsd-dash-static-cell"
            style={{
              position: 'absolute',
              left: pos.left,
              top: pos.top,
              width: pos.width,
              height: pos.height,
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            {child}
          </div>,
        ];
      })}
    </div>
  );
}
