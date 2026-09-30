/**
 * A tiny static file server for the e2e host page. It mirrors Foundry's URL
 * layout for the module: the built `dist/` is served at
 * `/modules/mediasoup-vtt/`, exactly where Foundry serves an installed module,
 * and the host page (a v14-shaped Foundry stub) at `/`.
 */

import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface StaticRoute {
  /** URL prefix, with a trailing slash (`/` matches everything). */
  prefix: string;
  /** Directory the prefix maps to. */
  dir: string;
}

export interface StaticServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

function resolveFile(routes: StaticRoute[], pathname: string): string | null {
  for (const { prefix, dir } of routes) {
    if (!pathname.startsWith(prefix)) continue;
    const relative = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html';
    const file = path.resolve(dir, relative);
    // No escaping the mapped directory with `..`.
    if (file !== dir && !file.startsWith(dir + path.sep)) return null;
    try {
      const stat = statSync(file);
      if (stat.isFile()) return file;
      if (stat.isDirectory()) {
        const index = path.join(file, 'index.html');
        if (statSync(index).isFile()) return index;
      }
    } catch {
      // Try the next route.
    }
  }
  return null;
}

export function startStaticServer(routes: StaticRoute[]): Promise<StaticServerHandle> {
  const sorted = [...routes]
    .map((r) => ({ prefix: r.prefix, dir: path.resolve(r.dir) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const file = resolveFile(sorted, pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not found: ${pathname}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 is a secure context for getUserMedia, like localhost.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
