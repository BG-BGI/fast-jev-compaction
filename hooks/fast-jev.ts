import type { On, PluginOptions, Register } from 'claude-code';

import { redactingAsker } from '../src/redact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import {
  compactToolResult,
  DEFAULT_RESULT_OPTIONS,
  type ResultCompaction,
  type ResultOptions,
} from '../src/result.js';
import { goalFromMessages } from '../src/state.js';
import type { JevAsker, Message } from '../src/types.js';
import { mapResultText, type TextRewrite } from './result-shapes.js';

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

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = ResultOptions & {
  apiKey?: string;
  model: string;
};

const NUMBER_OPTIONS = [
  'keepThreshold',
  'minChars',
  'chunkLines',
  'maxChunks',
  'maxStateTokens',
  'minReductionRatio',
] as const;

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: ResultOptions = {};
  for (const key of NUMBER_OPTIONS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = { ...numbers, model: optionString(options, 'model') ?? DEFAULT_MODEL };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
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

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: ResultCompaction): string {
  const saved = (result.charsBefore - result.charsAfter) / Math.max(1, result.charsBefore);
  return `${percent(saved)} smaller (${result.charsBefore} -> ${result.charsAfter} chars); ${result.omittedChunks}/${result.chunks} chunks omitted`;
}

export function decisionLog(result: ResultCompaction): string {
  return result.decisions
    .map(
      (d) =>
        `${d.firstLine}-${d.lastLine}:${d.kept ? 'keep' : 'drop'}/${d.keep.toFixed(2)}`,
    )
    .join(' ');
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  const shapes = { read: options['compactRead'] === true };

  on('tool.call', async ($, event, next) => {
    const ran = await next(event);
    if (ran.deny !== undefined || ran.isError || ran.result === undefined) return ran;
    const { tool, tool_use_id: _id, agentId, ...input } = event as Record<string, unknown> & {
      tool: string;
      agentId?: string;
    };
    if (tool !== 'Bash' && tool !== 'Read' && !tool.startsWith('mcp__')) return ran;
    let apiKey: string | undefined;
    let goal: string | undefined;
    let changed = false;
    const rewrite: TextRewrite = async (text, keepLineCount) => {
      if (text.length < (configured.minChars ?? DEFAULT_RESULT_OPTIONS.minChars)) return text;
      try {
        apiKey ??= await getApiKey($, configured);
        if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
        if (goal === undefined) {
          const found =
            agentId === undefined
              ? await $.session.messages()
              : await $.session.messages({ agentId });
          goal = goalFromMessages('deny' in found ? [] : (found as readonly Message[]));
        }
        const asker = jevAsker(
          async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          },
          apiKey,
          configured.model,
        );
        const result = await compactToolResult(text, { tool, input }, asker, {
          goal,
          ...configured,
          keepLineCount,
        });
        $.ui.log(`${tool} decisions: ${decisionLog(result) || '(none)'}`);
        if (!result.changed) return text;
        $.ui.log(`${tool} output ${summarize(result)}`);
        changed = true;
        return result.text;
      } catch (error) {
        $.ui.log(
          `${tool} result passed through (${error instanceof Error ? error.message : String(error)})`,
        );
        return text;
      }
    };
    const mapped = await mapResultText(tool, ran.result, rewrite, shapes);
    if (!changed) return ran;
    return ran.context
      ? { result: mapped as typeof ran.result, context: ran.context }
      : { result: mapped as typeof ran.result };
  });
};
