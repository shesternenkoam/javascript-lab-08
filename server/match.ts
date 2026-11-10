import { randomInt } from 'node:crypto';
import {
  TICK_MS, TICK_RATE, MAX_PENDING_INPUTS,
  createWorld, addShip, removeShip, stepWorld, binaryCodec, jsonCodec, patchSnapshotAck,
  type World, type Ship, type PlayerInput, type InputMap,
} from 'shared';
import type { Room, Player } from './rooms.ts';
import { Bot } from './bot.ts';
import { config } from './config.ts';
import { tickDurationHistogram } from './metrics.ts';

const OVERRUN_RESYNC_TICKS = 5;

export interface MatchStats {
  ticks: number;
  starved: number;
  overruns: number;
  droppedInputs: number;
  invalidInputs: number;
  tickMsAvg: number;
  tickMsMax: number;
  jitterMsAvg: number;
  jitterMsMax: number;
}

export class Match {
  readonly room: Room;
  readonly seed: number;
  readonly world: World;
  private timer: NodeJS.Timeout | null = null;
  running: boolean = false;
  private nextTick: number = 0;
  readonly stats: MatchStats = {
    ticks: 0, starved: 0, overruns: 0, droppedInputs: 0, invalidInputs: 0,
    tickMsAvg: 0, tickMsMax: 0, jitterMsAvg: 0, jitterMsMax: 0,
  };

  constructor(room: Room) {
    this.room = room;
    this.seed = randomInt(0, 2 ** 32);
    this.world = createWorld(this.seed);
  }

  get players(): Map<number, Player> {
    return this.room.players;
  }

  addPlayer(player: Player): Ship {
    const ship = addShip(this.world);
    player.id = ship.id;
    player.queue = [];
    player.lastSeq = 0;
    player.ack = 0;
    player.bytesIn = 0;
    player.bytesOut = 0;
    this.players.set(player.id, player);
    this.start();
    return ship;
  }

  addBots(count: number): Bot[] {
    const bots: Bot[] = [];
    const availableSlots = Math.max(0, config.maxPlayersPerRoom - this.players.size);
    const toSpawn = Math.min(count, availableSlots);
    const existingBots = [...this.players.values()].filter((p) => p.isBot).length;
    for (let i = 0; i < toSpawn; i++) {
      const bot = new Bot(`Bot_${existingBots + i + 1}`);
      this.addPlayer(bot);
      bots.push(bot);
    }
    return bots;
  }

  removePlayer(player: Player): void {
    removeShip(this.world, player.id);
    this.players.delete(player.id);
  }

  receiveInput(player: Player, input: PlayerInput): void {
    if (input.seq <= player.lastSeq) return;
    player.lastSeq = input.seq;
    player.queue.push(input);
    while (player.queue.length > MAX_PENDING_INPUTS) {
      player.queue.shift();
      this.stats.droppedInputs++;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTick = performance.now() + TICK_MS;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.tick(), Math.max(0, this.nextTick - performance.now()));
  }

  private tick(): void {
    if (!this.running) return;
    const started = performance.now();
    const s = this.stats;
    const lateBy = Math.max(0, started - this.nextTick);
    s.jitterMsAvg += (lateBy - s.jitterMsAvg) * 0.05;
    s.jitterMsMax = Math.max(s.jitterMsMax, lateBy);

    const inputs: InputMap = {};
    for (const p of this.players.values()) {
      if (p.think) {
        p.think(this.world);
      }
      const input = p.queue.shift();
      if (input) {
        inputs[p.id] = input;
        p.ack = input.seq;
      } else {
        s.starved++;
      }
    }
    stepWorld(this.world, inputs);
    this.broadcast();

    const took = performance.now() - started;
    tickDurationHistogram.observe(took);
    s.ticks++;
    s.tickMsAvg += (took - s.tickMsAvg) * 0.05;
    s.tickMsMax = Math.max(s.tickMsMax, took);

    this.nextTick += TICK_MS;
    const now = performance.now();
    if (now > this.nextTick + OVERRUN_RESYNC_TICKS * TICK_MS) {
      s.overruns++;
      this.nextTick = now + TICK_MS;
    }
    this.schedule();
  }

  private broadcast(): void {
    let binaryBase: Uint8Array | null = null;
    for (const p of this.players.values()) {
      let data: string | Uint8Array;
      if (p.codec === 'json') {
        data = jsonCodec.encodeSnapshot(this.world, p.ack);
      } else {
        if (!binaryBase) {
          binaryBase = binaryCodec.encodeSnapshot(this.world, 0);
        }
        data = patchSnapshotAck(binaryBase, p.ack);
      }
      p.sendRaw(data);
    }
  }

  summary(): Record<string, unknown> {
    const { stats } = this;
    const roundedStats = Object.fromEntries(
      Object.entries(stats).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]),
    );
    return {
      room: this.room.id,
      players: this.players.size,
      tickRate: TICK_RATE,
      tick: this.world.tick,
      seed: this.seed,
      ...roundedStats,
    };
  }
}
