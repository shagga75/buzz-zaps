import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Relay } from 'nostr-tools/relay';
import { generateSecretKey } from 'nostr-tools/pure';
import { handleMergeStatus, KIND_GIT_PULL_REQUEST, KIND_GIT_STATUS_MERGED } from '../src/bot/bounty-flow.js';
import { BountyStore } from '../src/db/bounties.js';
import { LinkStore } from '../src/db/links.js';
import { LaWalletError, type LaWalletClient } from '../src/lightning/lawallet-client.js';
import type { AppConfig } from '../src/config.js';

vi.mock('../src/bot/relay-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot/relay-client.js')>();
  return { ...actual, fetchEventById: vi.fn() };
});
import { fetchEventById } from '../src/bot/relay-client.js';

const botSecretKey = generateSecretKey();
const config = { channelId: 'chan-1', buzzRelayUrl: 'ws://localhost:3000', zapReceiptExtraRelays: [] } as unknown as AppConfig;
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => noopLogger } as any;

const authorPubkey = 'author'.padEnd(64, '1');
const creatorPubkey = 'creator'.padEnd(64, '2');
const prId = 'pr'.padEnd(64, '3');

function mergeEvent(overrides: Partial<{ id: string; tags: string[][] }> = {}) {
  return {
    id: overrides.id ?? 'merge-1',
    kind: KIND_GIT_STATUS_MERGED,
    pubkey: 'merger'.padEnd(64, '4'),
    tags: overrides.tags ?? [['e', prId, '', 'root']],
  } as any;
}

beforeEach(() => {
  vi.mocked(fetchEventById).mockReset();
});

describe('handleMergeStatus', () => {
  it('does nothing if no bounty was registered for the PR', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { hasSourceEvent: () => false, insertPending: vi.fn() } as any;
    const bounties = new BountyStore(':memory:'); // nothing registered
    const links = new LinkStore(':memory:');

    await handleMergeStatus(mergeEvent(), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      bounties,
      logger: noopLogger,
    });

    expect(fetchEventById).not.toHaveBeenCalled();
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips if the bounty target turns out not to be a pull request', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { hasSourceEvent: () => false, insertPending: vi.fn() } as any;
    const bounties = new BountyStore(':memory:');
    bounties.register(prId, 5000, creatorPubkey);
    const links = new LinkStore(':memory:');
    links.link(authorPubkey, 'satoshi');
    vi.mocked(fetchEventById).mockResolvedValue({ id: prId, kind: 1621, pubkey: authorPubkey } as any); // 1621 = issue, not PR

    await handleMergeStatus(mergeEvent(), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      bounties,
      logger: noopLogger,
    });

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('refuses to pay out when the PR author is the same pubkey that set the bounty', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { hasSourceEvent: () => false, insertPending: vi.fn() } as any;
    const bounties = new BountyStore(':memory:');
    bounties.register(prId, 5000, creatorPubkey);
    const links = new LinkStore(':memory:');
    links.link(creatorPubkey, 'satoshi');
    vi.mocked(fetchEventById).mockResolvedValue({ id: prId, kind: KIND_GIT_PULL_REQUEST, pubkey: creatorPubkey } as any);

    await handleMergeStatus(mergeEvent(), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      bounties,
      logger: noopLogger,
    });

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips silently when the PR author never ran /link', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { hasSourceEvent: () => false, insertPending: vi.fn() } as any;
    const bounties = new BountyStore(':memory:');
    bounties.register(prId, 5000, creatorPubkey);
    const links = new LinkStore(':memory:'); // author never linked
    vi.mocked(fetchEventById).mockResolvedValue({ id: prId, kind: KIND_GIT_PULL_REQUEST, pubkey: authorPubkey } as any);

    await handleMergeStatus(mergeEvent(), {
      relay,
      config,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      links,
      bounties,
      logger: noopLogger,
    });

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('ignores merge events it has already processed (idempotency)', async () => {
    const relay = { publish: vi.fn() } as unknown as Relay;
    const store = { hasSourceEvent: () => true, insertPending: vi.fn() } as any;
    const bounties = new BountyStore(':memory:');
    const getOpenSpy = vi.spyOn(bounties, 'getOpen');
    const links = new LinkStore(':memory:');

    await handleMergeStatus(mergeEvent(), { relay, config, botSecretKey, lawallet: {} as LaWalletClient, store, links, bounties, logger: noopLogger });

    expect(getOpenSpy).not.toHaveBeenCalled();
    expect(fetchEventById).not.toHaveBeenCalled();
  });

  it('runs the zap flow and leaves the bounty open when the payout fails', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const store = { hasSourceEvent: () => false, insertPending: vi.fn() } as any;
    const bounties = new BountyStore(':memory:');
    bounties.register(prId, 5000, creatorPubkey);
    const links = new LinkStore(':memory:');
    links.link(authorPubkey, 'satoshi');
    vi.mocked(fetchEventById).mockResolvedValue({ id: prId, kind: KIND_GIT_PULL_REQUEST, pubkey: authorPubkey } as any);
    const lawallet = { requestInvoice: vi.fn().mockRejectedValue(new LaWalletError('no route')) } as unknown as LaWalletClient;

    await handleMergeStatus(mergeEvent(), { relay, config, botSecretKey, lawallet, store, links, bounties, logger: noopLogger });

    expect(lawallet.requestInvoice).toHaveBeenCalledWith('satoshi', 5000, expect.stringContaining(prId));
    expect(relay.publish).toHaveBeenCalledTimes(1);
    expect(bounties.getOpen(prId)).not.toBeNull(); // still open — payout failed, don't mark it paid
  });
});
