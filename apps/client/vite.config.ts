import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  // Relative asset URLs, so one build works at the site root and under a reverse-proxy prefix (example.com/frozen/).
  base: './',
  plugins: [react()],
  server: {
    // Listen on all interfaces so other devices on the network can join.
    host: true,
    port: Number(process.env.CLIENT_PORT ?? 5180),
    proxy: {
      '/ws': { target: `ws://localhost:${process.env.FE_PORT ?? 8090}`, ws: true },
    },
  },
  preview: {
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
