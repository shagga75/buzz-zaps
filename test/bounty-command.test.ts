import { describe, expect, it } from 'vitest';
import { parseBountyCommand } from '../src/bot/command-parser.js';

const id = 'a'.repeat(64);

describe('parseBountyCommand', () => {
  it('parses a well-formed /bounty command', () => {
    expect(parseBountyCommand({ content: `/bounty ${id} 5000` })).toEqual({ targetEventId: id, amountSats: 5000 });
  });

  it('lowercases the event id', () => {
    expect(parseBountyCommand({ content: `/bounty ${id.toUpperCase()} 5000` })?.targetEventId).toBe(id);
  });

  it('rejects event ids that are not 64 hex chars', () => {
    expect(parseBountyCommand({ content: '/bounty deadbeef 5000' })).toBeNull();
    expect(parseBountyCommand({ content: `/bounty ${id}ff 5000` })).toBeNull();
  });

  it('rejects a zero or negative amount', () => {
    expect(parseBountyCommand({ content: `/bounty ${id} 0` })).toBeNull();
  });

  it('returns null for non-command messages', () => {
    expect(parseBountyCommand({ content: 'no bounty here' })).toBeNull();
  });
});
