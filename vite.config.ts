import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const loopermanAsset = fileURLToPath(new URL('./src/assets/looperman.PNG', import.meta.url))
const looperLogoWhiteAsset = fileURLToPath(
  new URL('./src/assets/LooperLogoWhite.png', import.meta.url),
)
const reliableGsproCourseState = fileURLToPath(
  new URL('./src/adapters/reliableBrowserGsproCourseState.ts', import.meta.url),
)

export default defineConfig(({ command }) => ({
  plugins: [react()],
  clearScreen: false,
  ...(command === 'build'
    ? {
        define: {
          'import.meta.env.VITE_OPEN_GOLF_COACH_URL': JSON.stringify('/api/open-golf-coach'),
        },
      }
    : {}),
  resolve: {
    alias: [
      // Aim Lab historically imports this adapter relatively. Route that import through
      // the reliability guard without disturbing the core parser it wraps.
      {
        find: /^\.\.\/adapters\/browserGsproCourseState$/,
        replacement: reliableGsproCourseState,
      },
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
    proxy: {
      '/simread': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/simread/, ''),
      },
      '/open-golf-coach': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/open-golf-coach/, ''),
      },
    },
  },
}))
