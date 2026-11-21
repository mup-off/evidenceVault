import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server forwards /api to the Express API, so the browser talks to a
// single origin and the API needs no CORS settings.
export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.API_URL || 'http://localhost:4000', changeOrigin: false },
    },
  },
  preview: {
    host: 'localhost',
    port: 4173,
    proxy: {
      '/api': { target: process.env.API_URL || 'http://localhost:4000', changeOrigin: false },
    },
  },
});
