import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // JSX is compiled through src/brandJsx, which (when switched on — dashboard only) sets "ETN"/"Electroneum" in the
  // Orbitron brand font. See src/brandJsx/core.js.
  plugins: [react({ jsxImportSource: '/src/brandJsx' })],
  root: process.cwd(),
  server: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
})