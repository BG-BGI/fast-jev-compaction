import { describe, expect, it } from 'vitest';
import {
  decisionLog,
  jevAsker,
  keyFromEnvFile,
  register,
  resolveHookConfig,
  summarize,
} from '../hooks/fast-jev.ts';
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

function registered(options: Record<string, unknown> = {}): { handler: Handler } {
  let captured: { handler: Handler } | undefined;
  const on = (name: string, ...rest: unknown[]): void => {
    if (name === 'tool.call') captured = { handler: rest[rest.length - 1] as Handler };
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
  it('passes tools it does not handle through without asking Jev', async () => {
    const calls = { fetches: 0 };
    const ran = { ref: 1, text: output, result: { content: output } };
    const out = await registered().handler(
      engine(() => 0, [], calls),
      { tool: 'WebFetch', url: 'x' },
      async () => ran,
    );
    expect(out).toBe(ran);
    expect(calls.fetches).toBe(0);
  });

  it('keeps an MCP result in its own shape, text blocks and strings alike', async () => {
    const answer = (n: string) => (n === 'chunk_2' ? 0.9 : 0.1);
    const block = { type: 'text', text: output };
    const image = { type: 'image', data: 'abc' };
    const asBlocks = (await registered({ chunkLines: 20 }).handler(
      engine(answer, [], { fetches: 0 }),
      { tool: 'mcp__srv__list', q: 1 },
      async () => ({ result: { content: [block, image], isError: false } }),
    )) as { result: { content: Record<string, unknown>[]; isError: boolean } };
    expect(asBlocks.result.isError).toBe(false);
    expect(asBlocks.result.content[1]).toBe(image);
    expect(asBlocks.result.content[0]?.['type']).toBe('text');
    expect(asBlocks.result.content[0]?.['text']).toContain('omitted mcp__srv__list output');
    const asString = (await registered({ chunkLines: 20 }).handler(
      engine(answer, [], { fetches: 0 }),
      { tool: 'mcp__srv__list' },
      async () => ({ result: output }),
    )) as { result: string };
    expect(typeof asString.result).toBe('string');
    expect(asString.result.length).toBeLessThan(output.length);
  });

  it('compacts Read only when enabled, keeping the line count', async () => {
    const read = {
      result: {
        type: 'text',
        file: { filePath: '/a', content: output, numLines: 100, startLine: 1, totalLines: 100 },
      },
    };
    const answer = (n: string) => (n === 'chunk_2' ? 0.9 : 0.1);
    const off = await registered({ chunkLines: 20 }).handler(
      engine(answer, [], { fetches: 0 }),
      { tool: 'Read', file_path: '/a' },
      async () => read,
    );
    expect(off).toBe(read);
    const on = (await registered({ chunkLines: 20, compactRead: true }).handler(
      engine(answer, [], { fetches: 0 }),
      { tool: 'Read', file_path: '/a' },
      async () => read,
    )) as { result: { file: { content: string; startLine: number } } };
    expect(on.result.file.startLine).toBe(1);
    expect(on.result.file.content.split('\n')).toHaveLength(100);
    expect(on.result.file.content.split('\n')[0]).toBe(output.split('\n')[0]);
    expect(on.result.file.content.split('\n')[40]).toBe(output.split('\n')[40]);
    expect(on.result.file.content).toContain('omitted Read output lines 21-40');
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
    expect(logs.some((line) => line.startsWith('Bash decisions: '))).toBe(true);
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
    expect(logs).toEqual([expect.stringContaining('Bash result passed through')]);
  });
});

describe('api key lookup', () => {
  it('parses the jev-kit env file', () => {
    expect(keyFromEnvFile('# c\nTYPESAFE_API_KEY=abc123\n')).toBe('abc123');
    expect(keyFromEnvFile('export TYPESAFE_API_KEY="q w"')).toBe('q w');
    expect(keyFromEnvFile("TYPESAFE_API_KEY='k'")).toBe('k');
    expect(keyFromEnvFile('OTHER=1')).toBeUndefined();
    expect(keyFromEnvFile('TYPESAFE_API_KEY=')).toBeUndefined();
  });

  it('falls back to the kit file when env and settings have no key', async () => {
    const reads: string[] = [];
    const calls = { fetches: 0 };
    const base = engine(() => 0.1, [], calls);
    const noKey = {
      ...base,
      env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
      fs: {
        read: async (path: string) => {
          reads.push(path);
          return 'TYPESAFE_API_KEY=from-file\n';
        },
      },
    };
    const out = (await registered({ chunkLines: 20 }).handler(
      noKey,
      { tool: 'Bash', command: 'x' },
      async () => bashResult(output),
    )) as { result: { stdout: string } };
    expect(reads).toEqual(['/home/u/.config/jev-kit/env']);
    expect(calls.fetches).toBe(1);
    expect(out.result.stdout).toContain('omitted Bash output');
  });
});
