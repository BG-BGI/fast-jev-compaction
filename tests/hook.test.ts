import { describe, expect, it } from 'vitest';
import { decisionLog, jevAsker, register, resolveHookConfig, summarize } from '../hooks/fast-jev.ts';
import { compactToolResult } from '../src/index.js';

const output = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n');

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ model: 'jev-latest' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, minChars: 100, model: 'jev-x', goal: 'g', chunkLines: 'no' }),
    ).toEqual({ apiKey: 'k', keepThreshold: 0.3, minChars: 100, model: 'jev-x', goal: 'g' });
  });
});

describe('jevAsker over the engine fetch', () => {
  it('posts the model and the redacted state, and compacts from the answers', async () => {
    const bodies: string[] = [];
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const asker = jevAsker(jevFetch((name) => (name === 'chunk_2' ? 0.9 : 0.1), bodies), 'k', 'jev-x');
    const result = await compactToolResult(
      `${secret}\n${output}`,
      { tool: 'Bash', input: { command: 'cat log' } },
      asker,
      { chunkLines: 20 },
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(bodies[0]).not.toContain(secret);
    expect(result.changed).toBe(true);
    expect(result.text).toContain(secret);
    expect(summarize(result)).toMatch(/^\d+% smaller \(\d+ -> \d+ chars\); \d+\/\d+ chunks omitted$/);
    expect(decisionLog(result)).toMatch(/^1-20:keep\/1\.00 21-40:drop\/0\.10 /);
  });

  it('rejects on failed requests so the hook passes the output through', async () => {
    const asker = jevAsker(async () => ({ status: 500, ok: false, text: 'x' }), 'k', 'jev-latest');
    await expect(
      compactToolResult(output, { tool: 'Bash', input: {} }, asker),
    ).rejects.toThrow(/500/);
  });
});

type Handler = (
  $: unknown,
  event: Record<string, unknown>,
  next: (event: Record<string, unknown>) => Promise<unknown>,
) => Promise<unknown>;

function registered(options: Record<string, unknown> = {}): { matcher: unknown; handler: Handler } {
  let captured: { matcher: unknown; handler: Handler } | undefined;
  const on = (name: string, matcher: unknown, handler: Handler): void => {
    if (name === 'tool.call') captured = { matcher, handler };
  };
  (register as unknown as (on: unknown, options: unknown) => void)(on, options);
  if (!captured) throw new Error('no tool.call hook registered');
  return captured;
}

function engine(answer: (name: string) => number, logs: string[], calls: { fetches: number }) {
  return {
    env: { get: async () => 'k' },
    settings: { read: async () => ({}) },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        calls.fetches += 1;
        return jevFetch(answer)(url, init);
      },
    },
    session: {
      messages: async () => [{ role: 'user', text: 'fix the tests', toolUses: [] }],
    },
    ui: { log: (text: string) => logs.push(text) },
  };
}

const bashResult = (stdout: string, extra: Record<string, unknown> = {}) => ({
  ref: 7,
  text: stdout,
  result: { stdout, stderr: '', interrupted: false, ...extra },
});

describe('tool.call hook', () => {
  it('hooks Bash only', () => {
    expect(registered().matcher).toEqual({ tool: 'Bash' });
  });

  it('rewrites a long stdout and drops the engine ref so core maps the new result', async () => {
    const logs: string[] = [];
    const calls = { fetches: 0 };
    const { handler } = registered({ chunkLines: 20 });
    const ran = bashResult(output);
    const out = (await handler(
      engine((n) => (n === 'chunk_2' ? 0.9 : 0.1), logs, calls),
      { tool: 'Bash', command: 'cat log' },
      async () => ran,
    )) as { result: { stdout: string; stderr: string }; ref?: number };
    expect(calls.fetches).toBe(1);
    expect(out.ref).toBeUndefined();
    expect(out.result.stderr).toBe('');
    expect(out.result.stdout).toContain('omitted Bash output lines 21-40');
    expect(out.result.stdout.length).toBeLessThan(output.length);
    expect(logs.some((line) => line.startsWith('decisions: '))).toBe(true);
  });

  it.each([
    ['a short output', bashResult('ok'), 0],
    ['a failed command', { ...bashResult(output), isError: true }, 0],
    ['a backgrounded command', bashResult(output, { backgroundTaskId: 'b1' }), 0],
    ['an already persisted output', bashResult(output, { persistedOutputPath: '/x' }), 0],
    ['a deny', { deny: 'no' }, 0],
  ])('passes %s through without asking Jev', async (_name, ran, fetches) => {
    const calls = { fetches: 0 };
    const out = await registered().handler(
      engine(() => 0, [], calls),
      { tool: 'Bash', command: 'x' },
      async () => ran,
    );
    expect(out).toBe(ran);
    expect(calls.fetches).toBe(fetches);
  });

  it('passes the output through untouched when Jev fails', async () => {
    const logs: string[] = [];
    const ran = bashResult(output);
    const failing = {
      ...engine(() => 0, logs, { fetches: 0 }),
      http: { fetch: async () => ({ status: 500, ok: false, text: 'x' }) },
    };
    const out = await registered().handler(failing, { tool: 'Bash', command: 'x' }, async () => ran);
    expect(out).toBe(ran);
    expect(logs).toEqual([expect.stringContaining('tool result passed through')]);
  });
});
