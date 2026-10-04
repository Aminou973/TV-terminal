import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy: REST and WebSocket /api/* go to the FastAPI backend.
export default defineConfig({
  plugins: [react()],
  // the indicator library (~2.5 MB, 876 indicators) and the code editor are
  // split into lazy chunks loaded on first use; the warning is expected
  build: { chunkSizeWarningLimit: 2700 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', ws: true, changeOrigin: true },
    },
  },
})