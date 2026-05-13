import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // El SSE en desarrollo usa URL directa al API (ver `getEventsStreamUrl` en apiBase.js). El proxy sigue sirviendo el resto de `/api`.
      // `timeout: 0` ayuda si algo aún pasa por aquí con streams largos.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          proxy.on('error', (err, req) => {
            const u = req && req.url;
            console.error('[vite-proxy]', u || '/api', err && (err.code || err.message));
          });
        },
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: mode === 'production' ? false : true,
    chunkSizeWarningLimit: 2800,
  },
}));
