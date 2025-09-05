import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': { target: 'https://localhost:7258', changeOrigin: true, secure: false },
            '/hubs': { target: 'https://localhost:7258', changeOrigin: true, ws: true, secure: false }
        }
    },
    build: {
        // NOTE: adjust the path below if your repo layout is different,
        // but from your screenshots this is correct:
        outDir: path.resolve(__dirname, '../2w2t/wwwroot'),
        emptyOutDir: true
    }
})
