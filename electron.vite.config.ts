import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const updateUrl = process.env.SUPPORT_UPDATE_URL?.trim() || 'http://10.1.1.212:8787/updates/'

export default defineConfig({
  main: {
    define: { 'process.env.SUPPORT_UPDATE_URL': JSON.stringify(updateUrl) },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})