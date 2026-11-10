import fs from 'node:fs';
import { pipeline, Transform, type TransformCallback, type TransformOptions } from 'node:stream';
import readline from 'node:readline';
import { z } from 'zod';

const LogLineSchema = z.object({ timestamp: z.number() }).passthrough();

export function readMatchLog(roomName: string): void {
  const filePath = `./logs/${roomName}.ndjson`;
  if (!fs.existsSync(filePath)) {
    console.log('Лог-файл ще не створено.');
    return;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  console.log(`--- Читання логів кімнати ${roomName} через потік ---`);
  rl.on('line', (line: string) => {
    try {
      const parsed = LogLineSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        console.log(`[Подія ${new Date(parsed.data.timestamp).toLocaleTimeString()}]:`, parsed.data);
      }
    } catch (e: unknown) {
      console.warn('Error parsing log line:', e instanceof Error ? e.message : String(e));
    }
  });
}

export class MatchLogTransform extends Transform {
  constructor(options: TransformOptions = {}) {
    super({ ...options, objectMode: true });
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const payload = typeof chunk === 'object' && chunk !== null ? chunk : { data: chunk };
      const logLine = JSON.stringify({ timestamp: Date.now(), ...payload }) + '\n';
      callback(null, logLine);
    } catch (err: unknown) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export interface MatchLogStream {
  write(eventData: Record<string, unknown>): void;
  pipeToFile(): void;
  close(): void;
}

export function createMatchLogStream(roomName: string): MatchLogStream {
  const logDir = './logs';
  let writableStream: fs.WriteStream | null = null;
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    writableStream = fs.createWriteStream(`${logDir}/${roomName}.ndjson`, { flags: 'a' });
  } catch (_e) {
    // Graceful fallback if filesystem is read-only or running without write access in container
  }

  const transformStream = new MatchLogTransform();

  return {
    write(eventData: Record<string, unknown>): void {
      transformStream.write(eventData);
    },
    pipeToFile(): void {
      if (writableStream) {
        pipeline(transformStream, writableStream, (err) => {
          if (err) console.error('Помилка стрімінгу логів:', err.message);
        });
      }
    },
    close(): void {
      try {
        transformStream.end();
      } catch (_e) {}
    },
  };
}
