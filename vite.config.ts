import { defineConfig } from 'vite';

// Cross-origin isolation is not required: audio moves between threads with postMessage.
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
