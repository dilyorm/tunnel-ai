import { TunnelError } from './errors.js';
import { VERSION } from './version.js';

/** A download gives up after this long without receiving a byte. */
const STALL_MS = 60_000;

/** Thin HTTP client for the relay API. Every failure becomes a readable TunnelError. */
export class RelayClient {
  constructor(
    readonly base: string,
    private readonly token?: string,
  ) {}

  as(token: string) {
    return new RelayClient(this.base, token);
  }

  private async request(
    method: string,
    path: string,
    init: { json?: unknown; body?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': `tunnel-ai/${VERSION}` };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | Uint8Array | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers['content-type'] = 'application/octet-stream';
      body = new Uint8Array(init.body);
    }
    // timeoutMs 0 means the caller enforces its own deadline through `signal`.
    const timeout = init.timeoutMs === 0 ? undefined : AbortSignal.timeout(init.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([init.signal, timeout].filter((s): s is AbortSignal => s !== undefined));

    let res: Response;
    try {
      res = await fetch(this.base + path, { method, headers, body, signal });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : 'is unreachable';
      throw new TunnelError(
        `The relay at ${this.base} ${reason}. Check your connection, or point to another relay with --relay.`,
      );
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // not JSON; keep the status line
      }
      const error = new TunnelError(message);
      (error as TunnelError & { status: number }).status = res.status;
      throw error;
    }
    return res;
  }

  async json<T>(method: string, path: string, data?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const res = await this.request(method, path, { json: data, ...opts });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async upload<T>(path: string, data: Buffer) {
    // Allow for links as slow as 16 KB/s: 10 MB gets about 12 minutes.
    const res = await this.request('POST', path, { body: data, timeoutMs: 60_000 + Math.ceil(data.length / 16) });
    return (await res.json()) as T;
  }

  async download(path: string): Promise<Buffer> {
    // A big file on a slow link can take minutes, so give up on silence, not on total time.
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(), STALL_MS);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), STALL_MS);
    };
    try {
      const res = await this.request('GET', path, { signal: stall.signal, timeoutMs: 0 });
      if (!res.body) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks);
        chunks.push(Buffer.from(value));
        kick();
      }
    } catch (error) {
      if (error instanceof TunnelError) throw error;
      throw new TunnelError(
        `The download from ${this.base} stalled for ${STALL_MS / 1000}s. Run the same command again to retry.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
