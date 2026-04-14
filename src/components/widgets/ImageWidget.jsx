import React, { useMemo, useState } from 'react';
import { ImageOff, ExternalLink } from 'lucide-react';

const isUrl = (value) => /^https?:\/\/.+/i.test(String(value || '').trim());
const isDataUrl = (value) => /^data:image\//i.test(String(value || '').trim());

const ImageWidget = ({ title, value, imageDataUrl, deviceName }) => {
  const [error, setError] = useState(false);

  const imageUrl = useMemo(() => {
    if (imageDataUrl && isDataUrl(imageDataUrl)) return String(imageDataUrl);
    if (isUrl(value)) return String(value).trim();
    const seed = encodeURIComponent(deviceName || title || 'device');
    return `https://picsum.photos/seed/${seed}/640/360`;
  }, [value, imageDataUrl, deviceName, title]);

  const hasTelemetryUrl = isUrl(value) && !imageDataUrl;
  const hasLocalImage = Boolean(imageDataUrl && isDataUrl(imageDataUrl));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
        {hasLocalImage
          ? 'Imagen desde tu equipo'
          : hasTelemetryUrl
            ? 'Fuente: URL en telemetría'
            : 'Fuente: imagen de referencia'}
      </div>
      <div
        style={{
          flex: 1,
          borderRadius: '12px',
          overflow: 'hidden',
          border: '1px solid var(--border-color)',
          background: 'var(--bg-secondary)',
          position: 'relative',
        }}
      >
        {!error ? (
          <img
            src={imageUrl}
            alt={title}
            onError={() => setError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              gap: '8px',
            }}
          >
            <ImageOff size={16} /> Sin imagen disponible
          </div>
        )}
      </div>
      {hasTelemetryUrl && !error && (
        <a
          href={imageUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: '0.75rem',
            color: 'var(--accent-blue)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          Ver imagen original <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
};

export default ImageWidget;
