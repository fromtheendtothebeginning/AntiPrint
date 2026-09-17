import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 3010,
    host: '127.0.0.1',
    proxy: {
      // 用 '^/api/' 而不是 '/api'：前缀匹配会把前端路由 /apidocs 也代理到后端
      // （dev 下就表现为「拿到后端托管的那份构建产物、脚本 404 白屏」，2026-09-17 踩到）
      '^/api/': { target: 'http://127.0.0.1:8301', changeOrigin: true },
    },
  },
})
