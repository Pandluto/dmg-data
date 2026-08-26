import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createLogger, defineConfig, type Plugin } from 'vite';

import {
  DemoInputError,
  getDemoCatalog,
  simulateDemo,
  simulateSquadDemo,
} from '../demo-service.mjs';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(uiRoot, '../..');
const logger = createLogger();
const loggerWarn = logger.warn;

logger.warn = (message, options) => {
  if (
    message.includes('Files in the public directory are served at the root path.')
    || message.includes('Instead of /public/images/weapon/icon/')
  ) return;
  loggerWarn(message, options);
};

function sendJson(
  response: import('node:http').ServerResponse,
  statusCode: number,
  value: unknown,
) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readJson(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new DemoInputError('请求体超过 1 MB。');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  } catch {
    throw new DemoInputError('请求体不是有效 JSON。');
  }
}

function akeDemoMiddleware(): Plugin {
  return {
    name: 'ake-demo-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (request.method === 'GET' && url.pathname === '/api/health') {
            sendJson(response, 200, { ok: true, frontend: 'lts-reuse', engine: 'ake' });
            return;
          }
          if (
            request.method === 'GET'
            && (url.pathname === '/api/catalog' || url.pathname === '/api/ake/catalog')
          ) {
            sendJson(response, 200, getDemoCatalog({ projectRoot }));
            return;
          }
          if (
            request.method === 'POST'
            && url.pathname === '/api/ake/squad/simulate'
          ) {
            sendJson(response, 200, simulateSquadDemo(await readJson(request), { projectRoot }));
            return;
          }
          if (
            request.method === 'POST'
            && (url.pathname === '/api/simulate' || url.pathname === '/api/ake/simulate')
          ) {
            sendJson(response, 200, simulateDemo(await readJson(request), { projectRoot }));
            return;
          }
          next();
        } catch (error) {
          if (error instanceof DemoInputError) {
            sendJson(response, 400, { error: error.message });
            return;
          }
          server.config.logger.error(error instanceof Error ? error.stack || error.message : String(error));
          sendJson(response, 500, { error: 'AKE 模拟失败，请查看终端日志。' });
        }
      });
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
  plugins: [react(), tailwindcss(), akeDemoMiddleware()],
  optimizeDeps: {
    entries: ['index.html'],
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  server: {
    host: '127.0.0.1',
    port: 43821,
    strictPort: true,
    fs: { allow: [projectRoot] },
    watch: { ignored: ['**/data/localdata/**', '**/.dbg/**'] },
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
