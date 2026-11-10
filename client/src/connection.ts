import {
  parseServerMessage,
  type ServerMessage,
  type ClientMessage,
  type WelcomeMessage,
  type PlayersMessage,
  type ServerConfigMessage,
  type PongMessage,
  type Snapshot,
  type ServerChatMessage,
} from 'shared';

export type TrafficDirection = 'in' | 'out';

function sendToSocket(socket: WebSocket, data: string | ArrayBuffer | Uint8Array): void {
  socket.send(data as Parameters<WebSocket['send']>[0]); // Justified cast: DOM WebSocket send compatibility
}

export class Connection {
  readonly url: string;
  socket: WebSocket | null = null;
  isConnected: boolean = false;
  private readonly sendQueue: (string | ArrayBuffer | Uint8Array)[] = [];
  private reconnectDelay: number = 1000;
  onOpen: (() => void) | null = null;
  onClose: ((delay: number) => void) | null = null;
  onTraffic: ((dir: TrafficDirection, bytes: number) => void) | null = null;

  private onWelcomeHandler: ((msg: WelcomeMessage) => void) | null = null;
  private onPlayersHandler: ((msg: PlayersMessage) => void) | null = null;
  private onConfigHandler: ((msg: ServerConfigMessage) => void) | null = null;
  private onPongHandler: ((msg: PongMessage) => void) | null = null;
  private onSnapshotHandler: ((msg: Snapshot) => void) | null = null;
  private onChatHandler: ((msg: ServerChatMessage) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  connect(): void {
    console.log(`Connecting to WS: ${this.url}...`);
    this.socket = new WebSocket(this.url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = (): void => {
      console.log('WS Connected');
      this.isConnected = true;
      const wasReconnecting = this.reconnectDelay > 1000;
      this.reconnectDelay = 1000;
      this.onOpen?.();

      while (this.sendQueue.length > 0) {
        const item = this.sendQueue.shift();
        if (item && this.socket) {
          sendToSocket(this.socket, item);
        }
      }
    };

    this.socket.onmessage = (event: MessageEvent): void => {
      try {
        const bytes =
          typeof event.data === 'string'
            ? new TextEncoder().encode(event.data).length
            : event.data instanceof ArrayBuffer
              ? event.data.byteLength
              : 0;
        this.onTraffic?.('in', bytes);

        const result = parseServerMessage(event.data);
        if (!result.ok) {
          console.error('Failed to parse WS message:', result.error);
          return;
        }
        this.dispatchMessage(result.value);
      } catch (err: unknown) {
        console.error('Failed to parse WS message', err instanceof Error ? err.message : String(err));
      }
    };

    this.socket.onclose = (): void => {
      this.isConnected = false;
      const delay = this.reconnectDelay;
      this.onClose?.(delay);
      console.log(`WS Closed. Reconnecting in ${delay}ms...`);
      setTimeout(() => this.connect(), delay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    };
  }

  private dispatchMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.onWelcomeHandler?.(msg);
        break;
      case 'players':
        this.onPlayersHandler?.(msg);
        break;
      case 'config':
        this.onConfigHandler?.(msg);
        break;
      case 'pong':
        this.onPongHandler?.(msg);
        break;
      case 'snapshot':
        this.onSnapshotHandler?.(msg);
        break;
      case 'chat':
        this.onChatHandler?.(msg);
        break;
      case 'error':
        console.warn('Server error received:', msg.error);
        break;
      default: {
        const _exhaustive: never = msg;
        throw new Error(`Unhandled message: ${String(_exhaustive)}`);
      }
    }
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(message));
  }

  sendRaw(data: string | ArrayBuffer | Uint8Array): void {
    if (this.isConnected && this.socket) {
      sendToSocket(this.socket, data);
      this.onTraffic?.('out', typeof data === 'string' ? data.length : data.byteLength);
    } else {
      this.sendQueue.push(data);
    }
  }

  on(type: 'welcome', callback: (msg: WelcomeMessage) => void): void;
  on(type: 'players', callback: (msg: PlayersMessage) => void): void;
  on(type: 'config', callback: (msg: ServerConfigMessage) => void): void;
  on(type: 'pong', callback: (msg: PongMessage) => void): void;
  on(type: 'snapshot', callback: (msg: Snapshot) => void): void;
  on(type: 'chat', callback: (msg: ServerChatMessage) => void): void;
  on(
    type: 'welcome' | 'players' | 'config' | 'pong' | 'snapshot' | 'chat',
    callback:
      | ((msg: WelcomeMessage) => void)
      | ((msg: PlayersMessage) => void)
      | ((msg: ServerConfigMessage) => void)
      | ((msg: PongMessage) => void)
      | ((msg: Snapshot) => void)
      | ((msg: ServerChatMessage) => void),
  ): void {
    if (type === 'welcome') this.onWelcomeHandler = callback as (msg: WelcomeMessage) => void;
    else if (type === 'players') this.onPlayersHandler = callback as (msg: PlayersMessage) => void;
    else if (type === 'config') this.onConfigHandler = callback as (msg: ServerConfigMessage) => void;
    else if (type === 'pong') this.onPongHandler = callback as (msg: PongMessage) => void;
    else if (type === 'snapshot') this.onSnapshotHandler = callback as (msg: Snapshot) => void;
    else if (type === 'chat') this.onChatHandler = callback as (msg: ServerChatMessage) => void;
  }
}

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const passthrough = new URLSearchParams();
for (const key of ['lat', 'jitter', 'drop', 'codec']) {
  const v = new URLSearchParams(window.location.search).get(key);
  if (v !== null) passthrough.set(key, v);
}
const qs = passthrough.toString();
export const connection: Connection = new Connection(`${protocol}//${window.location.host}/ws${qs ? `?${qs}` : ''}`);
