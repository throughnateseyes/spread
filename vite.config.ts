import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` so the built index.html loads its assets from file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
