import { describe, expect, it } from 'vitest';
import { parseZapCommand } from '../src/bot/command-parser.js';

const pTag = ['p', 'a'.repeat(64)];

describe('parseZapCommand', () => {
  it('parses a well-formed /zap command with a mention tag', () => {
    const result = parseZapCommand({ content: '/zap @alice 100', tags: [pTag] });
    expect(result).toEqual({ targetUsername: 'alice', amountSats: 100, targetPubkey: pTag[1] });
  });

  it('returns null when there is no p tag for the mention', () => {
    const result = parseZapCommand({ content: '/zap @alice 100', tags: [] });
    expect(result).toBeNull();
  });

  it('returns null for non-command messages', () => {
    expect(parseZapCommand({ content: 'hey @alice thanks', tags: [pTag] })).toBeNull();
  });

  it('returns null for a zero or negative amount', () => {
    expect(parseZapCommand({ content: '/zap @alice 0', tags: [pTag] })).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    const result = parseZapCommand({ content: '  /zap @bob.dev 21  ', tags: [pTag] });
    expect(result?.targetUsername).toBe('bob.dev');
    expect(result?.amountSats).toBe(21);
  });
});
