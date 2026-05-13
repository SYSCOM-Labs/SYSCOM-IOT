import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const LAST_PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 24 32" aria-hidden="true">
  <path d="M12 2C7.58 2 4 5.58 4 10c0 6.5 8 14 8 14s8-7.5 8-14c0-4.42-3.58-8-8-8z" fill="#0ea5e9" stroke="#0369a1" stroke-width="1.1"/>
  <circle cx="12" cy="10" r="2.8" fill="#f8fafc"/>
</svg>`;

function makeLastPositionIcon() {
  return L.divIcon({
    className: 'bsd-tracking-map-pin',
    html: LAST_PIN_SVG,
    iconSize: [34, 44],
    iconAnchor: [17, 42],
  });
}

/** Abre Google Maps en modo Street View (si hay cobertura en esa ubicación). */
export function googleStreetViewMapsUrl(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return 'https://www.google.com/maps';
  return `https://www.google.com/maps?layer=c&cbll=${encodeURIComponent(la)},${encodeURIComponent(ln)}`;
}

/**
 * @param {{ lat: number; lng: number; ts?: number }} p
 * @param {number} index
 * @param {number} total
 */
function buildTrackingPointPopupEl(p, index, total) {
  const wrap = document.createElement('div');
  wrap.className = 'bsd-tracking-map-popup';

  const title = document.createElement('div');
  title.className = 'bsd-tracking-map-popup__title';
  title.textContent =
    total <= 1 ? 'Posición' : index === 0 ? 'Inicio' : index === total - 1 ? 'Última posición' : `Punto ${index + 1} de ${total}`;
  wrap.appendChild(title);

  const coord = document.createElement('div');
  coord.className = 'bsd-tracking-map-popup__coord';
  coord.textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
  wrap.appendChild(coord);

  if (p.ts != null && Number.isFinite(p.ts) && p.ts > 0) {
    const t = document.createElement('div');
    t.className = 'bsd-tracking-map-popup__time';
    try {
      t.textContent = new Date(p.ts).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium',
      });
    } catch {
      t.textContent = String(p.ts);
    }
    wrap.appendChild(t);
  }

  const link = document.createElement('a');
  link.className = 'bsd-tracking-map-popup__street';
  link.href = googleStreetViewMapsUrl(p.lat, p.lng);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Abrir en Google Street View';
  wrap.appendChild(link);

  return wrap;
}

/**
 * Mapa Leaflet: polilínea de trayectoria, marcador circular en cada punto (clic → popup + Street View)
 * y pin decorativo en la última posición (no interactivo para no tapar el círculo).
 * @param {{ lat: number; lng: number; ts?: number }[]} latLngs
 * @param {string} [className]
 */
export default function BsdLeafletTrackingMap({ latLngs, className }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const map = L.map(el, { zoomControl: true, preferCanvas: true }).setView([20, 0], 2);
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    if (ro) ro.observe(el);
    return () => {
      if (ro) ro.disconnect();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (overlayRef.current) {
      map.removeLayer(overlayRef.current);
      overlayRef.current = null;
    }
    const pts = Array.isArray(latLngs) ? latLngs.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) : [];
    if (!pts.length) {
      map.setView([20, 0], 2);
      return;
    }
    const last = pts[pts.length - 1];
    const layers = [];

    const addPointMarkers = () => {
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        const isFirst = i === 0;
        const isLast = i === pts.length - 1;
        const radius = pts.length === 1 ? 9 : isFirst || isLast ? 7 : 5;
        const cm = L.circleMarker([p.lat, p.lng], {
          radius,
          stroke: true,
          weight: 2,
          color: isLast ? '#0369a1' : '#0284c7',
          fillColor: isFirst ? '#86efac' : isLast ? '#7dd3fc' : '#e0f2fe',
          fillOpacity: 0.92,
        });
        cm.bindPopup(buildTrackingPointPopupEl(p, i, pts.length), { maxWidth: 280 });
        layers.push(cm);
      }
    };

    if (pts.length === 1) {
      addPointMarkers();
      const pin = L.marker([last.lat, last.lng], {
        icon: makeLastPositionIcon(),
        zIndexOffset: 800,
        interactive: false,
      });
      layers.push(pin);
      const g = L.layerGroup(layers).addTo(map);
      overlayRef.current = g;
      map.setView([last.lat, last.lng], 16);
      return;
    }

    const ll = pts.map((p) => [p.lat, p.lng]);
    const pl = L.polyline(ll, { color: '#38bdf8', weight: 4, opacity: 0.92 });
    layers.push(pl);
    addPointMarkers();
    const pin = L.marker([last.lat, last.lng], {
      icon: makeLastPositionIcon(),
      zIndexOffset: 800,
      interactive: false,
    });
    layers.push(pin);

    const g = L.layerGroup(layers).addTo(map);
    overlayRef.current = g;
    try {
      map.fitBounds(pl.getBounds(), { padding: [26, 26], maxZoom: 16 });
      if (map.getZoom() < 14) {
        map.setView([last.lat, last.lng], 14);
      } else {
        map.panTo([last.lat, last.lng]);
      }
    } catch {
      map.setView([last.lat, last.lng], 15);
    }
  }, [latLngs]);

  return (
    <div
      ref={containerRef}
      className={className || ''}
      style={{
        width: '100%',
        height: '100%',
        flex: '1 1 0%',
        minHeight: 0,
        minWidth: 0,
        zIndex: 1,
      }}
    />
  );
}
