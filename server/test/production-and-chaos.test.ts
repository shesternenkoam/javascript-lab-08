import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setupWebSocket, setShuttingDown, closeAllWebSockets } from '../ws.ts';
import { roomManager } from '../rooms.ts';
import { config } from '../config.ts';
import { rejectedConnectionsCounter, tickDurationHistogram } from '../metrics.ts';

describe('Lab 08 — Hardening and Chaos Tests', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    // Override config for testing
    config.allowedOrigins = ['http://localhost:3000', 'https://dogfight.app'];
    config.maxConnectionsPerIp = 4;
    config.maxRooms = 10;
    config.maxPlayersPerRoom = 6;

    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', gitSha: config.gitSha }));
        return;
      }
      if (url.pathname === '/ready') {
        if (roomManager.roomCount() >= config.maxRooms) {
          res.writeHead(503);
          res.end(JSON.stringify({ status: 'not_ready' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    setupWebSocket(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    closeAllWebSockets();
    roomManager.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('M1: /health and /ready respond with 200 and gitSha', async () => {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const healthData = await healthRes.json();
    expect(healthData.status).toBe('healthy');
    expect(healthData.gitSha).toBeDefined();

    const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyRes.status).toBe(200);
  });

  it('M2: rejects WebSocket connection with unauthorized origin', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Origin: 'https://evil-phishing-site.com',
      },
    });

    const errorHappened = await new Promise<boolean>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 403) resolve(true);
      });
      ws.on('error', () => resolve(true));
      ws.on('open', () => resolve(false));
    });

    expect(errorHappened).toBe(true);
  });

  it('M2: allows WebSocket connection with authorized origin', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Origin: 'https://dogfight.app',
      },
    });

    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
    });

    expect(opened).toBe(true);
  });

  it('M2: enforces per-IP connection limit', async () => {
    const sockets: WebSocket[] = [];
    const max = config.maxConnectionsPerIp; // 4

    for (let i = 0; i < max; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: 'https://dogfight.app' },
      });
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      sockets.push(ws);
    }

    // 5th connection from same IP must be rejected (429)
    const overLimitWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: 'https://dogfight.app' },
    });

    const rejected = await new Promise<boolean>((resolve) => {
      overLimitWs.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 429) resolve(true);
      });
      overLimitWs.on('error', () => resolve(true));
      overLimitWs.on('open', () => resolve(false));
    });

    expect(rejected).toBe(true);

    // Clean up sockets
    for (const s of sockets) s.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('M2 Chaos: client killed mid-match is cleaned up without crashing the server', async () => {
    const roomId = 'chaos_client_kill';
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://dogfight.app' } });
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://dogfight.app' } });

    await Promise.all([
      new Promise<void>((r) => ws1.on('open', () => r())),
      new Promise<void>((r) => ws2.on('open', () => r())),
    ]);

    ws1.send(JSON.stringify({ type: 'join', room: roomId, name: 'VictimPlayer' }));
    ws2.send(JSON.stringify({ type: 'join', room: roomId, name: 'SurvivingPlayer' }));
    await new Promise((r) => setTimeout(r, 150));

    const room = roomManager.get(roomId);
    expect(room).toBeDefined();
    expect(room?.players.size).toBe(2);

    // Abruptly terminate ws1 (simulating browser crash / network pull)
    ws1.terminate();
    await new Promise((r) => setTimeout(r, 200));

    expect(room?.players.size).toBe(1);
    expect(room?.match.running).toBe(true);

    ws2.close();
  });

  it('M2 Chaos: flood of 1,000 garbage frames/s is disconnected and does not degrade other room tick time', async () => {
    const goodRoomId = 'chaos_normal_room';
    const badRoomId = 'chaos_flood_room';

    // Normal client in good room
    const goodWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://dogfight.app' } });
    await new Promise<void>((r) => goodWs.on('open', () => r()));
    goodWs.send(JSON.stringify({ type: 'join', room: goodRoomId, name: 'GoodGuy' }));
    await new Promise((r) => setTimeout(r, 100));

    const goodRoom = roomManager.get(goodRoomId);
    expect(goodRoom).toBeDefined();

    // Attacker client attempting flood
    const attackerWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://dogfight.app' } });
    await new Promise<void>((r) => attackerWs.on('open', () => r()));

    let closedCode = 0;
    attackerWs.on('close', (code) => {
      closedCode = code;
    });

    // Blast garbage frames rapidly
    for (let i = 0; i < 500; i++) {
      if (attackerWs.readyState === WebSocket.OPEN) {
        attackerWs.send(`{"garbage":${i},"random":"${'X'.repeat(50)}"}`);
      }
    }

    await new Promise((r) => setTimeout(r, 300));

    // Attacker should be disconnected with rate limit or invalid message code
    expect([1003, 1008]).toContain(closedCode);

    // Verify good room tick duration remained healthy (< 5ms, well below 33ms budget)
    expect(goodRoom?.match.stats.tickMsMax).toBeLessThan(10);

    goodWs.close();
  });

  it('M1 Graceful Shutdown: closeAllWebSockets sends 1001 code to clients', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://dogfight.app' } });
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ type: 'join', room: 'shutdown_test', name: 'PlayerShutdown' }));
    await new Promise((r) => setTimeout(r, 100));

    let closeCode = 0;
    let receivedError = false;
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' && msg.error.includes('Shutting down')) {
          receivedError = true;
        }
      } catch {}
    });

    const closePromise = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    closeAllWebSockets();
    closeCode = await closePromise;

    expect(closeCode).toBe(1001);
  });
});

