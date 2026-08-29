import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { createLogger, defineConfig, type Plugin } from 'vite';

import {
  DemoInputError,
  getDemoCatalog,
  simulateDemo,
  simulateSquadDemo,
} from '../demo-service.mjs';
import { RiaArchive } from '../../src/ria/archive.mjs';
import { hashJson } from '../../src/ria/common.mjs';
import { startFixtureRunExecution } from '../../src/ria/execute.mjs';

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
  type ControlledRun = {
    caseId: string;
    sessionId: string;
    runId: string;
    inputHash: string;
    controller: Awaited<ReturnType<typeof startFixtureRunExecution>>;
  };
  const controlledRuns = new Map<string, ControlledRun>();
  let riaArchivePromise: Promise<RiaArchive> | null = null;
  const getRiaArchive = () => {
    if (!riaArchivePromise) {
      riaArchivePromise = new RiaArchive({
        projectRoot,
        archiveRoot: process.env.RIA_ARCHIVE_ROOT || null,
      }).initialize();
    }
    return riaArchivePromise;
  };
  const runKey = (caseId: string, runId: string) => `${caseId}\0${runId}`;
  const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new DemoInputError(`${label} 必须是对象。`);
    }
    return value as Record<string, unknown>;
  };
  const requireText = (value: unknown, label: string) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new DemoInputError(`${label} 必须是非空字符串。`);
    }
    return value;
  };
  const sendRiaError = (
    response: import('node:http').ServerResponse,
    error: unknown,
  ) => {
    const candidate = error as { statusCode?: number; code?: string; message?: string; details?: unknown };
    const statusCode = candidate.statusCode ?? 500;
    sendJson(response, statusCode, {
      error: {
        code: candidate.code ?? 'RIA_UI_INTEGRATION_FAILED',
        message: statusCode >= 500 ? 'RIA UI integration failed.' : candidate.message,
        details: statusCode >= 500 ? null : candidate.details ?? null,
      },
    });
  };
  return {
    name: 'ake-demo-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          const uiActionMatch = /^\/api\/ria\/runs\/([^/]+)\/ui-actions$/.exec(url.pathname);
          if (request.method === 'POST' && uiActionMatch) {
            const caseId = url.searchParams.get('caseId') ?? '';
            const runId = decodeURIComponent(uiActionMatch[1]);
            const archive = await getRiaArchive();
            const controlled = controlledRuns.get(runKey(caseId, runId));
            if (controlled) {
              try {
                sendJson(
                  response,
                  202,
                  await archive.appendRunUiAction(runId, await readJson(request), caseId),
                );
              } catch (error) {
                sendRiaError(response, error);
              }
              return;
            }
            try {
              const reference = await archive.locateRun(runId, caseId);
              if (reference.manifest.config?.uiCalculation === true) {
                sendRiaError(response, Object.assign(
                  new Error(`Run ${runId} is sealed.`),
                  { code: 'RIA_RUN_SEALED', statusCode: 409, details: null },
                ));
                return;
              }
            } catch (error) {
              if ((error as { code?: string }).code !== 'RIA_RUN_NOT_FOUND') throw error;
            }
            next();
            return;
          }
          if (request.method === 'POST' && url.pathname === '/api/ake/ria/start') {
            const body = requireRecord(await readJson(request), 'RIA start body');
            const caseId = requireText(body.caseId, 'caseId');
            const sessionId = requireText(body.sessionId, 'sessionId');
            const runId = requireText(body.runId, 'runId');
            const input = requireRecord(body.input, 'input');
            const key = runKey(caseId, runId);
            if (controlledRuns.has(key)) {
              sendJson(response, 409, {
                error: { code: 'RIA_RUN_EXISTS', message: `Run ${runId} already exists.`, details: null },
              });
              return;
            }
            const controller = await startFixtureRunExecution({
              archive: await getRiaArchive(),
              caseId,
              sessionId,
              runId,
              fixture: { adapter: 'ake-squad-demo', input },
              config: {
                explicitRecording: true,
                uiCalculation: true,
                integration: 'lts-ui-ake-provider',
              },
              findings: 'Recorded from the exact LTS UI akeProvider calculation request.\n',
            });
            controlledRuns.set(key, {
              caseId, sessionId, runId, inputHash: hashJson(input), controller,
            });
            sendJson(response, 202, { accepted: true, caseId, sessionId, runId });
            return;
          }
          if (request.method === 'POST' && url.pathname === '/api/ake/ria/seal') {
            const body = requireRecord(await readJson(request), 'RIA seal body');
            const caseId = requireText(body.caseId, 'caseId');
            const runId = requireText(body.runId, 'runId');
            const key = runKey(caseId, runId);
            const controlled = controlledRuns.get(key);
            if (!controlled) {
              sendJson(response, 404, {
                error: { code: 'RIA_RUN_NOT_ACTIVE', message: `Run ${runId} is not active.`, details: null },
              });
              return;
            }
            try {
              const sealed = await controlled.controller.seal();
              sendJson(response, 200, {
                sealed: true, runId, status: sealed.manifest.status,
              });
            } catch (error) {
              const manifest = (error as { riaRun?: { manifest?: { status?: string } } })
                .riaRun?.manifest;
              if (!manifest) throw error;
              sendJson(response, 200, {
                sealed: true, runId, status: manifest.status ?? 'interrupted',
              });
            } finally {
              controlledRuns.delete(key);
            }
            return;
          }
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
            const input = requireRecord(await readJson(request), 'simulation input');
            const caseId = request.headers['x-ria-case-id'];
            const runId = request.headers['x-ria-run-id'];
            if (typeof caseId === 'string' && typeof runId === 'string') {
              const controlled = controlledRuns.get(runKey(caseId, runId));
              if (!controlled) throw new DemoInputError(`RIA Run ${runId} 尚未启动。`);
              if (controlled.inputHash !== hashJson(input)) {
                throw new DemoInputError('RIA Run fixture 与 UI 计算请求不一致。');
              }
              if (process.env.RIA_UI_E2E_FAIL_DELIVERY_RUN_ID === runId) {
                sendJson(response, 502, { error: 'Injected browser delivery failure.' });
                return;
              }
              const completed = await controlled.controller.execution;
              sendJson(response, 200, completed.result);
              return;
            }
            sendJson(response, 200, simulateSquadDemo(input, { projectRoot }));
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
    watch: { ignored: ['**/data/localdata/**', '**/.dbg/**'] },
    proxy: {
      '/api/ria': {
        target: process.env.RIA_PROXY_TARGET || 'http://127.0.0.1:43822',
        changeOrigin: false,
      },
    },
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
