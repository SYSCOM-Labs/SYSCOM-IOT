import React, { useMemo } from 'react';
import { MapPin, Navigation } from 'lucide-react';

const LAT_KEYS = ['latitude', 'lat', 'gpslat', 'locationlat', 'positionlat', 'y'];
const LNG_KEYS = ['longitude', 'lng', 'lon', 'gpslng', 'locationlng', 'positionlng', 'x'];

const pickCoordinate = (props, keys) => {
  const entries = Object.entries(props || {});
  for (const [k, v] of entries) {
    const normalized = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (keys.includes(normalized)) {
      const num = parseFloat(v);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
};

const MapWidget = ({ title, deviceName, properties }) => {
  const coords = useMemo(() => {
    const lat = pickCoordinate(properties, LAT_KEYS);
    const lng = pickCoordinate(properties, LNG_KEYS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }, [properties]);

  if (!coords) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', flexDirection: 'column', gap: '6px' }}>
        <MapPin size={18} />
        <span>Sin coordenadas detectadas</span>
        <small>Busca keys como latitude/longitude o lat/lng</small>
      </div>
    );
  }

  const bbox = `${coords.lng - 0.02}%2C${coords.lat - 0.02}%2C${coords.lng + 0.02}%2C${coords.lat + 0.02}`;
  const marker = `${coords.lat}%2C${coords.lng}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${marker}`;
  const external = `https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=14/${coords.lat}/${coords.lng}`;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Navigation size={12} /> {deviceName || title} - {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
      </div>
      <div style={{ flex: 1, borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
        <iframe
          title={`${title}-map`}
          src={src}
          width="100%"
          height="100%"
          style={{ border: 0, minHeight: '140px' }}
          loading="lazy"
        />
      </div>
      <a href={external} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--accent-blue)' }}>
        Abrir mapa completo
      </a>
    </div>
  );
};

export default MapWidget;

