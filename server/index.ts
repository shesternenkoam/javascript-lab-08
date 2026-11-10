import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { register, updateRuntimeMetrics } from './metrics.ts';
import { roomManager } from './rooms.ts';
import { setupWebSocket, setShuttingDown, closeAllWebSockets } from './ws.ts';

let isShuttingDown = false;
const RoomBodySchema = z.object({ name: z.string().min(1) });

// Determine client static directory
const candidateDistDirs = [
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(import.meta.dirname, '../client/dist'),
  path.resolve(import.meta.dirname, '../../client/dist'),
  path.resolve(process.cwd(), 'dist'),
];
const clientDistDir = candidateDistDirs.find((d) => fs.existsSync(d)) || candidateDistDirs[0]!;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStaticFile(reqPath: string, method: string, res: http.ServerResponse): boolean {
  if (!fs.existsSync(clientDistDir)) return false;

  let filePath = path.join(clientDistDir, reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, ''));
  if (!filePath.startsWith(clientDistDir)) return false; // Prevent directory traversal

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    // SPA fallback: return index.html for navigation routes
    const spaIndex = path.join(clientDistDir, 'index.html');
    if (!reqPath.startsWith('/api') && !reqPath.startsWith('/ws') && fs.existsSync(spaIndex)) {
      filePath = spaIndex;
    } else {
      return false;
    }
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(content);
    }
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);

  // CORS headers for API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Liveness check: /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        version: 'v1.0.1',
        gitSha: config.gitSha,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // 2. Readiness check: /ready
  if (req.method === 'GET' && url.pathname === '/ready') {
    if (isShuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_ready', reason: 'Shutting down' }));
      return;
    }
    if (roomManager.roomCount() >= config.maxRooms) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_ready', reason: 'Max room capacity reached' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ready',
        gitSha: config.gitSha,
        rooms: roomManager.roomCount(),
        maxRooms: config.maxRooms,
        players: roomManager.playerCount(),
      }),
    );
    return;
  }

  // 3. Prometheus metrics: /metrics
  if (req.method === 'GET' && url.pathname === '/metrics') {
    updateRuntimeMetrics(roomManager.roomCount(), roomManager.playerCount());
    try {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
    } catch (err: unknown) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err instanceof Error ? err.message : 'Internal Server Error');
    }
    return;
  }

  // 4. API stats (JSON)
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const memory = process.memoryUsage();
    const elu = performance.eventLoopUtilization();
    res.end(
      JSON.stringify({
        gitSha: config.gitSha,
        uptime: process.uptime(),
        rooms: roomManager.stats(),
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
        },
        elu,
      }),
    );
    return;
  }

  // 5. API rooms list
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roomManager.list()));
    return;
  }

  // 6. API create room
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1e6) req.socket.destroy();
    });

    req.on('end', () => {
      try {
        const parsed = RoomBodySchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Room name is required' }));
          return;
        }
        roomManager.create(parsed.data.name);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, room: parsed.data.name }));
      } catch (err: unknown) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }));
      }
    });
    return;
  }

  // 7. API spawn bots
  const botsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/bots$/);
  if (req.method === 'POST' && botsMatch) {
    const roomId = decodeURIComponent(botsMatch[1]!);
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1e6) req.socket.destroy();
    });

    req.on('end', () => {
      try {
        const parsed = z
          .object({ count: z.number().int().positive().default(8) })
          .safeParse(body ? JSON.parse(body) : { count: 8 });
        const count = parsed.success ? parsed.data.count : 8;
        const room = roomManager.get(roomId) ?? roomManager.create(roomId);
        const added = room.match.addBots(count);
        const playersList = [...room.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          score: 0,
        }));
        for (const p of room.players.values()) {
          p.sendJson({ type: 'players', players: playersList });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, added: added.length, total: room.match.world.ships.length }));
      } catch (_err: unknown) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to add bots' }));
      }
    });
    return;
  }

  // 8. Static file serving (client build)
  if ((req.method === 'GET' || req.method === 'HEAD') && serveStaticFile(url.pathname, req.method, res)) {
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

setupWebSocket(server);

server.listen(config.port, config.host, () => {
  logger.info(
    { port: config.port, host: config.host, env: config.nodeEnv, gitSha: config.gitSha },
    'server.started',
  );
  console.log(`Server is running on http://${config.host}:${config.port}`);
});

// Periodic memory and metrics update (every 10s)
const metricsInterval = setInterval(() => {
  updateRuntimeMetrics(roomManager.roomCount(), roomManager.playerCount());
}, 10000);
metricsInterval.unref();

// Graceful shutdown logic
export function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  setShuttingDown(true);

  logger.info({ signal }, 'server.shutdown: starting graceful shutdown');
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  // Force exit safety timer (supervisor max grace window, 8 seconds)
  const forceExitTimeout = setTimeout(() => {
    logger.warn('server.shutdown: forced shutdown after timeout');
    console.warn('Forced shutdown timeout reached. Exiting.');
    process.exit(0);
  }, 8000);
  forceExitTimeout.unref();

  // Close HTTP server to stop accepting new requests
  server.close(() => {
    logger.info('server.shutdown: HTTP server closed');
  });

  // Notify and close all WebSockets with code 1001 (Going Away)
  closeAllWebSockets();

  // Stop all running room game loops
  roomManager.closeAll();

  // Flush and exit cleanly
  setTimeout(() => {
    clearTimeout(forceExitTimeout);
    logger.info('server.shutdown: finished cleanly, exiting with code 0');
    console.log('Server shutdown complete. Exiting.');
    process.exit(0);
  }, 200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Crash on unknowns: log error stack and exit non-zero
process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err: err?.stack || String(err) }, 'process.uncaughtException');
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ reason: reason instanceof Error ? reason.stack : String(reason) }, 'process.unhandledRejection');
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});
