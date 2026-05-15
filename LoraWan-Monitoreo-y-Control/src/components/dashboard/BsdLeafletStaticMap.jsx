import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createLeafletBaseTileLayer, normalizeMapBaseLayerId } from './mapWidgetLayers';

/**
 * Mapa Leaflet de un solo punto (widget Mapa estático).
 * @param {{ lat: number; lng: number; baseLayerId?: string; className?: string }} props
 */
export default function BsdLeafletStaticMap({ lat, lng, baseLayerId = 'street', className }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const tileRef = useRef(null);
  const markerRef = useRef(null);
  const baseLayerSwapReadyRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const map = L.map(el, { zoomControl: true, preferCanvas: true }).setView([lat, lng], 15);
    mapRef.current = map;
    const tl = createLeafletBaseTileLayer(L, baseLayerId);
    tileRef.current = tl;
    tl.addTo(map);
    const mk = L.marker([lat, lng], { keyboard: false });
    markerRef.current = mk;
    mk.addTo(map);
    baseLayerSwapReadyRef.current = false;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    if (ro) ro.observe(el);
    return () => {
      if (ro) ro.disconnect();
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      markerRef.current = null;
      baseLayerSwapReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init único; capa y coordenadas en otros effects
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!baseLayerSwapReadyRef.current) {
      baseLayerSwapReadyRef.current = true;
      return;
    }
    const nextId = normalizeMapBaseLayerId(baseLayerId);
    if (tileRef.current) {
      map.removeLayer(tileRef.current);
      tileRef.current = null;
    }
    const tl = createLeafletBaseTileLayer(L, nextId);
    tileRef.current = tl;
    tl.addTo(map);
  }, [baseLayerId]);

  useEffect(() => {
    const map = mapRef.current;
    const mk = markerRef.current;
    if (!map || !mk) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    mk.setLatLng([lat, lng]);
    map.setView([lat, lng], Math.max(map.getZoom(), 14));
  }, [lat, lng]);

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
