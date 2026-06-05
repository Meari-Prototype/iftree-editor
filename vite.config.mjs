import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function manualChunks(id) {
  const normalized = id.replace(/\\/g, '/');
  if (!normalized.includes('/node_modules/')) return undefined;
  if (normalized.includes('/react/') || normalized.includes('/react-dom/') || normalized.includes('/scheduler/')) {
    return 'vendor-react';
  }
  if (normalized.includes('/lucide-react/') || normalized.includes('/lucide/')) {
    return 'vendor-icons';
  }
  if (normalized.includes('/@radix-ui/')) {
    return 'vendor-radix';
  }
  if (normalized.includes('/pdfjs-dist/')) {
    return 'vendor-pdf';
  }
  if (normalized.includes('/@huggingface/transformers/') || normalized.includes('/onnxruntime-web/')) {
    return 'vendor-ml';
  }
  return 'vendor';
}

export default defineConfig({
  plugins: [react()],
  base: './',
  assetsInclude: ['**/*.wasm'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
});
