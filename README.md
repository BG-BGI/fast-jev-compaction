# fast-jev-compaction

Claude Code plugin with two compaction modes, selected by the `mode` option
(`tool` by default, `session`, or `both`). In `tool` mode a `tool.call` hook scores the line ranges of each long output against your
goal in one fast Jev request, omits the ranges that do not matter, and keeps
everything else verbatim. The whole-transcript compactor is still available as
an npm library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) whose `tool.call` hook uses the package to shrink
tool results before the model reads them.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Redaction (BG-BGI fork)

Every state and question is passed through `src/redact.ts` before it leaves the
machine: API keys, GitHub/Slack/AWS tokens, JWTs, bearer tokens, `*_SECRET=`/
`*_TOKEN=`/`password=` values, private key blocks, emails, and bare 32+ char
hex/base64 runs become `[REDACTED]`. Ported from jev-kit `airlock/redact.py`.
The hook always redacts; `compactMessages` does unless `redact: false`. This is
pattern matching, not a guarantee: document prose, names and paths still go to
Jev.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

### Modes

| `mode` | Hooks registered | What it does |
| --- | --- | --- |
| `tool` (default) | `tool.call` | Trims long Bash/MCP (and opt-in `Read`) results as they arrive. Sends one tool output at a time. |
| `session` | `session.compact`, `turn.complete` | Replaces the built-in summary with whole-transcript compaction, and requests compaction at `compactAtPercent` (60) of the context window. Sends up to `maxStateTokens` of conversation state per request. |
| `both` | all three | Tool results are trimmed on arrival, and the session compactor runs at the threshold. |

Session-mode options: `compactAtPercent`, `preserveRecentMessages`,
`maxRequestTokens`, `truncateHeadChars` (plus the shared `keepThreshold`,
`maxStateTokens`, `minReductionRatio`). `maxStateTokens` defaults to 20000 in
the plugin manifest, so the plugin passes that to the session compactor too;
the library default is 25000. Session mode falls back to the built-in summary
when Jev fails or the reduction is below `minReductionRatio`.

The sections below describe `tool` mode.

The repository root is a Claude Code function-hook plugin. `hooks/fast-jev.ts`
registers one `tool.call` hook, instead of hooking `session.compact`. It covers
`Bash` (`stdout`), every MCP tool (`mcp__*`: string results and text blocks, other
blocks and fields untouched) and, with the `compactRead` option, text `Read`
results:

1. `next(event)` runs the command; the hook gets the result before it is
   recorded or shown to the model.
2. Outputs under `minChars` (4000), failed commands, backgrounded commands and
   outputs the engine already persisted to disk pass through untouched.
3. Otherwise `stdout` is cut into `chunkLines`-line ranges (widened to at most
   `maxChunks`), sent to Jev with the user's last prompts as the goal, and each
   middle range gets one `noul` question: does it hold something the assistant
   needs (an error, a match, a value it will act on) that the rest does not say.
4. Ranges below `keepThreshold` are replaced by one note
   (`[fast-jev-compaction omitted Bash output lines 21-60 (40 lines); re-run with a narrower command if needed]`).
   The first and last range always stay; everything kept is verbatim; `stderr`
   is never touched.
5. The hook returns `{ result }` with the rewritten `stdout`, so core validates
   it against Bash's output schema and records the compacted result.
6. If the rewrite saves less than `minReductionRatio`, Jev fails, or the key is
   missing, the original result is returned unchanged.

The library entry point is `compactToolResult(text, { tool, input }, asker, options)`
in `src/result.ts`. Nothing is sent to Jev unredacted (see Redaction).

`Read` is opt-in (`compactRead`): omitted lines become `[…]` placeholders so the
line count and numbering stay correct. Not covered: `Grep`/`Glob` (not
tool.call-able built-ins in this build), `WebFetch` (already model-summarized)
and other built-ins.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin:

```sh
claude plugin marketplace add <owner>/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

To run from a checkout without installing:
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .` from the repository
root. Every compacted result logs `decisions: 1-20:keep/1.00 21-40:drop/0.12 …`
and a size summary to the transcript.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
