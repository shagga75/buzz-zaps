import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import { LaWalletClient } from '../lightning/lawallet-client.js';
import { ZapStore } from '../db/store.js';
import { FeeStore } from '../db/fees.js';
import { LinkStore } from '../db/links.js';
import { BountyStore } from '../db/bounties.js';
import { buildChannelReply } from '../nostr/messages.js';
import { parseBountyCommand } from './command-parser.js';
import { fetchChannelAdmins, fetchEventById, publish } from './relay-client.js';
import { runZapFlow } from './zap-flow.js';

// From crates/buzz-core/src/kind.rs in the buzz fork.
export const KIND_GIT_PULL_REQUEST = 1618;
export const KIND_GIT_STATUS_MERGED = 1631;

export interface BountyFlowDeps {
  relay: Relay;
  config: AppConfig;
  botSecretKey: Uint8Array;
  lawallet: LaWalletClient;
  store: ZapStore;
  feeStore: FeeStore;
  links: LinkStore;
  bounties: BountyStore;
  logger: Logger;
}

/** Handles `/bounty <pr-or-issue-event-id> <amount>`, posted as a normal channel message. */
export async function handleBountyCommand(event: Event, deps: BountyFlowDeps): Promise<void> {
  const command = parseBountyCommand(event);
  if (!command) return;

  const { relay, config, botSecretKey, bounties, logger } = deps;

  // Gated to the channel's own owner/admin members — the same people who
  // could push/administer the repo directly in Buzz (git_perms.rs: "channel
  // role = repo role"), not a community-wide role that might not even be a
  // member here. Fails closed: a relay timeout means an empty admin set,
  // which denies the command rather than letting an unverifiable request
  // through.
  const admins = await fetchChannelAdmins(relay, config.channelId);
  if (!admins.has(event.pubkey)) {
    logger.debug({ pubkey: event.pubkey, channelId: config.channelId }, '/bounty ignored — not an owner/admin of this channel');
    return;
  }

  bounties.register(command.targetEventId, command.amountSats, event.pubkey);
  logger.info({ targetEventId: command.targetEventId, amountSats: command.amountSats, createdBy: event.pubkey }, 'registered bounty');

  const reply = buildChannelReply(
    config.channelId,
    { threadEventId: event.id, mentionPubkey: event.pubkey },
    `💰 Bounty set: ${command.amountSats} sats for ${command.targetEventId.slice(0, 8)}… — pays out automatically when merged.`,
    botSecretKey,
  );
  await publish(relay, reply, logger);
}

/**
 * Handles a NIP-34 status event (kind 1631). Fires only for the specific
 * shape a merged PR produces: an `e` tag marked "root" pointing at the PR
 * (kind 1618) being merged. The same kind is reused for "issue resolved" —
 * that's not a PR, so it's ignored — and we fetch the root event's own
 * `kind` field to tell the two apart rather than trusting the trigger event.
 */
export async function handleMergeStatus(event: Event, deps: BountyFlowDeps): Promise<void> {
  const { relay, config, lawallet, store, links, bounties, logger } = deps;

  if (store.hasSourceEvent(event.id)) return; // already processed (e.g. relay redelivery on reconnect)

  const rootTag = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'root') ?? event.tags.find((tag) => tag[0] === 'e');
  const targetEventId = rootTag?.[1];
  if (!targetEventId) return;

  const bounty = bounties.getOpen(targetEventId);
  if (!bounty) return; // nobody promised sats for this PR

  const prEvent = await fetchEventById(relay, targetEventId);
  if (!prEvent || prEvent.kind !== KIND_GIT_PULL_REQUEST) {
    logger.debug({ targetEventId, kind: prEvent?.kind }, 'bounty target is not a pull request, skipping');
    return;
  }
  const authorPubkey = prEvent.pubkey;

  if (authorPubkey === bounty.createdByPubkey) {
    logger.warn({ targetEventId, authorPubkey }, 'refusing to pay a bounty to the same pubkey that set it');
    return;
  }

  const targetUsername = links.getUsername(authorPubkey);
  if (!targetUsername) {
    logger.debug({ authorPubkey }, 'PR author has not run /link, skipping bounty payout');
    return;
  }

  logger.info({ mergeEventId: event.id, targetEventId, targetUsername, amountSats: bounty.amountSats }, 'detected merged bounty');

  const outcome = await runZapFlow(
    {
      channelId: config.channelId,
      sourceEventId: event.id,
      threadEventId: targetEventId,
      // The PR is a NIP-34 event, not a channel message — it has no
      // channel_id, so threading a reply under it gets rejected by the
      // relay ("parent event has no channel association"). Post unthreaded.
      channelReplyEventId: null,
      mentionPubkey: authorPubkey,
      requestedByPubkey: bounty.createdByPubkey,
      targetUsername,
      targetPubkey: authorPubkey,
      amountSats: bounty.amountSats,
      comment: `bounty payout for merged PR ${targetEventId}`,
    },
    { relay, config, botSecretKey: deps.botSecretKey, lawallet, store, feeStore: deps.feeStore, logger },
  );
  // Only clear the bounty on an actual payout — a failed/expired attempt
  // leaves it 'open' so a future manual retry (re-running /bounty, or a
  // fixed wallet) can still pay it out. The merge event itself won't fire
  // again, so this doesn't self-heal automatically; see README limitations.
  if (outcome === 'paid') bounties.markPaid(targetEventId);
}
