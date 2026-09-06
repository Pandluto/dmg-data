import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { createLogger, defineConfig, type Plugin } from 'vite';

import { createAkeDemoApi } from '../ake-api.mjs';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(uiRoot, '../..');
const isSitesBuild = process.env.SITES_BUILD === '1';
const logger = createLogger();
const loggerWarn = logger.warn;

logger.warn = (message, options) => {
  if (
    message.includes('Files in the public directory are served at the root path.')
    || message.includes('Instead of /public/images/weapon/icon/')
  ) return;
  loggerWarn(message, options);
};

function akeDemoMiddleware(): Plugin {
  const api = createAkeDemoApi({ projectRoot });
  return {
    name: 'ake-demo-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!await api.handle(request, response)) next();
      });
      server.httpServer?.once('close', () => { void api.close(); });
    },
  };
}

export default defineConfig({
  root: uiRoot,
  base: '/',
  customLogger: logger,
  define: {
    __DEF_MOBILE_SHARE_ENABLED__: JSON.stringify(false),
  },
  plugins: [
    react(),
    tailwindcss(),
    akeDemoMiddleware(),
    ...(isSitesBuild ? cloudflare({
      config: {
        name: 'dmg-endfield-overseas-retirement',
        main: './worker/index.ts',
        compatibility_date: '2026-08-29',
        assets: {
          directory: './dist/client',
          run_worker_first: true,
        },
      },
    }) : []),
  ],
  optimizeDeps: {
    entries: ['index.html'],
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  server: {
    host: '127.0.0.1',
    port: 43821,
    strictPort: true,
    fs: { allow: [projectRoot] },
    watch: { ignored: ['**/data/localdata/**', '**/.dbg/**', '**/artifacts/**'] },

  },
  build: {
    outDir: path.join(uiRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/');
          if (
            normalizedId.includes('/node_modules/@ybouane/liquidglass/')
            || normalizedId.includes('/src/platform/theme/LiquidTideEffects')
            || normalizedId.includes('/src/platform/theme/useLiquidTide')
            || normalizedId.includes('/src/platform/theme/liquidGlass')
          ) return 'theme-liquid-runtime';
          return undefined;
        },
      },
    },
  },
});
