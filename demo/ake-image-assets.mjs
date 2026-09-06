import fs from 'node:fs/promises';
import path from 'node:path';

/** Hashed UI icons are immutable; HTML and calculation responses are not. */
export async function serveAkeImageAsset(request, response, publicRoot, pathname) {
    const match = /^\/assets\/ake-icons\/([a-z0-9_-]+\.([a-f0-9]{12})\.webp)$/.exec(pathname);
    if (!match) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return true;
    }
    try {
        const filename = path.join(publicRoot, 'assets/ake-icons', match[1]);
        const stat = await fs.stat(filename);
        const etag = `"${match[2]}"`;
        const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable',
            ETag: etag, 'X-Content-Type-Options': 'nosniff' };
        if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); response.end(); return true; }
        response.writeHead(200, { ...headers, 'Content-Length': stat.size });
        response.end(request.method === 'HEAD' ? undefined : await fs.readFile(filename));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end();
    }
    return true;
}
