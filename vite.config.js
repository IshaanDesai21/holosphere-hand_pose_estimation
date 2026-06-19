import { defineConfig } from 'vite'

export default defineConfig({
  // Base path for Netlify deployment - use '/' for root deployments
  base: '/',
  
  // Build configuration
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Rollup options for chunking
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching
        manualChunks: {
          three: ['three'],
        }
      }
    }
  },
  
  // Optimise dependencies
  optimizeDeps: {
    include: ['three', '@mediapipe/tasks-vision']
  },

  // Server config for local development
  server: {
    port: 5173,
    // Required for SharedArrayBuffer / WebAssembly (MediaPipe)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
