import vue from '@vitejs/plugin-vue'
import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwind()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    target: 'chrome109',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/@codemirror\//.test(id)) return 'editor'
          if (/node_modules\/@lezer\//.test(id)) return 'parser'
          if (/node_modules\/(?:highlight\.js|markdown-it|linkify-it|uc\.micro|mdurl|entities|punycode\.js)\//.test(id)) return 'markdown'
        },
      },
    },
  },
})
