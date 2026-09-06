#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAkeDemoApi } from './ake-api.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, '..');
const publicRoot = path.join(moduleDirectory, 'lts-ui', 'dist');
const host = '127.0.0.1';
const portArgument = process.argv.find(argument => argument.startsWith('--port='));
const port = Number(portArgument?.slice('--port='.length) ?? process.env.DEMO_PORT ?? 43821);

const MIME_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
});

function sendJson(response, statusCode, value) {
    const body = `${JSON.stringify(value)}\n`;
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

async function serveStatic(pathname, response) {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const decoded = decodeURIComponent(requested);
    const absolutePath = path.resolve(publicRoot, `.${decoded}`);
    if (!absolutePath.startsWith(`${publicRoot}${path.sep}`)) {
        sendJson(response, 403, { error: '拒绝访问。' });
        return;
    }
    try {
        const body = await fs.readFile(absolutePath);
        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(absolutePath)] ?? 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'no-cache'
        });
        response.end(body);
    } catch (error) {
        if (error.code === 'ENOENT') {
            const indexBody = await fs.readFile(path.join(publicRoot, 'index.html'));
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': indexBody.length,
                'Cache-Control': 'no-cache'
            });
            response.end(indexBody);
            return;
        }
        throw error;
    }
}

const api = createAkeDemoApi({ projectRoot, publicRoot });
const server = http.createServer(async (request, response) => {
    try {
        if (await api.handle(request, response)) return;
        const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { error: '不支持这个请求方法。' });
            return;
        }
        await serveStatic(url.pathname, response);
    } catch (error) {
        console.error(error);
        sendJson(response, 500, { error: '模拟失败，请查看服务端日志。' });
    }
});

server.listen(port, host, () => {
    console.log(`AKE 时间轴 Demo 已启动：http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void api.close().finally(() => server.close(() => process.exit(0))); });
}
