import { describe, expect, it, vi } from 'vitest';
import type { Relay } from 'nostr-tools/relay';
import { fetchChannelAdmins } from '../src/bot/relay-client.js';

const channelId = 'chan-1';
const alice = 'alice'.padEnd(64, '1');
const bob = 'bob'.padEnd(64, '2');

function fakeRelay(events: { created_at: number; tags: string[][] }[], { skipEose = false } = {}): Relay {
  return {
    subscribe: (filters: any[], handlers: any) => {
      const filter = filters[0];
      queueMicrotask(() => {
        if (filter.kinds?.[0] === 39001 && filter['#d']?.[0] === channelId) {
          for (const evt of events) handlers.onevent?.(evt);
          if (!skipEose) handlers.oneose?.();
        } else if (!skipEose) {
          handlers.oneose?.();
        }
      });
      return { close: vi.fn() };
    },
  } as unknown as Relay;
}

describe('fetchChannelAdmins', () => {
  it('collects every pubkey from the p tags on the kind:39001 event', async () => {
    const relay = fakeRelay([{ created_at: 100, tags: [['d', channelId], ['p', alice], ['p', bob]] }]);

    const admins = await fetchChannelAdmins(relay, channelId);

    expect(admins).toEqual(new Set([alice, bob]));
  });

  it('uses only the most recent event when more than one is delivered', async () => {
    const relay = fakeRelay([
      { created_at: 100, tags: [['d', channelId], ['p', alice]] },
      { created_at: 200, tags: [['d', channelId], ['p', bob]] }, // newer — supersedes alice-only snapshot
    ]);

    const admins = await fetchChannelAdmins(relay, channelId);

    expect(admins).toEqual(new Set([bob]));
  });

  it('resolves an empty set (fails closed) when nothing comes back before EOSE', async () => {
    const relay = fakeRelay([]);

    const admins = await fetchChannelAdmins(relay, channelId);

    expect(admins).toEqual(new Set());
  });

  it('resolves an empty set (fails closed) on timeout', async () => {
    const relay = fakeRelay([], { skipEose: true }); // relay never sends EOSE

    const admins = await fetchChannelAdmins(relay, channelId, 20);

    expect(admins).toEqual(new Set());
  });
});
