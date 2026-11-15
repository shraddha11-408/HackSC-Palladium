import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard proxies to a Palladium API on :8000, so its login cookie
// is same-origin and the /ws/events socket carries it.
const api = process.env.PALLADIUM_API || process.env.SAFESC_API || 'http://127.0.0.1:8000';

export default defineConfig(({mode}) => ({
  base: mode === 'hosted' ? '/command/' : '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {target: api, changeOrigin: true},
      '/ws': {target: api.replace(/^http/, 'ws'), ws: true, changeOrigin: true},
    },
  },
  worker: {format: 'es'},
  build: {
    chunkSizeWarningLimit: 4000,
    ...(mode === 'hosted' && {outDir: '../web/dist/command', emptyOutDir: true}),
  },
}));
