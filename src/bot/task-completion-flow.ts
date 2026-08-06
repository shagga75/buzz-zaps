import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig, TriggersFile } from '../config.js';
import { LaWalletClient } from '../lightning/lawallet-client.js';
import { ZapStore } from '../db/store.js';
import { FeeStore } from '../db/fees.js';
import { MessageAuthorCache } from './message-author-cache.js';
import { AgentPubkeyCache } from './agent-cache.js';
import { fetchEventById, hasAgentProfile } from './relay-client.js';
import { runZapFlow } from './zap-flow.js';

export interface TaskCompletionFlowDeps {
  relay: Relay;
  config: AppConfig;
  botPubkey: string;
  botSecretKey: Uint8Array;
  lawallet: LaWalletClient;
  store: ZapStore;
  feeStore: FeeStore;
  logger: Logger;
  authorCache: MessageAuthorCache;
  agentCache: AgentPubkeyCache;
  triggers: TriggersFile;
}

async function resolveIsAgent(relay: Relay, pubkey: string, cache: AgentPubkeyCache): Promise<boolean> {
  const cached = cache.get(pubkey);
  if (cached !== undefined) return cached;
  const isAgent = await hasAgentProfile(relay, pubkey);
  cache.set(pubkey, isAgent);
  return isAgent;
}

/**
 * Handles a channel message (kind 9/40002): if it's a NIP-10 reply authored
 * by an agent (has published a kind:10100 AGENT_PROFILE — Buzz's own
 * "this pubkey is an agent" signal) replying to a human's message, charges
 * that human `amount_sats` for the completed task.
 *
 * "Charge" means "ask", not "auto-debit": LaWallet has no endpoint for a
 * third party to pull funds from someone else's wallet — every payment
 * route under apps/web/app/api/remote-wallets and apps/web/app/api/wallet is
 * scoped to the caller's own authenticated session (`loadOwnedWallet` in
 * remote-wallets/[id]/route.ts), confirmed reading the routes before
 * designing this, not assumed. So this reuses the same
 * request-invoice-and-wait pattern every other trigger uses: an invoice to
 * buzz-zaps' own service LaWallet address (`service_username` on the
 * trigger, not a per-recipient one resolved via `/link`), posted in-channel
 * and @-mentioning the human — they still have to actually pay it.
 */
export async function handleAgentReply(event: Event, deps: TaskCompletionFlowDeps): Promise<void> {
  const { relay, config, store, logger, authorCache, agentCache, triggers } = deps;

  const rule = triggers.triggers.find((t) => t.on === 'agent_task_completed');
  if (!rule || rule.on !== 'agent_task_completed') return;

  if (store.hasSourceEvent(event.id)) return; // already processed (e.g. relay redelivery on reconnect)

  const replyTag = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'reply') ?? event.tags.find((tag) => tag[0] === 'e');
  const targetEventId = replyTag?.[1];
  if (!targetEventId) return; // not a threaded reply — nothing it's completing

  if (!(await resolveIsAgent(relay, event.pubkey, agentCache))) return; // only agent replies bill anyone

  let invokerPubkey = authorCache.get(targetEventId);
  if (!invokerPubkey) {
    const targetEvent = await fetchEventById(relay, targetEventId);
    invokerPubkey = targetEvent?.pubkey;
    if (invokerPubkey) authorCache.set(targetEventId, invokerPubkey);
  }
  if (!invokerPubkey) {
    logger.debug({ eventId: event.id, targetEventId }, 'could not resolve who invoked this agent reply, skipping charge');
    return;
  }

  if (invokerPubkey === event.pubkey || invokerPubkey === deps.botPubkey) {
    logger.debug({ eventId: event.id }, 'ignoring self-reply or bot-invoked task, not charging');
    return;
  }

  if (await resolveIsAgent(relay, invokerPubkey, agentCache)) {
    logger.debug({ eventId: event.id, invokerPubkey }, 'invoker is itself an agent, not charging agent-to-agent chains');
    return;
  }

  logger.info(
    { eventId: event.id, agentPubkey: event.pubkey, invokerPubkey, amountSats: rule.amount_sats },
    'detected agent task completion',
  );

  await runZapFlow(
    {
      channelId: config.channelId,
      sourceEventId: event.id,
      threadEventId: event.id,
      channelReplyEventId: event.id, // the agent's own reply — a channel message (kind 9/40002), safe to thread against
      channelReplyRootEventId: targetEventId, // the agent's reply is itself a reply to the human's message — that's the true thread root
      mentionPubkey: invokerPubkey,
      requestedByPubkey: event.pubkey,
      targetUsername: rule.service_username,
      targetPubkey: deps.botPubkey,
      amountSats: rule.amount_sats,
      comment: `agent task completion charge from Buzz channel ${config.channelId}`,
    },
    { relay, config, botSecretKey: deps.botSecretKey, lawallet: deps.lawallet, store, feeStore: deps.feeStore, logger },
  );
}
