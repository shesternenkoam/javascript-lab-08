import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { EntityId, PlayerInput, Seq, World } from 'shared';
import { createMatchLogStream, type MatchLogStream } from './log/matchlog.ts';
import { Match } from './match.ts';
import type { LinkSim } from './netsim.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';

export interface Player {
  id: EntityId;
  name: string;
  socket: WebSocket;
  link: LinkSim;
  codec: 'json' | 'binary';
  queue: PlayerInput[];
  lastSeq: number;
  ack: number | Seq;
  bytesIn: number;
  bytesOut: number;
  isBot?: boolean;
  think?(world: World): void;
  sendJson(msg: unknown): void;
  sendRaw(data: string | Uint8Array): void;
}

export interface RoomEvents {
  join: [player: Player];
  leave: [player: Player];
  empty: [];
}

export class Room extends EventEmitter {
  readonly id: string;
  readonly players: Map<EntityId | number, Player>;
  readonly logger: MatchLogStream | null;
  readonly match: Match;

  constructor(id: string) {
    super();
    this.id = id;
    this.players = new Map();
    // In production, file logging is disabled (Pino handles stdout logging).
    this.logger = process.env['NODE_ENV'] === 'production' ? null : createMatchLogStream(id);
    this.logger?.pipeToFile();
    this.match = new Match(this);
  }
}

class RoomManager {
  private readonly rooms: Map<string, Room> = new Map();

  create(id: string): Room {
    const existing = this.rooms.get(id);
    if (existing) return existing;

    if (this.rooms.size >= config.maxRooms) {
      logger.warn({ roomId: id, currentRooms: this.rooms.size, maxRooms: config.maxRooms }, 'room.limit_reached');
      throw new Error('Server room limit reached');
    }

    const room = new Room(id);
    this.rooms.set(id, room);

    logger.info({ roomId: id, activeRooms: this.rooms.size }, 'room.created');
    room.logger?.write({ event: 'room_created', roomId: id });

    const idleCreateTimer = setTimeout(() => {
      const hasHumans = [...room.players.values()].some((p) => !p.isBot);
      if (!hasHumans && this.rooms.has(id)) {
        room.emit('empty');
      }
    }, 30000);

    room.on('join', (player: Player) => {
      clearTimeout(idleCreateTimer);
      logger.info({ roomId: id, playerId: player.id, name: player.name }, 'player.joined');
      room.logger?.write({ event: 'player_joined', player: player.name });
    });

    room.once('empty', () => {
      clearTimeout(idleCreateTimer);
      room.match.stop();
      room.players.clear();
      logger.info({ roomId: id }, 'room.destroyed');
      room.logger?.write({ event: 'room_empty_destroyed' });
      room.logger?.close();
      this.rooms.delete(id);
    });

    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  playerCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      count += room.players.size;
    }
    return count;
  }

  closeAll(): void {
    for (const [id, room] of this.rooms.entries()) {
      room.match.stop();
      room.logger?.close();
      this.rooms.delete(id);
    }
  }

  stats(): Record<string, unknown>[] {
    return Array.from(this.rooms.values()).map((room) => room.match.summary());
  }

  list(): Array<{ id: string; name: string; players: number }> {
    return Array.from(this.rooms.values()).map((room) => ({
      id: room.id,
      name: room.id,
      players: room.players.size,
    }));
  }
}

export const roomManager: RoomManager = new RoomManager();
