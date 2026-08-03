import { describe, expect, it, vi } from 'vitest';
import type { Relay } from 'nostr-tools/relay';
import { generateSecretKey } from 'nostr-tools/pure';
import { handleReaction } from '../src/bot/reaction-flow.js';
import { MessageAuthorCache } from '../src/bot/message-author-cache.js';
import { LinkStore } from '../src/db/links.js';
import { LaWalletError, type LaWalletClient } from '../src/lightning/lawallet-client.js';
import type { AppConfig, TriggersFile } from '../src/config.js';

const botSecretKey = generateSecretKey();
const config = { channelId: 'chan-1', buzzRelayUrl: 'ws://localhost:3000', zapReceiptExtraRelays: [] } as unknown as AppConfig;
const triggers: TriggersFile = { triggers: [{ on: 'reaction_added', emoji: '🐝', amount_sats: 21 }] };
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => noopLogger } as any;

function reactionEvent(overrides: Partial<{ content: string; pubkey: string; tags: string[][] }> = {}) {
  return {
    id: 'reaction-1',
    pubkey: overrides.pubkey ?? 'reactor'.padEnd(64, '0'),
    content: overrides.content ?? '🐝',
    tags: overrides.tags ?? [['e', 'msg-1']],
  } as any;
}

describe('handleReaction guards', () => {
  it('ignores reactions whose content does not match a configured trigger', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { insertPending: vi.fn() } as any;
    const links = new LinkStore(':memory:');
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', 'author'.padEnd(64, '1'));

    await handleReaction(reactionEvent({ content: '+' }), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      logger: noopLogger,
      authorCache,
      triggers,
    });

    expect(relay.publish).not.toHaveBeenCalled();
    expect(store.insertPending).not.toHaveBeenCalled();
  });

  it('ignores a reaction to your own message (self-zap)', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { insertPending: vi.fn() } as any;
    const links = new LinkStore(':memory:');
    const authorPubkey = 'author'.padEnd(64, '1');
    links.link(authorPubkey, 'satoshi');
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', authorPubkey);

    await handleReaction(reactionEvent({ content: '🐝', pubkey: authorPubkey }), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      logger: noopLogger,
      authorCache,
      triggers,
    });

    expect(relay.publish).not.toHaveBeenCalled();
    expect(store.insertPending).not.toHaveBeenCalled();
  });

  it('skips silently when the reacted-to author never ran /link', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { insertPending: vi.fn() } as any;
    const links = new LinkStore(':memory:'); // nobody linked
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', 'author'.padEnd(64, '1'));

    await handleReaction(reactionEvent({ content: '🐝' }), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      logger: noopLogger,
      authorCache,
      triggers,
    });

    expect(relay.publish).not.toHaveBeenCalled();
    expect(store.insertPending).not.toHaveBeenCalled();
  });

  it('runs the zap flow once the trigger matches and the author is linked', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const store = { insertPending: vi.fn() } as any;
    const links = new LinkStore(':memory:');
    const authorPubkey = 'author'.padEnd(64, '1');
    links.link(authorPubkey, 'satoshi');
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', authorPubkey);
    const lawallet = { requestInvoice: vi.fn().mockRejectedValue(new LaWalletError('no route')) } as unknown as LaWalletClient;

    await handleReaction(reactionEvent({ content: '🐝' }), {
      relay,
      config,
      botSecretKey,
      lawallet,
      store,
      links,
      logger: noopLogger,
      authorCache,
      triggers,
    });

    expect(lawallet.requestInvoice).toHaveBeenCalledWith('satoshi', 21, expect.stringContaining('reaction zap'));
    expect(relay.publish).toHaveBeenCalledTimes(1);
    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.content).toContain('@satoshi');
  });
});
