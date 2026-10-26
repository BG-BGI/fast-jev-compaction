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
  /**
   * Collapse runs of 4+ identical consecutive lines into the first line plus a count note
   * before any scoring: lossless in content, free of Jev cost. Default true. Skipped under
   * `keepLineCount`, whose numbering must survive.
   */
  collapseRepeats?: boolean;
  /**
   * A line longer than this is cut into segments of this many characters so a single-line
   * dump (minified JSON, say) becomes scoreable ranges; omission notes then say "segments"
   * instead of "lines". 0 turns it off. Default 2000. Skipped under `keepLineCount`.
   */
  maxLineChars?: number;
  /**
   * Called once, only when the rewrite is kept, with the text it drops. Returns a ref the
   * omission notes name so the model can ask for the text back. A throw or `undefined` leaves
   * the notes as before.
   */
  saveOmitted?: (ranges: readonly OmittedRange[]) => Promise<string | undefined>;
}

export interface OmittedRange {
  first: number;
  last: number;
  text: string;
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
  collapseRepeats: boolean;
  maxLineChars: number;
  saveOmitted?: ResultOptions['saveOmitted'];
}

/** What one range of output is called in notes and questions. */
export type RangeUnit = 'lines' | 'segments';

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
  /** The ref `saveOmitted` returned; the notes in `text` name it. */
  recallRef?: string;
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
  collapseRepeats: true,
  maxLineChars: 2000,
};

const MIN_REPEAT_RUN = 4;

export const RESULT_CONTEXT =
  'A coding assistant just ran a tool. `goal` is what the user asked for. `chunks` is the tool output cut into consecutive line ranges; a long chunk shows only its head and tail. Each question asks whether one range must stay in the assistant\'s context verbatim. When the goal asks for details, a listing, or the full output, nearly every range must stay. A range that is not kept is replaced by a one-line note and the assistant can re-run the tool with a narrower command, which costs a call.';

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
    collapseRepeats: options.collapseRepeats ?? defaults.collapseRepeats,
    maxLineChars: Math.max(0, finite(options.maxLineChars, defaults.maxLineChars)),
    ...(options.saveOmitted ? { saveOmitted: options.saveOmitted } : {}),
  };
}

/**
 * Runs of `MIN_REPEAT_RUN`+ identical consecutive non-blank lines become the
 * first line plus a visible count note. Nothing is judged and nothing is lost:
 * the count note carries what was removed.
 */
export function collapseRepeatedLines(
  lines: readonly string[],
  minRun = MIN_REPEAT_RUN,
): { lines: string[]; collapsed: number } {
  const out: string[] = [];
  let collapsed = 0;
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] as string;
    let end = at + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const run = end - at;
    if (run >= minRun && line.trim() !== '') {
      out.push(line, `[fast-jev-compaction: previous line repeated ${run - 1} more times]`);
      collapsed += run - 1;
    } else {
      for (let i = at; i < end; i += 1) out.push(lines[i] as string);
    }
    at = end;
  }
  return { lines: out, collapsed };
}

/**
 * Cuts every line longer than `maxLineChars` into segments of that many
 * characters, so a single-line dump becomes ranges Jev can score. The cuts
 * insert line breaks, which the "segments" wording in the notes flags.
 */
export function segmentLongLines(
  lines: readonly string[],
  maxLineChars: number,
): { lines: string[]; segmented: boolean } {
  const out: string[] = [];
  let segmented = false;
  for (const line of lines) {
    if (line.length <= maxLineChars) {
      out.push(line);
      continue;
    }
    segmented = true;
    for (let at = 0; at < line.length; at += maxLineChars) {
      out.push(line.slice(at, at + maxLineChars));
    }
  }
  return { lines: out, segmented };
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
  unit: RangeUnit = 'lines',
): JevQuestions {
  const questions: JevQuestions = {};
  const noun = unit === 'lines' ? 'Lines' : 'Segments';
  let line = 1;
  chunks.forEach((chunk, index) => {
    const last = line + chunk.length - 1;
    if (index > 0 && index < chunks.length - 1) {
      questions[`chunk_${index}`] = {
        type: 'noul',
        instructions: `${noun} ${line}-${last} of this ${source.tool} output should stay in the assistant's context verbatim, because dropping them could weaken its next answer or action for the user's request. Keep them when they hold content the request asks for (listings, details, records, fields, values), an error or failure, a match, or a name or value the assistant will use. Omit them only when they are clearly unrelated noise, boilerplate or padding. Similar-looking records are not redundant: each one counts`,
      };
    }
    line = last + 1;
  });
  return questions;
}

function omissionNote(
  first: number,
  last: number,
  tool: string,
  ref?: string,
  unit: RangeUnit = 'lines',
): string {
  const count = last - first + 1;
  const head = `[fast-jev-compaction omitted ${tool} output ${unit} ${first}-${last} (${count} ${
    unit === 'lines' ? 'line' : 'segment'
  }${count === 1 ? '' : 's'})`;
  return ref
    ? `${head}; recall ref=${ref} range=${first}-${last} to restore, or re-run with a narrower command]`
    : `${head}; re-run with a narrower command if needed]`;
}

/** The runs of consecutive dropped chunks, each with the lines it removed. */
export function omittedRanges(
  chunks: readonly string[][],
  decisions: readonly ChunkDecision[],
): OmittedRange[] {
  const out: OmittedRange[] = [];
  let line = 1;
  let open: { first: number; last: number; lines: string[] } | undefined;
  const close = (): void => {
    if (open) out.push({ first: open.first, last: open.last, text: open.lines.join('\n') });
    open = undefined;
  };
  chunks.forEach((chunk, index) => {
    const last = line + chunk.length - 1;
    if (decisions[index]?.kept) {
      close();
    } else {
      open ??= { first: line, last, lines: [] };
      open.last = last;
      open.lines.push(...chunk);
    }
    line = last + 1;
  });
  close();
  return out;
}

const LINE_PLACEHOLDER = '[…]';

export function applyChunkDecisions(
  chunks: readonly string[][],
  decisions: readonly ChunkDecision[],
  tool: string,
  keepLineCount = false,
  ref?: string,
  unit: RangeUnit = 'lines',
): string {
  const out: string[] = [];
  let line = 1;
  let skipped: { first: number; last: number } | undefined;
  const flush = (): void => {
    if (skipped) {
      out.push(omissionNote(skipped.first, skipped.last, tool, ref, unit));
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
  // Two free pre-passes, both skipped under keepLineCount, whose numbering
  // must match the original: collapse exact-repeat runs (lossless, the note
  // carries the count), then segment over-long lines so a one-line dump
  // becomes ranges Jev can score at all.
  let lines = text.split('\n');
  let collapsed = 0;
  let unit: RangeUnit = 'lines';
  if (!resolved.keepLineCount && resolved.collapseRepeats) {
    const squeezed = collapseRepeatedLines(lines);
    lines = squeezed.lines;
    collapsed = squeezed.collapsed;
  }
  if (!resolved.keepLineCount && resolved.maxLineChars > 0) {
    const cut = segmentLongLines(lines, resolved.maxLineChars);
    if (cut.segmented) {
      lines = cut.lines;
      unit = 'segments';
    }
  }
  const chunks = chunkOutput(lines, resolved.chunkLines, resolved.maxChunks);
  if (chunks.length < 3) {
    // Too few ranges for Jev, but the collapse alone may already pay.
    const squeezedText = lines.join('\n');
    const squeezedReduction = (text.length - squeezedText.length) / text.length;
    if (collapsed > 0 && squeezedReduction >= resolved.minReductionRatio) {
      return {
        text: squeezedText,
        changed: true,
        charsBefore: text.length,
        charsAfter: squeezedText.length,
        chunks: chunks.length,
        omittedChunks: 0,
        decisions: [],
      };
    }
    return unchanged(text, chunks.length);
  }

  const state = resultState(source, chunks, resolved);
  if (estimateTokens(JSON.stringify(state)) > resolved.maxStateTokens) {
    throw new Error('tool output leaves no room under maxStateTokens');
  }
  const { answers } = await asker.ask(state, chunkQuestions(source, chunks, unit));

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
  const compacted = applyChunkDecisions(
    chunks,
    decisions,
    source.tool,
    resolved.keepLineCount,
    undefined,
    unit,
  );
  const reduction = (text.length - compacted.length) / text.length;
  if ((omittedChunks === 0 && collapsed === 0) || reduction < resolved.minReductionRatio) {
    return { ...unchanged(text, chunks.length), decisions };
  }
  let recallRef: string | undefined;
  if (resolved.saveOmitted && omittedChunks > 0) {
    try {
      recallRef = await resolved.saveOmitted(omittedRanges(chunks, decisions));
    } catch {
      recallRef = undefined; // fail open: notes keep the old wording
    }
  }
  const final = recallRef
    ? applyChunkDecisions(chunks, decisions, source.tool, resolved.keepLineCount, recallRef, unit)
    : compacted;
  return {
    text: final,
    changed: true,
    charsBefore: text.length,
    charsAfter: final.length,
    chunks: chunks.length,
    omittedChunks,
    decisions,
    ...(recallRef ? { recallRef } : {}),
  };
}
