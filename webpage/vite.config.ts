import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8790', ws: true },
      '/status': 'http://127.0.0.1:8790',
      '/api': 'http://127.0.0.1:8790',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
