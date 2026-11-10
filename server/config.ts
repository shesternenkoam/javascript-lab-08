import { z } from 'zod';

export const ServerConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  allowedOrigins: z
    .string()
    .default('*')
    .transform((val) => {
      if (!val || val === '*') return ['*'];
      return val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    }),
  maxConnectionsPerIp: z.coerce.number().int().positive().default(10),
  maxRooms: z.coerce.number().int().positive().default(50),
  maxPlayersPerRoom: z.coerce.number().int().positive().default(10),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  gitSha: z.string().default(process.env['GIT_SHA'] || process.env['GITHUB_SHA'] || 'dev'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const config: ServerConfig = ServerConfigSchema.parse({
  port: process.env['PORT'],
  host: process.env['HOST'],
  nodeEnv: process.env['NODE_ENV'],
  allowedOrigins: process.env['ALLOWED_ORIGINS'],
  maxConnectionsPerIp: process.env['MAX_CONNECTIONS_PER_IP'],
  maxRooms: process.env['MAX_ROOMS'],
  maxPlayersPerRoom: process.env['MAX_PLAYERS_PER_ROOM'],
  logLevel: process.env['LOG_LEVEL'],
  gitSha: process.env['GIT_SHA'],
});
