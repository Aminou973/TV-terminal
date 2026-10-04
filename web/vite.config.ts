import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy: REST and WebSocket /api/* go to the FastAPI backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', ws: true, changeOrigin: true },
    },
  },
})