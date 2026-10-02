import type { On, PluginOptions, Register } from 'claude-code';

import { registerSessionCompact } from './session-compact.js';
import { resolveMode } from './shared.js';
import { registerToolCall } from './tool-call.js';

export const register: Register = (on: On, options: PluginOptions) => {
  const mode = resolveMode(options);
  if (mode !== 'session') registerToolCall(on, options);
  if (mode !== 'tool') registerSessionCompact(on, options);
};

export * from './shared.js';
export * from './session-compact.js';
export * from './tool-call.js';
