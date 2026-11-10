import { performance } from 'node:perf_hooks';
import client from 'prom-client';

export const register = new client.Registry();

// Enable default node.js process metrics (gc, memory, eventloop lag, etc.)
client.collectDefaultMetrics({ register, prefix: 'nodejs_' });

export const connectedPlayersGauge = new client.Gauge({
  name: 'dogfight_connected_players',
  help: 'Number of currently connected WebSocket players',
  registers: [register],
});

export const activeRoomsGauge = new client.Gauge({
  name: 'dogfight_active_rooms',
  help: 'Number of active game rooms',
  registers: [register],
});

export const messagesReceivedCounter = new client.Counter({
  name: 'dogfight_messages_received_total',
  help: 'Total WebSocket messages received',
  labelNames: ['type'],
  registers: [register],
});

export const messagesSentCounter = new client.Counter({
  name: 'dogfight_messages_sent_total',
  help: 'Total WebSocket messages sent',
  labelNames: ['type'],
  registers: [register],
});

export const bytesReceivedCounter = new client.Counter({
  name: 'dogfight_bytes_received_total',
  help: 'Total incoming bytes from clients',
  registers: [register],
});

export const bytesSentCounter = new client.Counter({
  name: 'dogfight_bytes_sent_total',
  help: 'Total outgoing bytes to clients',
  registers: [register],
});

export const tickDurationHistogram = new client.Histogram({
  name: 'dogfight_tick_duration_ms',
  help: 'Duration of room game loop ticks in milliseconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 16.6, 25, 50],
  registers: [register],
});

export const eventLoopUtilizationGauge = new client.Gauge({
  name: 'dogfight_event_loop_utilization',
  help: 'Node.js event loop utilization (0.0 to 1.0)',
  registers: [register],
});

export const rssMemoryGauge = new client.Gauge({
  name: 'dogfight_memory_rss_bytes',
  help: 'Process resident set size memory in bytes',
  registers: [register],
});

export const rejectedConnectionsCounter = new client.Counter({
  name: 'dogfight_rejected_connections_total',
  help: 'Total rejected connections by reason',
  labelNames: ['reason'],
  registers: [register],
});

const prevELU = performance.eventLoopUtilization();

export function updateRuntimeMetrics(roomCount: number, playerCount: number): void {
  activeRoomsGauge.set(roomCount);
  connectedPlayersGauge.set(playerCount);
  rssMemoryGauge.set(process.memoryUsage().rss);
  const currentELU = performance.eventLoopUtilization(prevELU);
  eventLoopUtilizationGauge.set(currentELU.utilization);
}
