import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import { RECALL_FULL_NAME } from '../hooks/tool-call.ts';
import { fetchRange, saveRanges, type RunProcess } from '../src/recall.js';
import { applyChunkDecisions, compactToolResult, omittedRanges } from '../src/result.js';
import type { JevAsker } from '../src/types.js';

const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`);
const output = lines.join('\n');
const config = { airlockDir: '/kit/current', ttlDays: 7, maxMB: 50, maxChars: 20_000 };

const asker = (keep: (name: string) => number): JevAsker => ({
  async ask(_state, questions) {
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: 'noul', noul: keep(key) }]),
      ),
    } as never;
  },
});

const ok = (body: unknown): RunProcess => async () => ({
  exitCode: 0,
  stdout: JSON.stringify(body),
  stderr: '',
});

describe('omittedRanges', () => {
  it('merges consecutive dropped chunks and carries their lines', () => {
    const chunks = [lines.slice(0, 20), lines.slice(20, 40), lines.slice(40, 60), lines.slice(60)];
    const decisions = [true, false, false, true].map((kept, index) => ({
      index, firstLine: 0, lastLine: 0, keep: 0, kept, reason: 'kept' as const,
    }));
    const ranges = omittedRanges(chunks, decisions);
    expect(ranges).toEqual([{ first: 21, last: 60, text: lines.slice(20, 60).join('\n') }]);
    expect(applyChunkDecisions(chunks, decisions, 'Bash', false, 'r_ab12cd34')).toContain(
      'recall ref=r_ab12cd34 range=21-60',
    );
    expect(applyChunkDecisions(chunks, decisions, 'Bash')).toContain('re-run with a narrower command');
  });
});

describe('compactToolResult with saveOmitted', () => {
  const keep = (name: string) => (name === 'chunk_2' ? 0.9 : 0.1);

  it('stores the dropped text once and names the ref in the notes', async () => {
    const saved: unknown[] = [];
    const result = await compactToolResult(output, { tool: 'Bash', input: {} }, asker(keep), {
      chunkLines: 20,
      saveOmitted: async (ranges) => {
        saved.push(ranges);
        return 'r_00000001';
      },
    });
    expect(saved).toHaveLength(1);
    expect(result.recallRef).toBe('r_00000001');
    expect(result.text).toContain('recall ref=r_00000001 range=21-40');
    expect(result.text).toContain('line 41');
    expect(result.text).not.toContain('line 25 ');
  });

  it.each([
    ['throws', async () => { throw new Error('boom'); }],
    ['returns nothing', async () => undefined],
  ])('keeps the old note when saving %s', async (_name, saveOmitted) => {
    const result = await compactToolResult(output, { tool: 'Bash', input: {} }, asker(keep), {
      chunkLines: 20,
      saveOmitted,
    });
    expect(result.changed).toBe(true);
    expect(result.recallRef).toBeUndefined();
    expect(result.text).toContain('re-run with a narrower command if needed');
  });

  it('does not store anything when the rewrite is discarded', async () => {
    let called = false;
    const result = await compactToolResult(output, { tool: 'Bash', input: {} }, asker(() => 1), {
      chunkLines: 20,
      saveOmitted: async () => { called = true; return 'r_00000002'; },
    });
    expect(result.changed).toBe(false);
    expect(called).toBe(false);
  });
});

describe('recall store over the process runner', () => {
  it('pipes a JSON payload to airlock.recall put and returns the ref', async () => {
    let seen: { argv: readonly string[]; stdin?: string; env?: Record<string, string> } | undefined;
    const run: RunProcess = async (argv, init) => {
      seen = { argv, ...(init?.stdin ? { stdin: init.stdin } : {}), ...(init?.env ? { env: init.env } : {}) };
      return { exitCode: 0, stdout: '{"ok": true, "ref": "r_ab12cd34"}', stderr: '' };
    };
    const ref = await saveRanges(run, config, {
      session: 's', tool: 'Bash', ranges: [{ first: 21, last: 22, text: 'a\nb' }],
    });
    expect(ref).toBe('r_ab12cd34');
    expect(seen?.argv.slice(0, 4)).toEqual(['python3', '-m', 'airlock.recall', 'put']);
    expect(seen?.env).toEqual({ PYTHONPATH: '/kit/current' });
    expect(JSON.parse(seen?.stdin ?? '{}').ranges).toEqual([{ start: 21, end: 22, text: 'a\nb' }]);
  });

  it.each([
    ['a non-zero exit', async () => ({ exitCode: 1, stdout: '', stderr: 'x' })],
    ['bad JSON', async () => ({ exitCode: 0, stdout: 'nope', stderr: '' })],
    ['a failed put', ok({ ok: false })],
    ['a malformed ref', ok({ ok: true, ref: '../../etc' })],
    ['a rejected run', async () => { throw new Error('no python'); }],
  ])('returns undefined on %s', async (_name, run) => {
    expect(
      await saveRanges(run as RunProcess, config, { session: 's', tool: 'Bash', ranges: [] }),
    ).toBeUndefined();
  });

  it('validates ref and range before spawning anything', async () => {
    let spawned = false;
    const run: RunProcess = async () => { spawned = true; return { exitCode: 0, stdout: '{}', stderr: '' }; };
    expect((await fetchRange(run, config, { ref: 'r_x; rm -rf /' })).ok).toBe(false);
    expect((await fetchRange(run, config, { ref: 'r_ab12cd34', range: '1-2;x' })).ok).toBe(false);
    expect(spawned).toBe(false);
  });

  it('returns stored text, or the store explanation on a miss', async () => {
    const hit = await fetchRange(ok({ ok: true, text: '21: a' }), config, { ref: 'r_ab12cd34', range: '21-21' });
    expect(hit).toEqual({ ok: true, text: '21: a' });
    const miss = await fetchRange(ok({ ok: false, error: 'unknown or expired ref; re-run the command' }), config, {
      ref: 'r_ab12cd34',
    });
    expect(miss).toEqual({ ok: false, text: 'unknown or expired ref; re-run the command' });
  });

  it('caps maxChars at the configured limit', async () => {
    let argv: readonly string[] = [];
    const run: RunProcess = async (a) => { argv = a; return { exitCode: 0, stdout: '{"ok":true,"text":""}', stderr: '' }; };
    await fetchRange(run, config, { ref: 'r_ab12cd34', maxChars: 999_999 });
    expect(argv[argv.indexOf('--max-chars') + 1]).toBe('20000');
  });
});

type Hook = { name: string; filter: unknown; handler: (...a: never[]) => Promise<unknown> };

function hooks(options: Record<string, unknown> = {}): Hook[] {
  const out: Hook[] = [];
  const on = ((name: string, ...rest: unknown[]) => {
    const handler = rest[rest.length - 1] as Hook['handler'];
    out.push({ name, filter: rest.length > 1 ? rest[0] : undefined, handler });
  }) as unknown as Parameters<typeof register>[0];
  register(on, options as Parameters<typeof register>[1]);
  return out;
}

describe('recall tool hooks', () => {
  const engine = (run: RunProcess, registered: unknown[] = [], logs: string[] = []) => ({
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    process: { run },
    tool: { register: async (spec: unknown) => { registered.push(spec); } },
    ui: { log: (line: string) => { logs.push(line); } },
  });

  it('registers the recall tool at session.start', async () => {
    const registered: unknown[] = [];
    const start = hooks().find((h) => h.name === 'session.start')!;
    await (start.handler as unknown as (...a: unknown[]) => Promise<unknown>)(
      engine(ok({}), registered), {}, async (e: unknown) => e,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ name: 'recall' });
  });

  it('answers a recall call from the store, defaulting airlockDir under HOME', async () => {
    let env: Record<string, string> | undefined;
    const run: RunProcess = async (_argv, init) => {
      env = init?.env;
      return { exitCode: 0, stdout: '{"ok":true,"text":"21: a"}', stderr: '' };
    };
    const recall = hooks().find((h) => h.name === 'tool.call' && h.filter !== undefined)!;
    expect(recall.filter).toEqual({ tool: RECALL_FULL_NAME });
    const out = await (recall.handler as unknown as (...a: unknown[]) => Promise<unknown>)(
      engine(run), { tool: RECALL_FULL_NAME, ref: 'r_ab12cd34', range: '21-21' },
    );
    expect(out).toEqual({ result: '21: a' });
    expect(env).toEqual({ PYTHONPATH: '/home/u/.local/share/airlock/current' });
  });

  it('never re-compacts the recall tool result', async () => {
    const generic = hooks().find((h) => h.name === 'tool.call' && h.filter === undefined)!;
    const big = { result: output };
    let asked = false;
    const out = await (generic.handler as unknown as (...a: unknown[]) => Promise<unknown>)(
      { ...engine(ok({})), http: { fetch: async () => { asked = true; throw new Error('no'); } } },
      { tool: RECALL_FULL_NAME, ref: 'r_ab12cd34' },
      async () => big,
    );
    expect(out).toBe(big);
    expect(asked).toBe(false);
  });
});
