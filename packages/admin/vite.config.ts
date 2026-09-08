import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin SPA is served by the API container from packages/api/public/admin/.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: { outDir: '../api/public/admin', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
