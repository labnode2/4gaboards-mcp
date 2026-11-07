import { z } from 'zod';

const bool = (name: string, v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v.trim() === '') return dflt;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  throw new Error(`${name} must be true or false`);
};

const emptyToUndef = (v: string | undefined): string | undefined => (v && v.trim() !== '' ? v : undefined);

export type Credentials =
  | { kind: 'apiClient'; clientId: string; clientSecret: string }
  | { kind: 'password'; username: string; password: string }
  | { kind: 'token'; token: string };

export interface Config {
  baseUrl: string;
  credentials: Credentials;
  allowDelete: boolean;
  defaultBoardId?: string;
  timeoutMs: number;
}

const idSchema = z.string().regex(/^\d+$/, 'must be a numeric id');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = emptyToUndef(env.FOURGA_URL);
  if (!rawUrl) throw new Error('FOURGA_URL is required (e.g. https://boards.example.lan)');
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('FOURGA_URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('FOURGA_URL must be http(s)');
  const baseUrl = url.toString().replace(/\/+$/, '').replace(/\/api$/, '');

  const clientId = emptyToUndef(env.FOURGA_CLIENT_ID);
  const clientSecret = emptyToUndef(env.FOURGA_CLIENT_SECRET);
  const username = emptyToUndef(env.FOURGA_USERNAME);
  const password = emptyToUndef(env.FOURGA_PASSWORD);
  const token = emptyToUndef(env.FOURGA_TOKEN);

  let credentials: Credentials;
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) throw new Error('FOURGA_CLIENT_ID and FOURGA_CLIENT_SECRET must be set together');
    credentials = { kind: 'apiClient', clientId, clientSecret };
  } else if (username || password) {
    if (!username || !password) throw new Error('FOURGA_USERNAME and FOURGA_PASSWORD must be set together');
    credentials = { kind: 'password', username, password };
  } else if (token) {
    credentials = { kind: 'token', token };
  } else {
    throw new Error(
      'No credentials: set FOURGA_CLIENT_ID+FOURGA_CLIENT_SECRET (recommended), FOURGA_USERNAME+FOURGA_PASSWORD, or FOURGA_TOKEN',
    );
  }

  const boardRaw = emptyToUndef(env.FOURGA_DEFAULT_BOARD_ID)?.trim();
  if (boardRaw) {
    const r = idSchema.safeParse(boardRaw);
    if (!r.success) throw new Error('FOURGA_DEFAULT_BOARD_ID must be a numeric board id');
  }

  const timeout = Number(emptyToUndef(env.FOURGA_TIMEOUT_MS) ?? 30000);
  if (!Number.isFinite(timeout) || timeout < 1000) throw new Error('FOURGA_TIMEOUT_MS must be a number >= 1000');

  return {
    baseUrl,
    credentials,
    allowDelete: bool('FOURGA_ALLOW_DELETE', env.FOURGA_ALLOW_DELETE, false),
    defaultBoardId: boardRaw,
    timeoutMs: timeout,
  };
}
