import { Authenticator, type FetchLike } from './auth.js';
import { ApiError, explainStatus } from './errors.js';

export interface HttpOptions {
  baseUrl: string;
  auth: Authenticator;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /** Delay between retries of idempotent requests; overridable for tests. */
  retryDelayMs?: number;
}

export class Http {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: HttpOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.retryDelayMs = opts.retryDelayMs ?? 300;
  }

  async request<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; hint?: string } = {}): Promise<T> {
    const url = new URL(`${this.opts.baseUrl}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const idempotent = method === 'GET';
    let relogged = false;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(await this.opts.auth.headers()),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (idempotent && attempt < 2) {
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        throw new ApiError(`Cannot reach 4ga Boards at ${this.opts.baseUrl} (network error or timeout).`, 0);
      }

      if (res.status === 401 && this.opts.auth.canRefresh && !relogged) {
        // 401 means the request was not processed, so re-login + replay is safe for writes too.
        relogged = true;
        this.opts.auth.invalidate();
        continue;
      }
      if (idempotent && [502, 503, 504].includes(res.status) && attempt < 2) {
        await sleep(this.retryDelayMs * (attempt + 1));
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        const obj = (json ?? {}) as { message?: unknown; code?: unknown };
        const msg = typeof obj.message === 'string' ? obj.message : text && !json ? text.slice(0, 200) : undefined;
        throw new ApiError(explainStatus(res.status, msg, opts.hint ?? ''), res.status, typeof obj.code === 'string' ? obj.code : undefined);
      }
      return json as T;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
