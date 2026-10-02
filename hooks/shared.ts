import type { PluginOptions } from 'claude-code';

import { redactingAsker } from '../src/redact.js';
import { buildJevRequest, parseJevResponse } from '../src/request.js';
import type { JevAsker } from '../src/types.js';

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hooks can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookMode = 'tool' | 'session' | 'both';

export const DEFAULT_MODE: HookMode = 'tool';

export function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Which hooks to register; anything unrecognised takes the default. */
export function resolveMode(options: PluginOptions): HookMode {
  const value = options['mode'];
  return value === 'tool' || value === 'session' || value === 'both' ? value : DEFAULT_MODE;
}

/** A redacting `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return redactingAsker({
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  });
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export const KIT_ENV_PATH = '.config/jev-kit/env';
const KEY_LINE = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m;

/** The key from jev-kit's own `~/.config/jev-kit/env` file, quotes stripped. */
export function keyFromEnvFile(text: string): string | undefined {
  const raw = KEY_LINE.exec(text)?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
  return raw ? raw : undefined;
}

/** `TYPESAFE_API_KEY` from a settings.json `env` block, if present. */
export function keyFromSettings(settings: Readonly<Record<string, unknown>>): string | undefined {
  const env = settings['env'];
  if (!env || typeof env !== 'object') return undefined;
  const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
  return typeof value === 'string' && value ? value : undefined;
}

export type KeyLookup = {
  env: { get: (name: string) => Promise<string | undefined> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  fs: { read: (path: string) => Promise<unknown> };
};
