import type { OmittedRange } from './result.js';

/** The shape of `$.process.run`, so the store can be driven without an engine. */
export type RunProcess = (
  argv: readonly string[],
  init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface RecallConfig {
  /** Directory holding the `airlock` package (jev-kit's `current` release). */
  airlockDir: string;
  ttlDays: number;
  maxMB: number;
  maxChars: number;
}

export const DEFAULT_RECALL_CONFIG = { ttlDays: 7, maxMB: 50, maxChars: 20_000 } as const;
export const RECALL_TOOL = 'recall';
const TIMEOUT_MS = 5000;

function python(args: readonly string[]): readonly string[] {
  return ['python3', '-m', 'airlock.recall', ...args];
}

function env(config: RecallConfig): Record<string, string> {
  return { PYTHONPATH: config.airlockDir };
}

function parse(stdout: string): { ok?: boolean; ref?: string; text?: string; error?: string } {
  const value: unknown = JSON.parse(stdout);
  return value && typeof value === 'object' ? value : {};
}

/** Stores the dropped ranges; the ref, or `undefined` on any failure (fail open). */
export async function saveRanges(
  run: RunProcess,
  config: RecallConfig,
  entry: { session: string; tool: string; ranges: readonly OmittedRange[] },
): Promise<string | undefined> {
  try {
    const payload = JSON.stringify({
      session: entry.session,
      tool: entry.tool,
      ranges: entry.ranges.map((r) => ({ start: r.first, end: r.last, text: r.text })),
    });
    const ran = await run(
      python(['put', '--ttl-days', String(config.ttlDays), '--max-mb', String(config.maxMB)]),
      { env: env(config), stdin: payload, timeoutMs: TIMEOUT_MS },
    );
    if (ran.exitCode !== 0) return undefined;
    const out = parse(ran.stdout);
    return out.ok && typeof out.ref === 'string' && /^r_[0-9a-f]{8}$/.test(out.ref)
      ? out.ref
      : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a stored ref (optionally one line range), or an explanation for the model. */
export async function fetchRange(
  run: RunProcess,
  config: RecallConfig,
  request: { ref: string; range?: string; maxChars?: number },
): Promise<{ ok: boolean; text: string }> {
  if (!/^r_[0-9a-f]{8}$/.test(request.ref)) return { ok: false, text: 'invalid ref' };
  if (request.range !== undefined && !/^\d+(-\d+)?$/.test(request.range)) {
    return { ok: false, text: 'range must look like 21-80' };
  }
  const limit = Math.min(request.maxChars ?? config.maxChars, config.maxChars);
  const args = ['get', request.ref, '--max-chars', String(limit), '--ttl-days', String(config.ttlDays)];
  if (request.range) args.push('--range', request.range);
  try {
    const ran = await run(python(args), { env: env(config), timeoutMs: TIMEOUT_MS });
    const out = parse(ran.stdout);
    return out.ok && typeof out.text === 'string'
      ? { ok: true, text: out.text }
      : { ok: false, text: out.error ?? 'recall store unavailable; re-run the command' };
  } catch {
    return { ok: false, text: 'recall store unavailable; re-run the command' };
  }
}
