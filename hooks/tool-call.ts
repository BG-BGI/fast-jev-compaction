import type { On, PluginOptions } from 'claude-code';

import {
  DEFAULT_RECALL_CONFIG,
  fetchRange,
  RECALL_TOOL,
  type RecallConfig,
  type RunProcess,
  saveRanges,
} from '../src/recall.js';
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
  optionNumber,
  optionString,
  percent,
} from './shared.js';

const PLUGIN_NAME = 'fast-jev-compaction';
export const RECALL_FULL_NAME = `mcp__${PLUGIN_NAME}__${RECALL_TOOL}`;
const RECALL_DESCRIPTION =
  'Restore text that fast-jev-compaction cut from an earlier tool result. Pass the ref from the omission note ([... recall ref=r_xxxxxxxx range=A-B ...]) and optionally range=A-B to narrow it. Stored locally for a few days; an expired ref means re-run the command.';
const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: 'Ref from the omission note, like r_ab12cd34.' },
    range: { type: 'string', description: 'Original line range to return, like 21-80.' },
    maxChars: { type: 'number', description: 'Cap on returned characters.' },
  },
  required: ['ref'],
} as const;

/** Recall limits from the plugin options; `recallEnabled: false` turns the feature off. */
export function resolveRecallConfig(
  options: PluginOptions,
): Omit<RecallConfig, 'airlockDir'> | undefined {
  if (options['recallEnabled'] === false) return undefined;
  return {
    ttlDays: optionNumber(options, 'recallTtlDays', DEFAULT_RECALL_CONFIG.ttlDays),
    maxMB: optionNumber(options, 'recallMaxMB', DEFAULT_RECALL_CONFIG.maxMB),
    maxChars: optionNumber(options, 'recallMaxChars', DEFAULT_RECALL_CONFIG.maxChars),
  };
}

const runner = ($: { process: { run: RunProcess } }): RunProcess => (argv, init) =>
  $.process.run(argv, init);

type RecallEnv = { env: { get: (name: string) => Promise<string | undefined> } };

/** jev-kit's `current` release: $AIRLOCK_HOME/current, else ~/.local/share/airlock/current. */
export async function airlockDir($: RecallEnv): Promise<string | undefined> {
  const explicit = await $.env.get('AIRLOCK_HOME');
  if (explicit) return `${explicit}/current`;
  const home = await $.env.get('HOME');
  return home ? `${home}/.local/share/airlock/current` : undefined;
}

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
  'maxLineChars',
] as const;

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: ResultOptions = {};
  for (const key of NUMBER_OPTIONS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = { ...numbers, model: optionString(options, 'model') ?? DEFAULT_MODEL };
  if (options['collapseRepeats'] === false) config.collapseRepeats = false;
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
  const shapes = {
    read: options['compactRead'] !== false,
    grep: options['compactGrep'] !== false,
  };

  const recallLimits = resolveRecallConfig(options);

  if (recallLimits) {
    on('session.start', async ($, event, next) => {
      try {
        await $.tool.register({
          name: RECALL_TOOL,
          description: RECALL_DESCRIPTION,
          inputSchema: RECALL_SCHEMA as unknown as Record<string, unknown>,
        });
      } catch (error) {
        $.ui.log(`recall tool not registered (${error instanceof Error ? error.message : String(error)})`);
      }
      return next(event);
    });

    on('tool.call', { tool: RECALL_FULL_NAME }, async ($, event) => {
      const dir = await airlockDir($);
      const input = event as Record<string, unknown>;
      const ref = typeof input['ref'] === 'string' ? input['ref'] : '';
      const range = typeof input['range'] === 'string' ? input['range'] : undefined;
      const maxChars = typeof input['maxChars'] === 'number' ? input['maxChars'] : undefined;
      const got = dir
        ? await fetchRange(
            runner($),
            { ...recallLimits, airlockDir: dir },
            { ref, ...(range ? { range } : {}), ...(maxChars ? { maxChars } : {}) },
          )
        : { ok: false, text: 'recall store unavailable; re-run the command' };
      $.ui.log(`recall ${ref}${range ? ` ${range}` : ''}: ${got.ok ? 'hit' : 'miss'}`);
      return { result: got.text };
    });
  }

  on('tool.call', async ($, event, next) => {
    const ran = await next(event);
    if (event.tool === RECALL_FULL_NAME) return ran; // never re-compact recalled text
    if (ran.deny !== undefined || ran.isError || ran.result === undefined) return ran;
    const { tool, tool_use_id: _id, agentId, ...input } = event as Record<string, unknown> & {
      tool: string;
      agentId?: string;
    };
    if (tool !== 'Bash' && tool !== 'Read' && tool !== 'Grep' && !tool.startsWith('mcp__')) {
      return ran;
    }
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
        const dir = recallLimits ? await airlockDir($) : undefined;
        const result = await compactToolResult(text, { tool, input }, asker, {
          goal,
          ...configured,
          keepLineCount,
          ...(recallLimits && dir
            ? {
                saveOmitted: (ranges) =>
                  saveRanges(
                    runner($),
                    { ...recallLimits, airlockDir: dir },
                    { session: agentId ?? 'main', tool, ranges },
                  ),
              }
            : {}),
        });
        $.ui.log(`${tool} decisions: ${decisionLog(result) || '(none)'}`);
        if (!result.changed) return text;
        $.ui.log(`${tool} output ${summarize(result)}`);
        if (result.recallRef) $.ui.log(`${tool} recall ref ${result.recallRef}`);
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
