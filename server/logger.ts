import pino from 'pino';
import { config } from './config.ts';

export const logger = pino({
  level: config.logLevel,
  base: {
    service: 'dogfight-server',
    sha: config.gitSha,
    env: config.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function getRoomLogger(roomId: string, playerId?: string | number) {
  return logger.child({
    roomId,
    ...(playerId !== undefined ? { playerId: String(playerId) } : {}),
  });
}

