import type { Credentials } from '../config.js';
import { ApiError, explainStatus } from './errors.js';

export type FetchLike = typeof fetch;

/** Produces auth headers and can refresh them after a 401. */
export class Authenticator {
  private jwt: string | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly creds: Credentials,
    private readonly fetchFn: FetchLike,
    private readonly timeoutMs: number,
  ) {
    if (creds.kind === 'token') this.jwt = creds.token;
  }

  /** True when a 401 could be fixed by logging in again. */
  get canRefresh(): boolean {
    return this.creds.kind === 'password';
  }

  async headers(): Promise<Record<string, string>> {
    switch (this.creds.kind) {
      case 'apiClient':
        return { 'X-Client-Id': this.creds.clientId, 'X-Client-Secret': this.creds.clientSecret };
      default:
        return { Authorization: `Bearer ${await this.token()}` };
    }
  }

  /** Drop the cached token (after a 401) so the next call logs in again. */
  invalidate(): void {
    if (this.creds.kind === 'password') this.jwt = undefined;
  }

  private async token(): Promise<string> {
    if (this.jwt) return this.jwt;
    // single-flight: concurrent callers share one login
    this.inflight ??= this.login().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async login(): Promise<string> {
    if (this.creds.kind !== 'password') throw new ApiError('No login available', 401);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/access-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ emailOrUsername: this.creds.username, password: this.creds.password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ApiError(`Cannot reach 4ga Boards at ${this.baseUrl} to log in.`, 0);
    }
    if (!res.ok) {
      let msg: string | undefined;
      try {
        msg = ((await res.json()) as { message?: unknown }).message as string | undefined;
      } catch {
        /* ignore */
      }
      throw new ApiError(
        `Login failed. ${explainStatus(res.status, typeof msg === 'string' ? msg : undefined, '')} SSO-only accounts have no password; use an API client instead.`,
        res.status,
      );
    }
    const body = (await res.json()) as { item?: unknown };
    if (typeof body.item !== 'string' || !body.item) throw new ApiError('Login response had no token', 502);
    this.jwt = body.item;
    return this.jwt;
  }
}
