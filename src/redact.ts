import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export const REDACTED = '[REDACTED]';

/** Ported from jev-kit airlock/redact.py, plus emails, AWS keys and PEM blocks. */
const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /apikey_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[a-zA-Z]-[A-Za-z0-9-]+/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /Bearer\s+\S+/g,
  /[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Za-z0-9_]*=\S+/gi,
  /(?:--)?password[= ]+\S+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
];

/** Replaces every token-like substring; never throws, fails toward over-redaction. */
export function redact(text: string): string {
  try {
    return PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
  } catch {
    return REDACTED;
  }
}

/** Redacts every string value in a JSON-like structure; keys are left alone. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redactValue(inner)]),
    ) as T;
  }
  return value;
}

/** Wraps an asker so nothing reaches Jev unredacted. */
export function redactingAsker(inner: JevAsker): JevAsker {
  return {
    ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      return inner.ask(redactValue(state), redactValue(questions));
    },
  };
}
