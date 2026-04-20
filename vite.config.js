import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devCertPath = path.join(__dirname, 'certs', 'localhost.crt');
const devKeyPath = path.join(__dirname, 'certs', 'localhost.key');
const devTlsFiles =
  fs.existsSync(devCertPath) && fs.existsSync(devKeyPath)
    ? { cert: fs.readFileSync(devCertPath), key: fs.readFileSync(devKeyPath) }
    : null;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = (env.VITE_API_PORT || '3001').trim();

  return {
    plugins: devTlsFiles ? [react()] : [react(), basicSsl()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      https: devTlsFiles || true,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
