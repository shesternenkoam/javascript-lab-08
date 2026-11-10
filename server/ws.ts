import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  TICK_RATE, WORLD_W, WORLD_H,
  parseClientMessage, sanitizeInput, asEntityId, TokenBucket,
  type ClientMessage, type JoinMessage,
  type PingMessage, type ConfigMessage, type ChatMessage,
} from 'shared';
import { roomManager, type Room, type Player } from './rooms.ts';
import { LinkSim } from './netsim.ts';
import { config } from './config.ts';
import { logger, getRoomLogger } from './logger.ts';
import {
  messagesReceivedCounter,
  messagesSentCounter,
  bytesReceivedCounter,
  bytesSentCounter,
  rejectedConnectionsCounter,
  updateRuntimeMetrics,
} from './metrics.ts';

let shuttingDown = false;
const activeSockets = new Set<WebSocket>();
const ipConnections = new Map<string, number>();

export function setShuttingDown(val: boolean): void {
  shuttingDown = val;
}

export function closeAllWebSockets(): void {
  logger.info({ openSockets: activeSockets.size }, 'ws.shutdown: closing all sockets with 1001');
  for (const socket of activeSockets) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', error: 'Server shutting down' }));
        socket.close(1001, 'Server shutting down');
      } else {
        socket.terminate();
      }
    } catch (_err) {
      // ignore during shutdown
    }
  }
  activeSockets.clear();
}

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, callback) => {
      if (shuttingDown) {
        callback(false, 503, 'Server shutting down');
        return;
      }

      // 1. Origin verification
      const originHeader = info.origin || (info.req.headers['origin'] as string) || '';
      if (!config.allowedOrigins.includes('*')) {
        let allowed = false;
        if (originHeader) {
          try {
            const originUrl = new URL(originHeader);
            const originNormalized = `${originUrl.protocol}//${originUrl.host}`.toLowerCase();
            allowed = config.allowedOrigins.some(
              (ao) => ao === originNormalized || ao === originUrl.host.toLowerCase() || ao === originHeader.toLowerCase(),
            );
          } catch {
            allowed = config.allowedOrigins.includes(originHeader.toLowerCase());
          }
        } else {
          // If no origin header (e.g. non-browser CLI or test), check Host header
          const hostHeader = info.req.headers['host'];
          if (hostHeader) {
            allowed = config.allowedOrigins.some((ao) => ao.includes(hostHeader.toLowerCase()));
          }
        }

        if (!allowed) {
          logger.warn({ origin: originHeader, reason: 'forbidden_origin' }, 'ws.rejected: forbidden_origin');
          rejectedConnectionsCounter.inc({ reason: 'forbidden_origin' });
          callback(false, 403, 'Forbidden origin');
          return;
        }
      }

      // 2. IP Connection Limit
      const ip =
        (info.req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        info.req.socket.remoteAddress ||
        'unknown';
      const currentIpCount = ipConnections.get(ip) || 0;
      if (currentIpCount >= config.maxConnectionsPerIp) {
        logger.warn(
          { ip, currentIpCount, limit: config.maxConnectionsPerIp, reason: 'ip_limit' },
          'ws.rejected: ip_limit',
        );
        rejectedConnectionsCounter.inc({ reason: 'ip_limit' });
        callback(false, 429, 'Too many connections from this IP');
        return;
      }

      callback(true);
    },
  });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    activeSockets.add(socket);
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    ipConnections.set(clientIp, (ipConnections.get(clientIp) || 0) + 1);

    updateRuntimeMetrics(roomManager.roomCount(), activeSockets.size);

    let currentRoom: Room | null = null;
    let currentPlayer: Player | null = null;
    const codec: 'json' | 'binary' = 'binary';
    const link = new LinkSim();

    // Lab 4 rate limit: 40 max burst, 30 refill/sec
    const rateLimiter = new TokenBucket(40, 30, Date.now());

    // Join timeout (10 seconds)
    const joinTimeout = setTimeout(() => {
      if (!currentPlayer && socket.readyState === WebSocket.OPEN) {
        logger.warn({ ip: clientIp, reason: 'join_timeout' }, 'ws.rejected: join_timeout');
        rejectedConnectionsCounter.inc({ reason: 'join_timeout' });
        socket.close(1008, 'Join timeout');
      }
    }, 10000);

    const sendJson = (msg: { type: string; [key: string]: unknown }): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      link.deliver(() => {
        if (socket.readyState === WebSocket.OPEN) {
          const payload = JSON.stringify(msg);
          const bytes = Buffer.byteLength(payload);
          messagesSentCounter.inc({ type: msg.type });
          bytesSentCounter.inc(bytes);
          socket.send(payload);
          if (currentPlayer) currentPlayer.bytesOut += bytes;
        }
      });
    };

    const broadcastPlayers = (): void => {
      if (!currentRoom) return;
      const players = [...currentRoom.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        score: 0,
      }));
      for (const p of currentRoom.players.values()) {
        p.sendJson({ type: 'players', players });
      }
    };

    const handleInput = (msg: { seq: number; thrust: number; turn: number; fire: number }): void => {
      if (!currentPlayer || !currentRoom) return;
      const input = sanitizeInput(msg);
      if (!input) {
        currentRoom.match.stats.invalidInputs++;
        return;
      }
      currentRoom.match.receiveInput(currentPlayer, input);
    };

    const handleJoin = (msg: JoinMessage): void => {
      if (currentPlayer) return;
      clearTimeout(joinTimeout);

      let room: Room;
      try {
        room = roomManager.get(msg.room) ?? roomManager.create(msg.room);
      } catch (_err) {
        rejectedConnectionsCounter.inc({ reason: 'room_limit' });
        socket.close(1008, 'Server room limit reached');
        return;
      }

      if (room.players.size >= config.maxPlayersPerRoom) {
        logger.warn({ roomId: msg.room, reason: 'room_full' }, 'ws.rejected: room_full');
        rejectedConnectionsCounter.inc({ reason: 'room_full' });
        socket.close(1008, 'Room full');
        return;
      }
      currentRoom = room;

      let name = msg.name.slice(0, 24);
      const taken = new Set([...currentRoom.players.values()].map((p) => p.name));
      for (let n = 2; taken.has(name); n++) {
        name = `${msg.name.slice(0, 20)} (${n})`;
      }

      currentPlayer = {
        id: asEntityId(0),
        name,
        socket,
        link,
        codec,
        queue: [],
        lastSeq: 0,
        ack: 0,
        bytesIn: 0,
        bytesOut: 0,
        sendJson,
        sendRaw(data: string | Uint8Array): void {
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1 << 20) return;
          link.deliver(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
            messagesSentCounter.inc({ type: 'snapshot' });
            bytesSentCounter.inc(bytes);
            socket.send(data, { binary: typeof data !== 'string' });
            if (currentPlayer) {
              currentPlayer.bytesOut += bytes;
            }
          });
        },
      };

      const ship = currentRoom.match.addPlayer(currentPlayer);
      currentRoom.emit('join', currentPlayer);

      const roomLog = getRoomLogger(msg.room, ship.id);
      roomLog.info({ name, ip: clientIp }, 'player.joined_room');

      sendJson({
        type: 'welcome',
        id: ship.id,
        seed: currentRoom.match.seed,
        tickRate: TICK_RATE,
        world: { w: WORLD_W, h: WORLD_H },
        codec,
        net: link.settings,
      });
      broadcastPlayers();
      updateRuntimeMetrics(roomManager.roomCount(), activeSockets.size);
    };

    const handlePing = (msg: PingMessage): void => {
      sendJson({ type: 'pong', t: msg.t });
    };

    const handleConfig = (msg: ConfigMessage): void => {
      link.set(msg);
      if (currentPlayer && (msg.codec === 'json' || msg.codec === 'binary')) {
        currentPlayer.codec = msg.codec;
      }
      sendJson({ type: 'config', net: link.settings, codec: currentPlayer?.codec ?? codec });
    };

    const handleChat = (msg: ChatMessage): void => {
      if (!currentRoom || !currentPlayer) return;
      const chatEvent = {
        type: 'chat',
        sender: currentPlayer.name,
        text: msg.text,
      };
      for (const p of currentRoom.players.values()) {
        p.sendJson(chatEvent);
      }
    };

    const dispatchClientMessage = (msg: ClientMessage): void => {
      switch (msg.type) {
        case 'input':
          handleInput(msg);
          break;
        case 'join':
          handleJoin(msg);
          break;
        case 'ping':
          handlePing(msg);
          break;
        case 'config':
          handleConfig(msg);
          break;
        case 'chat':
          handleChat(msg);
          break;
        default: {
          const _exhaustive: never = msg;
          throw new Error(`Unhandled message: ${String(_exhaustive)}`);
        }
      }
    };

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const byteLen = Array.isArray(data)
        ? data.reduce((acc, b) => acc + b.length, 0)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : data.length;

      bytesReceivedCounter.inc(byteLen);

      // 1. Max payload limit: 1024 bytes
      if (byteLen > 1024) {
        logger.warn({ ip: clientIp, byteLen, reason: 'too_large' }, 'ws.rejected: message_too_large');
        rejectedConnectionsCounter.inc({ reason: 'too_large' });
        socket.close(1009, 'Message too large');
        return;
      }

      // 2. Rate limiter check (TokenBucket 40 burst, 30 refill/s)
      if (!rateLimiter.consume(1, Date.now())) {
        logger.warn({ ip: clientIp, reason: 'rate_limit' }, 'ws.rejected: rate_limit_exceeded');
        rejectedConnectionsCounter.inc({ reason: 'rate_limit' });
        socket.close(1008, 'Rate limit exceeded');
        return;
      }

      link.deliver(() => {
        try {
          const payload: string | Uint8Array = isBinary
            ? data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : Array.isArray(data)
                ? Buffer.concat(data)
                : data
            : data.toString();

          const result = parseClientMessage(payload);
          if (!result.ok) {
            logger.warn({ ip: clientIp, error: result.error, reason: 'invalid_msg' }, 'ws.rejected: invalid_msg');
            rejectedConnectionsCounter.inc({ reason: 'invalid_msg' });
            socket.close(1003, 'Invalid message');
            return;
          }

          const msg = result.value;
          messagesReceivedCounter.inc({ type: msg.type });
          if (currentPlayer) currentPlayer.bytesIn += byteLen;

          if (msg.type === 'input') {
            handleInput(msg);
            return;
          }

          dispatchClientMessage(msg);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ ip: clientIp, error: errMsg, reason: 'processing_error' }, 'ws.error');
          rejectedConnectionsCounter.inc({ reason: 'invalid_msg' });
          socket.close(1003, 'Invalid message');
        }
      });
    });

    socket.on('close', () => {
      clearTimeout(joinTimeout);
      link.close();
      activeSockets.delete(socket);

      const rem = (ipConnections.get(clientIp) || 1) - 1;
      if (rem <= 0) ipConnections.delete(clientIp);
      else ipConnections.set(clientIp, rem);

      if (currentRoom && currentPlayer) {
        currentRoom.match.removePlayer(currentPlayer);
        broadcastPlayers();
        if (currentRoom.players.size === 0) {
          currentRoom.emit('empty');
        }
      }

      logger.info({ ip: clientIp, remainingSockets: activeSockets.size }, 'ws.closed');
      updateRuntimeMetrics(roomManager.roomCount(), activeSockets.size);
    });
  });

  return wss;
}
