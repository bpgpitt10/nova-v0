import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const loopermanAsset = fileURLToPath(new URL('./src/assets/looperman.PNG', import.meta.url))
const looperLogoWhiteAsset = fileURLToPath(
  new URL('./src/assets/LooperLogoWhite.png', import.meta.url),
)

// Web-first Looper build. The aliases preserve legacy imports that only worked
// on case-insensitive Windows/macOS file systems.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /(?:\.\.\/|\.\/)assets\/looperman\.png$/, replacement: loopermanAsset },
      {
        find: /(?:\.\.\/|\.\/)assets\/looperlogowhite\.png$/,
        replacement: looperLogoWhiteAsset,
      },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
  },
})
