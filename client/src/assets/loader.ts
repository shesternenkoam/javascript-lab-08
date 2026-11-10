export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string = `HTTP Error: ${status}`) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function fetchJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new HttpError(response.status);
  }
  return response.json() as Promise<T>; // Justified cast: fetch JSON response to inferred generic type
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  signal?: AbortSignal;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 100, signal }: RetryOptions = {},
): Promise<T> {
  let attempt = 0;
  while (attempt < attempts) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (signal?.aborted) throw error;

      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        throw error;
      }

      attempt++;
      if (attempt >= attempts) throw error;

      const jitter = Math.random() * baseMs;
      const delay = baseMs * 2 ** (attempt - 1) + jitter;

      await new Promise<void>((res) => {
        const timeout = setTimeout(res, delay);
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              res();
            },
            { once: true },
          );
        }
      });
      if (signal?.aborted) throw error;
    }
  }
  throw new Error('Retry failed: exhausted all attempts');
}

export function loadImage(src: string, { signal }: { signal?: AbortSignal } = {}): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      reject(new HttpError(404, `Failed to load image: ${src}`));
    };
    img.src = src;

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          img.src = '';
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    }
  });
}

export async function loadAudio(
  audioCtx: AudioContext,
  url: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AudioBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new HttpError(response.status);
  }
  const arrayBuffer = await response.arrayBuffer();
  return audioCtx.decodeAudioData(arrayBuffer);
}

export interface Manifest {
  sprites?: Record<string, string>;
  sounds?: Record<string, string>;
  config?: string;
}

export interface LoadedAssets {
  sprites: Record<string, HTMLImageElement>;
  sounds: Record<string, AudioBuffer>;
  config: unknown;
}

export async function loadAll(
  manifestOrUrl: Manifest | string,
  {
    onProgress,
    signal,
    audioCtx,
  }: {
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
    audioCtx?: AudioContext;
  } = {},
): Promise<LoadedAssets> {
  const manifest =
    typeof manifestOrUrl === 'string'
      ? await withRetry(() => fetchJson<Manifest>(manifestOrUrl, { signal }), { signal })
      : manifestOrUrl;

  const promises: Promise<unknown>[] = [];
  let done = 0;
  let total = 0;

  const assets: LoadedAssets = { sprites: {}, sounds: {}, config: null };

  if (manifest.sprites) total += Object.keys(manifest.sprites).length;
  if (manifest.sounds) total += Object.keys(manifest.sounds).length;
  if (manifest.config) total += 1;

  const track = <P>(promise: Promise<P>): Promise<P> =>
    promise.then((v) => {
      done++;
      if (onProgress && total > 0) onProgress(done / total);
      return v;
    });

  if (manifest.sprites) {
    for (const [key, url] of Object.entries(manifest.sprites)) {
      const p = withRetry(() => loadImage(url, { signal }), { signal }).then((img) => {
        assets.sprites[key] = img;
      });
      promises.push(track(p));
    }
  }

  if (manifest.sounds && audioCtx) {
    for (const [key, url] of Object.entries(manifest.sounds)) {
      const p = withRetry(() => loadAudio(audioCtx, url, { signal }), { signal }).then((buffer) => {
        assets.sounds[key] = buffer;
      });
      promises.push(track(p));
    }
  }

  if (typeof manifest.config === 'string') {
    const configUrl = manifest.config;
    const p = withRetry(() => fetchJson(configUrl, { signal }), { signal }).then((cfg) => {
      assets.config = cfg;
    });
    promises.push(track(p));
  }

  await Promise.all(promises);
  return assets;
}
