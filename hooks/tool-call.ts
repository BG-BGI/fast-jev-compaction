import type { On, PluginOptions } from 'claude-code';

import { DEFAULT_MODEL } from '../src/request.js';
import {
  compactToolResult,
  DEFAULT_RESULT_OPTIONS,
  type ResultCompaction,
  type ResultOptions,
} from '../src/result.js';
import { goalFromMessages } from '../src/state.js';
import type { Message } from '../src/types.js';
import { mapResultText, type TextRewrite } from './result-shapes.js';
import {
  jevAsker,
  KIT_ENV_PATH,
  type KeyLookup,
  keyFromEnvFile,
  keyFromSettings,
  optionString,
  percent,
} from './shared.js';

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

async function keyFromKitFile($: KeyLookup): Promise<string | undefined> {
  const home = await $.env.get('HOME');
  if (!home) return undefined;
  try {
    const text = await $.fs.read(`${home}/${KIT_ENV_PATH}`);
    return typeof text === 'string' ? keyFromEnvFile(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Plugin option, then the environment, then settings.json env, then jev-kit's env file. */
async function getApiKey($: KeyLookup, configured: string | undefined): Promise<string | undefined> {
  if (configured) return configured;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  return keyFromSettings(await $.settings.read()) ?? keyFromKitFile($);
}

export function registerToolCall(on: On, options: PluginOptions): void {
  const configured = resolveHookConfig(options);
  const shapes = { read: options['compactRead'] !== false };

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
        apiKey ??= await getApiKey($, configured.apiKey);
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
}
