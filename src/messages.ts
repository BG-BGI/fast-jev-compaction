import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import { redactingAsker } from './redact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions & { redact?: boolean };

/** `compact` with a `JevClient` built from the options (key from `TYPESAFE_API_KEY` by default). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  const client = new JevClient(options);
  return compact(messages, options.redact === false ? client : redactingAsker(client), options);
}
