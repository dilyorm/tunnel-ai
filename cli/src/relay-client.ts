import { TunnelError } from './errors.js';
import { VERSION } from './version.js';

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
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

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
    const res = await this.request('POST', path, { body: data, timeoutMs: 120_000 });
    return (await res.json()) as T;
  }

  async download(path: string): Promise<Buffer> {
    const res = await this.request('GET', path, { timeoutMs: 120_000 });
    return Buffer.from(await res.arrayBuffer());
  }
}
