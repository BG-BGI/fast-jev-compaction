import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import { DEFAULT_MODE, resolveMode } from '../hooks/shared.ts';

function registered(options: Record<string, unknown>): string[] {
  const events: string[] = [];
  const on = ((event: string) => {
    events.push(event);
  }) as unknown as Parameters<typeof register>[0];
  register(on, options as Parameters<typeof register>[1]);
  return events;
}

describe('hook mode', () => {
  it('defaults to tool and ignores unknown values', () => {
    expect(DEFAULT_MODE).toBe('tool');
    expect(resolveMode({})).toBe('tool');
    expect(resolveMode({ mode: 'nope' })).toBe('tool');
    expect(resolveMode({ mode: 'session' })).toBe('session');
    expect(resolveMode({ mode: 'both' })).toBe('both');
  });

  it('registers only the tool.call hook in tool mode', () => {
    expect(registered({})).toEqual(['tool.call']);
    expect(registered({ mode: 'tool' })).toEqual(['tool.call']);
  });

  it('registers session.compact and turn.complete in session mode', () => {
    expect(registered({ mode: 'session' })).toEqual(['session.compact', 'turn.complete']);
  });

  it('registers all three hooks in both mode', () => {
    expect(registered({ mode: 'both' }).sort()).toEqual(['session.compact', 'tool.call', 'turn.complete']);
  });
});
