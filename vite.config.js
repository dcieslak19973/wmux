import { defineConfig } from 'vite';

export default defineConfig({
  // Tauri dev server uses this port
  server: {
    port: 1420,
    strictPort: true,
  },
  // Prevent Vite from obscuring Rust error messages
  clearScreen: false,
  build: {
    // Tauri supports ES2021
    target: ['es2021', 'chrome105', 'safari13'],
    // Don't minify for debug, Tauri handles it in release
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
  },
});
