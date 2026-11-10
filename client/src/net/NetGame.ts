import {
  DT, TICK_MS, WORLD_W, WORLD_H, SHIP_RADIUS, BULLET_RADIUS, SHIP_MAX_HP,
  binaryCodec, jsonCodec, simSelfTest, asEntityId,
  type Codec, type Snapshot, type ShipSnapshot, type BulletSnapshot, type AsteroidSnapshot,
  type EntitySnapshot, type WelcomeMessage, type EntityId,
} from 'shared';
import { Predictor } from './predictor.ts';
import { Interpolator } from './interpolator.ts';
import { NetStats } from './NetStats.ts';
import { createInput, type KeyState } from '../input.ts';
import { eventBus } from '../events.ts';
import type { Connection } from '../connection.ts';
import type { LoadedAssets } from '../assets/loader.ts';
import { ParticleSystem } from '../particles.ts';

const PRESETS: Record<string, { lat: number; jitter: number; drop: number }> = {
  '1': { lat: 0, jitter: 0, drop: 0 },
  '2': { lat: 100, jitter: 0, drop: 0 },
  '3': { lat: 100, jitter: 30, drop: 0.02 },
};
const PING_EVERY_MS = 1000;
const COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ba68c8'];

export class NetGame {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly connection: Connection;
  assets: LoadedAssets | null = null;

  readonly predictor: Predictor;
  readonly interp: Interpolator;
  readonly stats: NetStats;
  readonly particles: ParticleSystem = new ParticleSystem(500);
  interpDelay: number;
  codecName: 'json' | 'binary';
  net: { lat: number; jitter: number; drop: number };
  showGraph: boolean = true;
  players: Map<number, string> = new Map();
  welcome: WelcomeMessage | null = null;
  lastTick: number = 0;
  sentAt: Map<number, number> = new Map();
  ackLag: number = 0;
  disconnected: boolean = false;

  getInput: (() => KeyState) | null = null;
  accumulator: number = 0;
  lastFrame: number = 0;
  nextPing: number = 0;
  running: boolean = false;

  constructor({ canvas, connection }: { canvas: HTMLCanvasElement; connection: Connection }) {
    const params = new URLSearchParams(window.location.search);
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');
    this.ctx = ctx;
    this.connection = connection;

    this.predictor = new Predictor({ enabled: params.get('predict') !== '0' });
    this.interp = new Interpolator();
    this.stats = new NetStats();
    this.interpDelay = Number(params.get('interp') ?? 100);
    this.codecName = params.get('codec') === 'json' ? 'json' : 'binary';
    this.net = {
      lat: Number(params.get('lat') ?? 0),
      jitter: Number(params.get('jitter') ?? 0),
      drop: Number(params.get('drop') ?? 0),
    };

    connection.onTraffic = (dir, bytes) => this.stats.traffic(dir, bytes);
    connection.onClose = () => {
      this.disconnected = true;
      this.welcome = null;
    };
    connection.on('welcome', (m) => {
      this.welcome = m;
      this.predictor.myId = asEntityId(m.id);
      this.codecName = m.codec;
      if (m.net && typeof m.net === 'object') {
        const netObj = m.net;
        this.net = {
          lat: 'lat' in netObj && typeof netObj.lat === 'number' ? netObj.lat : this.net.lat,
          jitter: 'jitter' in netObj && typeof netObj.jitter === 'number' ? netObj.jitter : this.net.jitter,
          drop: 'drop' in netObj && typeof netObj.drop === 'number' ? netObj.drop : this.net.drop,
        };
      }
    });
    connection.on('players', (m) => {
      this.players = new Map(m.players.map((p) => [p.id, p.name]));
      const rosterEl = document.getElementById('roster');
      if (rosterEl) {
        rosterEl.textContent = `🛸 Пілоти (${m.players.length}/8): ` + m.players.map((p) => p.name).join(', ');
      }
      const botsBtn = document.getElementById('add-bots-btn') as HTMLButtonElement | null;
      if (botsBtn) {
        if (m.players.length >= 8) {
          botsBtn.disabled = true;
          botsBtn.textContent = '🤖 Макс. (8/8)';
        } else {
          botsBtn.disabled = false;
          botsBtn.textContent = '🤖 +1 Бот';
        }
      }
    });
    connection.on('chat', (m) => {
      const chatBox = document.getElementById('chat-messages');
      if (chatBox) {
        const line = document.createElement('div');
        line.className = 'chat-line';
        line.textContent = `${m.sender}: ${m.text}`;
        chatBox.appendChild(line);
        chatBox.scrollTop = chatBox.scrollHeight;
      }
      const win = window as unknown as { __chatMessages?: unknown[] };
      win.__chatMessages?.push(m);
    });
    connection.on('config', (m) => {
      if (m.net && typeof m.net === 'object') {
        const netObj = m.net;
        this.net = {
          lat: 'lat' in netObj && typeof netObj.lat === 'number' ? netObj.lat : this.net.lat,
          jitter: 'jitter' in netObj && typeof netObj.jitter === 'number' ? netObj.jitter : this.net.jitter,
          drop: 'drop' in netObj && typeof netObj.drop === 'number' ? netObj.drop : this.net.drop,
        };
      }
      this.codecName = m.codec;
    });
    connection.on('pong', (m) => this.stats.onPong(m.t));
    connection.on('snapshot', (snap) => this.onSnapshot(snap));
    window.simSelfTest = simSelfTest;
    const win = window as unknown as { __netGame?: NetGame; __chatMessages?: unknown[] };
    win.__netGame = this;
    win.__chatMessages = [];
  }

  get codec(): Codec {
    return this.codecName === 'json' ? jsonCodec : binaryCodec;
  }

  get opponentPosition(): { x: number; y: number } | null {
    const world = this.interp.sample(performance.now(), this.interpDelay);
    if (!world) return null;
    const opp = world.ships.find((s) => s.id !== this.predictor.myId);
    return opp ? { x: opp.x, y: opp.y } : null;
  }

  onSnapshot(snap: Snapshot): void {
    const now = performance.now();
    this.stats.lastSnapshotAt = now;
    if (!this.interp.push(snap, now)) return;
    this.lastTick = snap.tick;
    performance.mark('reconcile:start');
    this.predictor.onSnapshot(snap);
    performance.mark('reconcile:end');
    try {
      performance.measure('reconcile', 'reconcile:start', 'reconcile:end');
    } catch {}
    const sent = this.sentAt.get(snap.ack);
    if (sent !== undefined) this.ackLag = now - sent;
    for (const seq of this.sentAt.keys()) {
      if (seq <= snap.ack) this.sentAt.delete(seq);
    }
    this.stats.pushHistory('correction', this.predictor.correction);
  }

  start(assets: LoadedAssets): void {
    if (this.running) return;
    this.running = true;
    this.assets = assets;
    this.getInput = createInput();
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.fitCanvas();
    window.addEventListener('resize', () => this.fitCanvas());
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  fitCanvas(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  sendConfig(extra?: Record<string, unknown>): void {
    this.connection.send({ type: 'config', ...this.net, codec: this.codecName, ...extra });
  }

  onKey(e: KeyboardEvent): void {
    if (e.repeat || document.activeElement?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'p') {
      this.predictor.enabled = !this.predictor.enabled;
      this.predictor.localBullets = [];
    } else if (k === '[') {
      this.interpDelay = Math.max(0, this.interpDelay - 16);
    } else if (k === ']') {
      this.interpDelay = Math.min(500, this.interpDelay + 16);
    } else if (k === 'n') {
      this.showGraph = !this.showGraph;
    } else if (k === 'b') {
      this.codecName = this.codecName === 'json' ? 'binary' : 'json';
      this.sendConfig({ codec: this.codecName });
    } else if (k in PRESETS) {
      const p = PRESETS[k];
      if (p) {
        this.net = p;
        this.sendConfig(p);
      }
    }
  }

  frame(now: number): void {
    const frameSec = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    this.accumulator += frameSec;

    performance.mark('simulate:start');
    while (this.accumulator >= DT) {
      this.simStep();
      this.accumulator -= DT;
    }
    this.predictor.decay(frameSec * 1000);
    this.particles.update(frameSec);
    performance.mark('simulate:end');
    try {
      performance.measure('simulate', 'simulate:start', 'simulate:end');
    } catch {}

    if (now >= this.nextPing) {
      this.nextPing = now + PING_EVERY_MS;
      this.connection.send({ type: 'ping', t: now });
    }

    performance.mark('render:start');
    this.render(now);
    performance.mark('render:end');
    try {
      performance.measure('render', 'render:start', 'render:end');
    } catch {}

    requestAnimationFrame((t) => this.frame(t));
  }

  simStep(): void {
    if (!this.welcome || !this.getInput) return;
    const keys = this.getInput();
    const turnVal = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    const turn = turnVal === -1 ? -1 : turnVal === 1 ? 1 : 0;
    const input = this.predictor.nextInput({
      thrust: keys.w ? 1 : 0,
      turn,
      fire: keys.space ? 1 : 0,
    });
    this.sentAt.set(input.seq, performance.now());
    if (this.sentAt.size > 300) {
      const first = this.sentAt.keys().next().value;
      if (first !== undefined) this.sentAt.delete(first);
    }
    const own = this.predictor.ship;
    if (this.predictor.applyLocal(input)) {
      eventBus.emit('fired', undefined);
      if (own) {
        const fx = own.x + Math.cos(own.angle) * SHIP_RADIUS;
        const fy = own.y + Math.sin(own.angle) * SHIP_RADIUS;
        this.particles.emit(fx, fy, 4, '#ffff00');
      }
    }
    if (keys.w && own) {
      const ex = own.x - Math.cos(own.angle) * SHIP_RADIUS;
      const ey = own.y - Math.sin(own.angle) * SHIP_RADIUS;
      this.particles.emit(ex, ey, 2, '#ffab40');
    }
    this.connection.sendRaw(this.codec.encodeInput(input));
  }

  // Exhaustive dispatch on entity kind
  renderEntity(entity: EntitySnapshot, label?: string): void {
    switch (entity.kind) {
      case 'ship':
        this.drawShip(entity, this.colorOf(entity.id), label);
        break;
      case 'bullet':
        this.drawBullet(entity, '#ffd54f');
        break;
      case 'asteroid':
        this.drawAsteroid(entity);
        break;
      default: {
        const _exhaustive: never = entity;
        throw new Error(`Unhandled entity: ${String(_exhaustive)}`);
      }
    }
  }

  render(now: number): void {
    const { ctx, canvas } = this;
    const scale = Math.min(canvas.width / WORLD_W, canvas.height / WORLD_H);
    const ox = (canvas.width - WORLD_W * scale) / 2;
    const oy = (canvas.height - WORLD_H * scale) / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    const world = this.interp.sample(now, this.interpDelay);
    const me = this.predictor.myId;
    if (world) {
      for (const a of world.asteroids) this.drawAsteroid(a);
      const mine = this.predictor.enabled;
      for (const b of world.bullets) {
        if (mine && b.owner === me) continue;
        this.drawBullet(b, '#ffd54f');
      }
      for (const s of world.ships) {
        if (s.id === me || s.respawn > 0) continue;
        this.drawShip(s, this.colorOf(s.id), this.players.get(s.id) ?? `Bot #${s.id}`);
      }
    }
    for (const b of this.predictor.localBullets) this.drawBullet(b, '#fff59d');

    const own = this.predictor.visual();
    if (own && own.respawn === 0) this.drawShip(own, this.colorOf(me), 'you');

    this.particles.render(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawHud(own, now);
  }

  colorOf(id: number): string {
    return COLORS[(id >>> 0) % COLORS.length] ?? '#4fc3f7';
  }

  drawShip(s: { x: number; y: number; angle: number }, color: string, label?: string): void {
    const { ctx } = this;
    const img = this.assets?.sprites['ship'];
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    if (img) {
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(SHIP_RADIUS, 0);
      ctx.lineTo(-SHIP_RADIUS, -SHIP_RADIUS * 0.7);
      ctx.lineTo(-SHIP_RADIUS, SHIP_RADIUS * 0.7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    if (img) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, SHIP_RADIUS + 3, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (label) ctx.fillText(label, s.x, s.y - SHIP_RADIUS - 8);
  }

  drawAsteroid(a: AsteroidSnapshot | { x: number; y: number; radius: number }): void {
    const { ctx } = this;
    const img = this.assets?.sprites['asteroid'];
    if (img) {
      const f = (a.radius * 2) / img.width;
      ctx.drawImage(img, a.x - a.radius, a.y - (img.height * f) / 2, img.width * f, img.height * f);
    } else {
      ctx.fillStyle = 'gray';
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawBullet(b: BulletSnapshot | { x: number; y: number }, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_RADIUS + 1, 0, Math.PI * 2);
    ctx.fill();
  }

  drawHud(own: { hp: number; respawn: number } | null, now: number): void {
    const { ctx, stats, predictor } = this;
    ctx.fillStyle = 'white';
    ctx.font = '16px monospace';
    ctx.textAlign = 'left';
    const hp = own ? own.hp : SHIP_MAX_HP;
    ctx.fillText(
      own && own.respawn > 0
        ? `HP: 0  respawn in ${((own.respawn * TICK_MS) / 1000).toFixed(1)}s`
        : `HP: ${hp}`,
      20,
      30,
    );
    ctx.fillStyle = '#9e9e9e';
    ctx.font = '12px monospace';
    const sha = typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__.slice(0, 7) : 'dev';
    const ver = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v1.0.0';
    ctx.fillText(`Dogfight ${ver} (${sha}) | W/A/D or arrows + Space | P predict [ ] interp B codec N netgraph`, 20, 48);

    if (this.disconnected || stats.snapshotAge(now) > 2000) {
      ctx.fillStyle = '#ff5252';
      ctx.font = '20px monospace';
      ctx.fillText('Зв\u0027язок із сервером втрачено — перезавантажте сторінку (F5)', 20, 90);
    }

    if (!this.showGraph) return;
    const lines = [
      `RTT          ${stats.rtt.toFixed(0)} ms (avg ${stats.rttAvg.toFixed(0)})`,
      `snapshot age ${stats.snapshotAge(now).toFixed(0)} ms   tick ${this.lastTick}`,
      `down / up    ${stats.bytesPerSec('in', now)} / ${stats.bytesPerSec('out', now)} B/s`,
      `input queue  ${predictor.pending.length} unacked`,
      `input->ack   ${this.ackLag.toFixed(0)} ms`,
      `ship reacts  ${predictor.enabled ? '0 ms (predicted)' : `after ${this.ackLag.toFixed(0)} ms`}`,
      `correction   ${predictor.correction.toFixed(2)} px (avg ${predictor.correctionAvg.toFixed(2)})`,
      `interp delay ${this.interpDelay} ms   starved ${this.interp.starved}`,
      `predict ${predictor.enabled ? 'ON' : 'OFF'}   codec ${this.codecName}`,
      `net  lat ${this.net.lat} jitter ${this.net.jitter} drop ${(this.net.drop * 100).toFixed(0)}%`,
    ];
    const x = this.canvas.width - 300;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 10, 10, 300, 20 + lines.length * 16 + 50);
    ctx.fillStyle = '#b2ff59';
    ctx.font = '12px monospace';
    lines.forEach((l, i) => {
      ctx.fillText(l, x, 28 + i * 16);
    });
    this.drawSpark(stats.history.correction, x, 28 + lines.length * 16 + 4, 280, 36, 10, '#ff5252');
  }

  drawSpark(values: number[], x: number, y: number, w: number, h: number, maxValue: number, color: string): void {
    const { ctx } = this;
    ctx.strokeStyle = '#333';
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.beginPath();
    values.forEach((v, i) => {
      const px = x + (i / 119) * w;
      const py = y + h - Math.min(1, v / maxValue) * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
}
