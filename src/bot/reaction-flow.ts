import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig, TriggersFile } from '../config.js';
import { LaWalletClient } from '../lightning/lawallet-client.js';
import { ZapStore } from '../db/store.js';
import { LinkStore } from '../db/links.js';
import { MessageAuthorCache } from './message-author-cache.js';
import { fetchEventById } from './relay-client.js';
import { runZapFlow } from './zap-flow.js';

export interface ReactionFlowDeps {
  relay: Relay;
  config: AppConfig;
  botSecretKey: Uint8Array;
  lawallet: LaWalletClient;
  store: ZapStore;
  links: LinkStore;
  logger: Logger;
  authorCache: MessageAuthorCache;
  triggers: TriggersFile;
}

/**
 * Handles a kind:7 reaction: if its content matches a configured
 * `reaction_added` trigger, zaps the author of the reacted-to message.
 *
 * Requires the author to have run `/link` first — we only have their Nostr
 * pubkey from the reaction target, and LaWallet doesn't expose a public
 * pubkey -> username lookup (confirmed reading its API routes), so there's
 * no way to resolve a LaWallet address without that self-registered mapping.
 */
export async function handleReaction(event: Event, deps: ReactionFlowDeps): Promise<void> {
  const { relay, config, lawallet, store, links, logger, authorCache, triggers } = deps;

  const rule = triggers.triggers.find((t) => t.on === 'reaction_added' && t.emoji === event.content);
  if (!rule || rule.on !== 'reaction_added') return;

  const targetEventId = event.tags.find((tag) => tag[0] === 'e' && tag[1])?.[1];
  if (!targetEventId) return;

  let authorPubkey = authorCache.get(targetEventId);
  if (!authorPubkey) {
    const targetEvent = await fetchEventById(relay, targetEventId);
    authorPubkey = targetEvent?.pubkey;
    if (authorPubkey) authorCache.set(targetEventId, authorPubkey);
  }
  if (!authorPubkey) {
    logger.debug({ reactionId: event.id, targetEventId }, 'could not resolve author of reacted-to message, skipping');
    return;
  }

  if (authorPubkey === event.pubkey) {
    logger.debug({ reactionId: event.id }, 'ignoring self-reaction zap attempt');
    return;
  }

  const targetUsername = links.getUsername(authorPubkey);
  if (!targetUsername) {
    logger.debug({ authorPubkey }, 'reacted-to author has not run /link, skipping reaction zap');
    return;
  }

  logger.info(
    { reactionId: event.id, emoji: event.content, targetEventId, targetUsername, amountSats: rule.amount_sats },
    'detected reaction trigger',
  );

  await runZapFlow(
    {
      channelId: config.channelId,
      sourceEventId: event.id,
      threadEventId: targetEventId,
      mentionPubkey: event.pubkey,
      requestedByPubkey: event.pubkey,
      targetUsername,
      targetPubkey: authorPubkey,
      amountSats: rule.amount_sats,
      comment: `${event.content} reaction zap from Buzz channel ${config.channelId}`,
    },
    { relay, config, botSecretKey: deps.botSecretKey, lawallet, store, logger },
  );
}
