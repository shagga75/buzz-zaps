import { describe, expect, it, vi } from 'vitest';
import type { Relay } from 'nostr-tools/relay';
import { generateSecretKey } from 'nostr-tools/pure';
import { handleAgentReply } from '../src/bot/task-completion-flow.js';
import { MessageAuthorCache } from '../src/bot/message-author-cache.js';
import { AgentPubkeyCache } from '../src/bot/agent-cache.js';
import { LaWalletError, type LaWalletClient } from '../src/lightning/lawallet-client.js';
import type { AppConfig, TriggersFile } from '../src/config.js';

const botSecretKey = generateSecretKey();
const botPubkey = 'bot'.padEnd(64, '0');
const config = { channelId: 'chan-1', buzzRelayUrl: 'ws://localhost:3000', zapReceiptExtraRelays: [] } as unknown as AppConfig;
const triggers: TriggersFile = {
  triggers: [{ on: 'agent_task_completed', amount_sats: 50, service_username: 'buzz-zaps-service' }],
};
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => noopLogger } as any;

/** Fake relay whose kind:10100 lookup (hasAgentProfile) reports `agentPubkeys`. */
function fakeRelay(agentPubkeys: Set<string>): Relay {
  return {
    publish: vi.fn(async () => ''),
    subscribe: (filters: any[], handlers: any) => {
      const filter = filters[0];
      if (filter.kinds?.[0] === 10100) {
        const author = filter.authors?.[0];
        if (author && agentPubkeys.has(author)) {
          queueMicrotask(() => handlers.onevent?.({}));
        } else {
          queueMicrotask(() => handlers.oneose?.());
        }
      } else {
        queueMicrotask(() => handlers.oneose?.());
      }
      return { close: vi.fn() };
    },
  } as unknown as Relay;
}

function agentReplyEvent(overrides: Partial<{ id: string; pubkey: string; tags: string[][] }> = {}) {
  return {
    id: overrides.id ?? 'agent-reply-1',
    pubkey: overrides.pubkey ?? 'agent'.padEnd(64, '1'),
    content: 'listo, ya lo hice',
    tags: overrides.tags ?? [['h', 'chan-1'], ['e', 'msg-1', '', 'reply'], ['p', 'human'.padEnd(64, '2')]],
  } as any;
}

describe('handleAgentReply guards', () => {
  it('ignores messages with no NIP-10 reply tag', async () => {
    const relay = fakeRelay(new Set(['agent'.padEnd(64, '1')]));
    const store = { hasSourceEvent: vi.fn(() => false), insertPending: vi.fn() } as any;

    await handleAgentReply(agentReplyEvent({ tags: [['h', 'chan-1']] }), {
      relay,
      config,
      botPubkey,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      logger: noopLogger,
      authorCache: new MessageAuthorCache(),
      agentCache: new AgentPubkeyCache(),
      triggers,
    });

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('ignores a reply from a pubkey with no agent profile', async () => {
    const relay = fakeRelay(new Set()); // nobody is an agent
    const store = { hasSourceEvent: vi.fn(() => false), insertPending: vi.fn() } as any;
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', 'human'.padEnd(64, '2'));

    await handleAgentReply(agentReplyEvent(), {
      relay,
      config,
      botPubkey,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      feeStore: {} as any,
      logger: noopLogger,
      authorCache,
      agentCache: new AgentPubkeyCache(),
      triggers,
    });

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('ignores when the invoker is also an agent (agent-to-agent chain)', async () => {
    const agentPubkey = 'agent'.padEnd(64, '1');
    const invokerPubkey = 'human'.padEnd(64, '2');
    const relay = fakeRelay(new Set([agentPubkey, invokerPubkey])); // invoker also has an agent profile
    const store = { hasSourceEvent: vi.fn(() => false), insertPending: vi.fn() } as any;
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', invokerPubkey);

    await handleAgentReply(agentReplyEvent({ pubkey: agentPubkey }), {
      relay,
      config,
      botPubkey,
      botSecretKey,
      lawallet: {} as LaWalletClient,
      store,
      feeStore: {} as any,
      logger: noopLogger,
      authorCache,
      agentCache: new AgentPubkeyCache(),
      triggers,
    });

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('charges the invoking human once an agent replies to their message', async () => {
    const agentPubkey = 'agent'.padEnd(64, '1');
    const invokerPubkey = 'human'.padEnd(64, '2');
    const relay = fakeRelay(new Set([agentPubkey]));
    const store = { hasSourceEvent: vi.fn(() => false), insertPending: vi.fn() } as any;
    const authorCache = new MessageAuthorCache();
    authorCache.set('msg-1', invokerPubkey);
    const lawallet = { requestInvoice: vi.fn().mockRejectedValue(new LaWalletError('no route')) } as unknown as LaWalletClient;

    await handleAgentReply(agentReplyEvent({ pubkey: agentPubkey }), {
      relay,
      config,
      botPubkey,
      botSecretKey,
      lawallet,
      store,
      feeStore: {} as any,
      logger: noopLogger,
      authorCache,
      agentCache: new AgentPubkeyCache(),
      triggers,
    });

    expect(lawallet.requestInvoice).toHaveBeenCalledWith('buzz-zaps-service', 50, expect.stringContaining('agent task completion'));
    expect(relay.publish).toHaveBeenCalledTimes(1);
    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(published.tags).toContainEqual(['p', invokerPubkey]);
  });
});
