import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactValue, redactingAsker } from '../src/index.js';

describe('redact', () => {
  it.each([
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'sk-abcdefghij1234',
    'Bearer abc.def',
    'DB_PASSWORD=hunter2',
    'jane.doe@example.com',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
    'a'.repeat(40),
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ])('masks %s', (secret) => {
    expect(redact(`before ${secret} after`)).toBe(`before ${REDACTED} after`);
  });

  it('leaves ordinary text and paths alone', () => {
    const text = 'Read src/a.ts: expected 2 to be 3';
    expect(redact(text)).toBe(text);
  });

  it('redacts string values but not keys', () => {
    expect(redactValue({ 'a@b.co': ['x@y.io', 3, null] })).toEqual({
      'a@b.co': [REDACTED, 3, null],
    });
  });

  it('hands the inner asker only redacted state and questions', async () => {
    const seen: unknown[] = [];
    const asker = redactingAsker({
      async ask(state, questions) {
        seen.push(state, questions);
        return { answers: {} };
      },
    });
    await asker.ask({ log: 'mail bob@corp.com' }, {
      q: { type: 'noul', instructions: 'token=abc123' },
    });
    expect(JSON.stringify(seen)).not.toMatch(/bob@corp|abc123/);
  });
});
