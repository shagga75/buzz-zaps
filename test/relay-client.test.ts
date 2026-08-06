import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Relay } from 'nostr-tools/relay';
import { fetchChannelAdmins, hasMergeStatusEvent, subscribeGlobal, subscribeToChannel, watchConnectionState } from '../src/bot/relay-client.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => noopLogger } as any;

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

describe('hasMergeStatusEvent', () => {
  const targetEventId = 'pr'.padEnd(64, '1');

  function fakeMergeRelay(hasEvent: boolean, { skipEose = false } = {}): Relay {
    return {
      subscribe: (filters: any[], handlers: any) => {
        const filter = filters[0];
        queueMicrotask(() => {
          if (filter.kinds?.[0] === 1631 && filter['#e']?.[0] === targetEventId && hasEvent) {
            handlers.onevent?.({ id: 'merge-1', kind: 1631, tags: [['e', targetEventId, '', 'root']] });
          } else if (!skipEose) {
            handlers.oneose?.();
          }
        });
        return { close: vi.fn() };
      },
    } as unknown as Relay;
  }

  it('resolves true when a kind:1631 event references the target', async () => {
    const relay = fakeMergeRelay(true);
    expect(await hasMergeStatusEvent(relay, targetEventId)).toBe(true);
  });

  it('resolves false (fails closed) when nothing comes back before EOSE', async () => {
    const relay = fakeMergeRelay(false);
    expect(await hasMergeStatusEvent(relay, targetEventId)).toBe(false);
  });

  it('resolves false (fails closed) on timeout', async () => {
    const relay = fakeMergeRelay(false, { skipEose: true });
    expect(await hasMergeStatusEvent(relay, targetEventId, 20)).toBe(false);
  });
});

describe('watchConnectionState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function noopLoggerFactory() {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger } as any;
    return logger;
  }

  it('logs a warning on drop and an info on recovery', () => {
    vi.useFakeTimers();
    const logger = noopLoggerFactory();
    const relay = { url: 'ws://test', connected: true } as unknown as Relay;

    const stop = watchConnectionState(relay, logger, 1000);

    (relay as { connected: boolean }).connected = false;
    vi.advanceTimersByTime(1000);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://test' }), expect.stringContaining('lost'));

    (relay as { connected: boolean }).connected = true;
    vi.advanceTimersByTime(1000);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://test' }), expect.stringContaining('restored'));

    stop();
  });

  it('logs nothing while the connection stays stable', () => {
    vi.useFakeTimers();
    const logger = noopLoggerFactory();
    const relay = { url: 'ws://test', connected: true } as unknown as Relay;

    const stop = watchConnectionState(relay, logger, 1000);
    vi.advanceTimersByTime(5000);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();

    stop();
  });

  it('stops polling once stopped', () => {
    vi.useFakeTimers();
    const logger = noopLoggerFactory();
    const relay = { url: 'ws://test', connected: true } as unknown as Relay;

    const stop = watchConnectionState(relay, logger, 1000);
    stop();
    (relay as { connected: boolean }).connected = false;
    vi.advanceTimersByTime(5000);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// Both subscribeToChannel and subscribeGlobal forward the relay's close
// reason to an optional onClose callback — index.ts uses it to resubscribe
// when the relay closes a subscription for a reason other than our own
// shutdown (confirmed live: a reconnect can race NIP-42 re-auth and get
// closed with "auth-required: not authenticated", and nostr-tools never
// retries a closed subscription on its own).
describe('subscribeToChannel onClose', () => {
  it('forwards the relay-reported close reason to the onClose callback', () => {
    let capturedHandlers: any;
    const relay = {
      subscribe: (_filters: any[], handlers: any) => {
        capturedHandlers = handlers;
        return { close: vi.fn() };
      },
    } as unknown as Relay;
    const onClose = vi.fn();

    subscribeToChannel(relay, channelId, [9], vi.fn(), noopLogger, onClose);
    capturedHandlers.onclose('auth-required: not authenticated');

    expect(onClose).toHaveBeenCalledWith('auth-required: not authenticated');
  });
});

describe('subscribeGlobal onClose', () => {
  it('forwards the relay-reported close reason to the onClose callback', () => {
    let capturedHandlers: any;
    const relay = {
      subscribe: (_filters: any[], handlers: any) => {
        capturedHandlers = handlers;
        return { close: vi.fn() };
      },
    } as unknown as Relay;
    const onClose = vi.fn();

    subscribeGlobal(relay, [1631], vi.fn(), noopLogger, undefined, onClose);
    capturedHandlers.onclose('auth-required: not authenticated');

    expect(onClose).toHaveBeenCalledWith('auth-required: not authenticated');
  });
});
