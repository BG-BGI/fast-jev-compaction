import { noulAnswer } from './request.js';
import { estimateTokens } from './state.js';
import type { JevAsker, JevQuestions } from './types.js';

export interface ResultOptions {
  /** Ongoing task description the output is judged against. */
  goal?: string;
  /** Minimum keep probability for a chunk to stay. Default 0.5. */
  keepThreshold?: number;
  /** Outputs shorter than this many characters are never touched. Default 4000. */
  minChars?: number;
  /** Lines per chunk; widened so an output never has more than `maxChunks`. Default 20. */
  chunkLines?: number;
  /** Ceiling on chunks (and so on questions) per output. Default 40. */
  maxChunks?: number;
  /** Estimated token ceiling for the state sent to Jev. Default 20000. */
  maxStateTokens?: number;
  /** The rewrite is discarded when it saves less than this share of characters. Default 0.25. */
  minReductionRatio?: number;
  /** Keep the output's line count: every omitted line becomes a placeholder (for numbered `Read` output). */
  keepLineCount?: boolean;
}

export interface ResolvedResultOptions {
  goal: string;
  keepThreshold: number;
  minChars: number;
  chunkLines: number;
  maxChunks: number;
  maxStateTokens: number;
  minReductionRatio: number;
  keepLineCount: boolean;
}

export interface ResultSource {
  tool: string;
  input: Record<string, unknown>;
}

export interface ChunkDecision {
  index: number;
  firstLine: number;
  lastLine: number;
  keep: number;
  kept: boolean;
  reason: 'edge' | 'kept' | 'dropped';
}

export interface ResultCompaction {
  text: string;
  changed: boolean;
  charsBefore: number;
  charsAfter: number;
  chunks: number;
  omittedChunks: number;
  decisions: ChunkDecision[];
}

export const DEFAULT_RESULT_OPTIONS: ResolvedResultOptions = {
  goal: '',
  keepThreshold: 0.5,
  minChars: 4000,
  chunkLines: 20,
  maxChunks: 40,
  maxStateTokens: 20_000,
  minReductionRatio: 0.25,
  keepLineCount: false,
};

export const RESULT_CONTEXT =
  'A coding assistant just ran a tool. `chunks` is the tool output cut into consecutive line ranges; a long chunk shows only its head and tail. Each question asks whether one range must stay in the assistant\'s context verbatim. A range that is not kept is replaced by a one-line note and the assistant can re-run the tool with a narrower command.';

const INPUT_CHARS = 1000;
const CHARS_PER_TOKEN = 3;
const MIN_PREVIEW_CHARS = 120;
const PREVIEW_HEAD_SHARE = 0.7;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveResultOptions(options: ResultOptions = {}): ResolvedResultOptions {
  const defaults = DEFAULT_RESULT_OPTIONS;
  return {
    goal: options.goal ?? defaults.goal,
    keepThreshold: finite(options.keepThreshold, defaults.keepThreshold),
    minChars: Math.max(0, finite(options.minChars, defaults.minChars)),
    chunkLines: Math.max(1, Math.floor(finite(options.chunkLines, defaults.chunkLines))),
    maxChunks: Math.max(2, Math.floor(finite(options.maxChunks, defaults.maxChunks))),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, defaults.maxStateTokens)),
    minReductionRatio: finite(options.minReductionRatio, defaults.minReductionRatio),
    keepLineCount: options.keepLineCount ?? defaults.keepLineCount,
  };
}

/** Consecutive line ranges, each `size` lines wide, with `size` widened to stay within `maxChunks`. */
export function chunkOutput(
  lines: readonly string[],
  chunkLines: number,
  maxChunks: number,
): string[][] {
  const size = Math.max(chunkLines, Math.ceil(lines.length / maxChunks));
  const chunks: string[][] = [];
  for (let start = 0; start < lines.length; start += size) {
    chunks.push(lines.slice(start, start + size));
  }
  return chunks;
}

function preview(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * PREVIEW_HEAD_SHARE);
  const tail = budget - head;
  return `${text.slice(0, head)}\n[… ${text.length - budget} chars omitted …]\n${text.slice(-tail)}`;
}

function serialiseInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input).slice(0, INPUT_CHARS);
  } catch {
    return '';
  }
}

export function resultState(
  source: ResultSource,
  chunks: readonly string[][],
  options: Pick<ResolvedResultOptions, 'goal' | 'maxStateTokens'>,
): object {
  const budget = Math.max(
    MIN_PREVIEW_CHARS,
    Math.floor((options.maxStateTokens * CHARS_PER_TOKEN) / chunks.length),
  );
  let line = 1;
  const described = chunks.map((chunk, index) => {
    const entry = {
      i: index,
      lines: `${line}-${line + chunk.length - 1}`,
      text: preview(chunk.join('\n'), budget),
    };
    line += chunk.length;
    return entry;
  });
  return {
    context: RESULT_CONTEXT,
    goal: options.goal,
    tool: source.tool,
    input: serialiseInput(source.input),
    chunks: described,
  };
}

export function chunkQuestions(
  source: ResultSource,
  chunks: readonly string[][],
): JevQuestions {
  const questions: JevQuestions = {};
  let line = 1;
  chunks.forEach((chunk, index) => {
    const last = line + chunk.length - 1;
    if (index > 0 && index < chunks.length - 1) {
      questions[`chunk_${index}`] = {
        type: 'noul',
        instructions: `Lines ${line}-${last} of this ${source.tool} output should stay in the assistant's context verbatim: they hold something it needs for the user's goal (an error or failure, a match, a value or name it will act on) that the rest of the output does not already say`,
      };
    }
    line = last + 1;
  });
  return questions;
}

function omissionNote(first: number, last: number, tool: string): string {
  const count = last - first + 1;
  return `[fast-jev-compaction omitted ${tool} output lines ${first}-${last} (${count} line${
    count === 1 ? '' : 's'
  }); re-run with a narrower command if needed]`;
}

const LINE_PLACEHOLDER = '[…]';

export function applyChunkDecisions(
  chunks: readonly string[][],
  decisions: readonly ChunkDecision[],
  tool: string,
  keepLineCount = false,
): string {
  const out: string[] = [];
  let line = 1;
  let skipped: { first: number; last: number } | undefined;
  const flush = (): void => {
    if (skipped) {
      out.push(omissionNote(skipped.first, skipped.last, tool));
      if (keepLineCount) {
        for (let n = skipped.first + 1; n <= skipped.last; n += 1) out.push(LINE_PLACEHOLDER);
      }
    }
    skipped = undefined;
  };
  chunks.forEach((chunk, index) => {
    const last = line + chunk.length - 1;
    if (decisions[index]?.kept) {
      flush();
      out.push(...chunk);
    } else {
      skipped = { first: skipped?.first ?? line, last };
    }
    line = last + 1;
  });
  flush();
  return out.join('\n');
}

function decide(
  index: number,
  total: number,
  firstLine: number,
  lastLine: number,
  keep: number,
  threshold: number,
): ChunkDecision {
  const base = { index, firstLine, lastLine, keep };
  if (index === 0 || index === total - 1) return { ...base, kept: true, reason: 'edge' };
  return keep >= threshold
    ? { ...base, kept: true, reason: 'kept' }
    : { ...base, kept: false, reason: 'dropped' };
}

function unchanged(text: string, chunks: number): ResultCompaction {
  return {
    text,
    changed: false,
    charsBefore: text.length,
    charsAfter: text.length,
    chunks,
    omittedChunks: 0,
    decisions: [],
  };
}

/**
 * Scores the line ranges of one fresh tool output against the user's goal in a
 * single Jev request and drops the ranges that score below `keepThreshold`.
 * The first and last range always stay; everything kept is verbatim. Returns
 * the original text when the output is short, has too few ranges, or the
 * rewrite saves less than `minReductionRatio`. Throws when Jev fails or the
 * state cannot fit; the caller decides to pass the output through untouched.
 */
export async function compactToolResult(
  text: string,
  source: ResultSource,
  asker: JevAsker,
  options: ResultOptions = {},
): Promise<ResultCompaction> {
  const resolved = resolveResultOptions(options);
  if (text.length < resolved.minChars) return unchanged(text, 0);
  const chunks = chunkOutput(text.split('\n'), resolved.chunkLines, resolved.maxChunks);
  if (chunks.length < 3) return unchanged(text, chunks.length);

  const state = resultState(source, chunks, resolved);
  if (estimateTokens(JSON.stringify(state)) > resolved.maxStateTokens) {
    throw new Error('tool output leaves no room under maxStateTokens');
  }
  const { answers } = await asker.ask(state, chunkQuestions(source, chunks));

  let line = 1;
  const decisions = chunks.map((chunk, index) => {
    const last = line + chunk.length - 1;
    const edge = index === 0 || index === chunks.length - 1;
    const keep = edge ? 1 : noulAnswer(answers, `chunk_${index}`);
    const decision = decide(index, chunks.length, line, last, keep, resolved.keepThreshold);
    line = last + 1;
    return decision;
  });
  const omittedChunks = decisions.filter((decision) => !decision.kept).length;
  const compacted = applyChunkDecisions(chunks, decisions, source.tool, resolved.keepLineCount);
  const reduction = (text.length - compacted.length) / text.length;
  if (omittedChunks === 0 || reduction < resolved.minReductionRatio) {
    return { ...unchanged(text, chunks.length), decisions };
  }
  return {
    text: compacted,
    changed: true,
    charsBefore: text.length,
    charsAfter: compacted.length,
    chunks: chunks.length,
    omittedChunks,
    decisions,
  };
}
