import { describe, expect, it } from 'vitest';
import { MessageAuthorCache } from '../src/bot/message-author-cache.js';

describe('MessageAuthorCache', () => {
  it('returns the author for a cached event id', () => {
    const cache = new MessageAuthorCache();
    cache.set('event-1', 'pubkey-a');
    expect(cache.get('event-1')).toBe('pubkey-a');
  });

  it('returns undefined for an unknown event id', () => {
    const cache = new MessageAuthorCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the oldest entry once maxSize is reached', () => {
    const cache = new MessageAuthorCache(2);
    cache.set('event-1', 'pubkey-a');
    cache.set('event-2', 'pubkey-b');
    cache.set('event-3', 'pubkey-c');
    expect(cache.get('event-1')).toBeUndefined();
    expect(cache.get('event-2')).toBe('pubkey-b');
    expect(cache.get('event-3')).toBe('pubkey-c');
  });
});
