import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The public site is served by the API container from packages/api/public/.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: '../api/public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
