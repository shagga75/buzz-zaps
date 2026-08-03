import { describe, expect, it } from 'vitest';
import { parseLinkCommand } from '../src/bot/command-parser.js';

describe('parseLinkCommand', () => {
  it('parses a well-formed /link command', () => {
    expect(parseLinkCommand({ content: '/link satoshi' })).toEqual({ lawalletUsername: 'satoshi' });
  });

  it('rejects usernames with uppercase or symbols LaWallet would reject', () => {
    expect(parseLinkCommand({ content: '/link Satoshi' })).toBeNull();
    expect(parseLinkCommand({ content: '/link sat.oshi' })).toBeNull();
  });

  it('rejects usernames over 16 characters', () => {
    expect(parseLinkCommand({ content: '/link ' + 'a'.repeat(17) })).toBeNull();
  });

  it('returns null for non-command messages', () => {
    expect(parseLinkCommand({ content: 'link me up' })).toBeNull();
  });
});
