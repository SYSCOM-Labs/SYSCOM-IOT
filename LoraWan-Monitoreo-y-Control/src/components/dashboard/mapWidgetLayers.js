/** Opciones de fondo compartidas entre mapa estático y mapa de rastreo (Leaflet). */

export const DEFAULT_MAP_BASE_LAYER_ID = 'street';

export const MAP_BASE_LAYER_OPTIONS = [
  { id: 'street', label: 'Calles' },
  { id: 'cyclosm', label: 'CyclOSM' },
  { id: 'humanitarian', label: 'Humanitario' },
  { id: 'topo', label: 'Topográfico' },
  { id: 'satellite', label: 'Satélite' },
];

/** @param {unknown} raw */
export function normalizeMapBaseLayerId(raw) {
  const s = String(raw ?? '').trim();
  if (MAP_BASE_LAYER_OPTIONS.some((o) => o.id === s)) return s;
  return DEFAULT_MAP_BASE_LAYER_ID;
}

/**
 * Capa raster OSM.org embebida (vista previa modal). Ver capas admitidas en el sitio OSM.
 * @param {string} [layerId] id lógico (`street`, …)
 */
export function osmEmbedLayerParam(layerId) {
  const id = normalizeMapBaseLayerId(layerId);
  const map = {
    street: 'mapnik',
    cyclosm: 'cyclosm',
    humanitarian: 'hot',
    topo: 'cyclemap',
    satellite: 'transportmap',
  };
  return map[id] || 'mapnik';
}

/**
 * @param {import('leaflet')} L
 * @param {string} layerId
 */
export function createLeafletBaseTileLayer(L, layerId) {
  const id = normalizeMapBaseLayerId(layerId);
  const common = { maxZoom: 19, maxNativeZoom: 19 };
  switch (id) {
    case 'cyclosm':
      return L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
        ...common,
        subdomains: 'abc',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://www.cyclosm.org/" target="_blank" rel="noreferrer">CyclOSM</a>',
      });
    case 'humanitarian':
      return L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
        ...common,
        subdomains: 'abc',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://www.hotosm.org/" target="_blank" rel="noreferrer">HOT</a>',
      });
    case 'topo':
      return L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        ...common,
        maxZoom: 17,
        maxNativeZoom: 17,
        subdomains: 'abc',
        attribution:
          'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
      });
    case 'satellite':
      return L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          ...common,
          maxZoom: 19,
          attribution:
            'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        }
      );
    case 'street':
    default:
      return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        ...common,
        subdomains: 'abc',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      });
  }
}
