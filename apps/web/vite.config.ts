import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// One build serves CloudFront (S3 origin) and the on-prem nginx; runtime settings come from
// /env.js (never baked in), so no VITE_* variable is read here.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
