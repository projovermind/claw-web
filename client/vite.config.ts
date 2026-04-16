/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3838',
      '/ws': { target: 'ws://localhost:3838', ws: true }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true
  }
});
