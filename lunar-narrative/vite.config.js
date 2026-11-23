import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// three 仍走本地 vendor（0.187 + 官方 examples），保持与原始复刻完全一致的运行时
const vendor = (p) => fileURLToPath(new URL(`./vendor/three/${p}`, import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^three$/, replacement: vendor('three.module.js') },
      { find: /^three\/examples\/jsm\//, replacement: vendor('examples/jsm/') },
      { find: /^three\/addons\//, replacement: vendor('examples/jsm/') }
    ]
  },
  server: {
    port: 5173,
    strictPort: false
  }
})
