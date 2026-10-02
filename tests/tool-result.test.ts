import { describe, expect, it } from 'vitest';
import {
  applyChunkDecisions,
  chunkOutput,
  chunkQuestions,
  compactToolResult,
  resolveResultOptions,
  resultState,
  type ChunkDecision,
  type JevAsker,
} from '../src/index.js';

const SOURCE = { tool: 'Bash', input: { command: 'npm test' } };

function lines(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1} ${'x'.repeat(40)}`);
}

function asker(answer: (name: string) => number, bodies: unknown[] = []): JevAsker {
  return {
    async ask(state, questions) {
      bodies.push({ state, questions });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [name, { type: 'noul', noul: answer(name) }]),
        ),
      };
    },
  };
}

describe('chunkOutput', () => {
  it('cuts into fixed-size ranges and widens to respect maxChunks', () => {
    expect(chunkOutput(lines(45), 20, 40).map((c) => c.length)).toEqual([20, 20, 5]);
    expect(chunkOutput(lines(100), 5, 4).map((c) => c.length)).toEqual([25, 25, 25, 25]);
    expect(chunkOutput([], 20, 40)).toEqual([]);
  });
});

describe('resultState and questions', () => {
  it('numbers line ranges, previews long chunks and skips the edge chunks in the questions', () => {
    const chunks = chunkOutput(lines(60), 20, 40);
    const state = resultState(SOURCE, chunks, { goal: 'fix tests', maxStateTokens: 20 }) as {
      goal: string;
      chunks: { i: number; lines: string; text: string }[];
    };
    expect(state.goal).toBe('fix tests');
    expect(state.chunks.map((c) => c.lines)).toEqual(['1-20', '21-40', '41-60']);
    expect(state.chunks[0]?.text).toMatch(/\[… \d+ chars omitted …\]/);
    expect(Object.keys(chunkQuestions(SOURCE, chunks))).toEqual(['chunk_1']);
  });
});

describe('applyChunkDecisions', () => {
  const chunks = [['a1', 'a2'], ['b1', 'b2'], ['c1'], ['d1']];
  const decision = (index: number, kept: boolean): ChunkDecision => ({
    index,
    firstLine: 0,
    lastLine: 0,
    keep: kept ? 1 : 0,
    kept,
    reason: kept ? 'kept' : 'dropped',
  });

  it('merges adjacent omitted chunks into one note with the right line numbers', () => {
    const out = applyChunkDecisions(
      chunks,
      [decision(0, true), decision(1, false), decision(2, false), decision(3, true)],
      'Bash',
    );
    expect(out.split('\n')).toEqual([
      'a1',
      'a2',
      '[fast-jev-compaction omitted Bash output lines 3-5 (3 lines); re-run with a narrower command if needed]',
      'd1',
    ]);
  });
});

describe('compactToolResult', () => {
  const output = lines(100).join('\n');

  it('leaves short output alone without asking Jev', async () => {
    const bodies: unknown[] = [];
    const result = await compactToolResult('short', SOURCE, asker(() => 0, bodies));
    expect(result).toMatchObject({ changed: false, text: 'short' });
    expect(bodies).toHaveLength(0);
  });

  it('omits the ranges Jev scores below the threshold and keeps the rest verbatim', async () => {
    const bodies: unknown[] = [];
    const result = await compactToolResult(
      output,
      SOURCE,
      asker((name) => (name === 'chunk_3' ? 0.9 : 0.1), bodies),
      { chunkLines: 20 },
    );
    expect(bodies).toHaveLength(1);
    expect(result.changed).toBe(true);
    expect(result.omittedChunks).toBe(2);
    const kept = result.text.split('\n');
    expect(kept.slice(0, 20)).toEqual(output.split('\n').slice(0, 20));
    expect(kept[20]).toContain('omitted Bash output lines 21-60 (40 lines)');
    expect(kept.slice(21)).toEqual(output.split('\n').slice(60));
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it('returns the original when Jev keeps everything or the saving is too small', async () => {
    const keepAll = await compactToolResult(output, SOURCE, asker(() => 0.9));
    expect(keepAll).toMatchObject({ changed: false, text: output, omittedChunks: 0 });
    const small = await compactToolResult(output, SOURCE, asker((n) => (n === 'chunk_2' ? 0 : 1)), {
      chunkLines: 10,
      maxChunks: 10,
      minReductionRatio: 0.5,
    });
    expect(small.changed).toBe(false);
    expect(small.text).toBe(output);
  });

  it('throws when Jev omits an answer or the state cannot fit', async () => {
    const silent: JevAsker = { ask: async () => ({ answers: {} }) };
    await expect(compactToolResult(output, SOURCE, silent)).rejects.toThrow(/Invalid Jev answer/);
    await expect(
      compactToolResult(output, SOURCE, asker(() => 0), { maxStateTokens: 10 }),
    ).rejects.toThrow(/no room/);
  });

  it('resolves options defensively', () => {
    expect(resolveResultOptions({ chunkLines: 0, maxChunks: 0, minChars: -5 })).toMatchObject({
      chunkLines: 1,
      maxChunks: 2,
      minChars: 0,
    });
  });
});
