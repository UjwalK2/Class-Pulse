import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    cors: true,
    watch: {
      ignored: ['**/data/**', '**/*.json', '**/.git/**'],
    },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
})
