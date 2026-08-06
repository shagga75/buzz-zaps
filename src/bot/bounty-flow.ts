import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import { LaWalletClient } from '../lightning/lawallet-client.js';
import { ZapStore } from '../db/store.js';
import { FeeStore } from '../db/fees.js';
import { LinkStore } from '../db/links.js';
import { BountyStore, type Bounty } from '../db/bounties.js';
import { buildChannelReply } from '../nostr/messages.js';
import { parseBountyCommand, parseRetryBountyCommand } from './command-parser.js';
import { fetchChannelAdmins, fetchEventById, hasMergeStatusEvent, publish } from './relay-client.js';
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
 * Shared by both the automatic merge-triggered payout and the manual
 * `/retry-bounty` retry: resolves the PR author, checks the guards every
 * bounty payout needs (must actually be a PR, never pay the bounty's own
 * creator, author must have run `/link`), runs the zap flow, and only
 * clears the bounty on an actual payout — a failed/expired attempt leaves
 * it 'open' so a later attempt (automatic or manual) can still pay it out.
 */
async function attemptBountyPayout(
  bounty: Bounty,
  sourceEventId: string,
  channelReplyEventId: string | null,
  deps: BountyFlowDeps,
  logContext: Record<string, unknown>,
): Promise<void> {
  const { relay, config, botSecretKey, lawallet, store, feeStore, links, bounties, logger } = deps;

  const prEvent = await fetchEventById(relay, bounty.targetEventId);
  if (!prEvent || prEvent.kind !== KIND_GIT_PULL_REQUEST) {
    logger.debug({ ...logContext, kind: prEvent?.kind }, 'bounty target is not a pull request, skipping');
    return;
  }
  const authorPubkey = prEvent.pubkey;

  if (authorPubkey === bounty.createdByPubkey) {
    logger.warn({ ...logContext, authorPubkey }, 'refusing to pay a bounty to the same pubkey that set it');
    return;
  }

  const targetUsername = links.getUsername(authorPubkey);
  if (!targetUsername) {
    logger.debug({ authorPubkey }, 'PR author has not run /link, skipping bounty payout');
    return;
  }

  logger.info({ ...logContext, targetUsername, amountSats: bounty.amountSats }, 'attempting bounty payout');

  const outcome = await runZapFlow(
    {
      channelId: config.channelId,
      sourceEventId,
      threadEventId: bounty.targetEventId,
      channelReplyEventId,
      mentionPubkey: authorPubkey,
      requestedByPubkey: bounty.createdByPubkey,
      targetUsername,
      targetPubkey: authorPubkey,
      amountSats: bounty.amountSats,
      comment: `bounty payout for merged PR ${bounty.targetEventId}`,
    },
    { relay, config, botSecretKey, lawallet, store, feeStore, logger },
  );
  if (outcome === 'paid') bounties.markPaid(bounty.targetEventId);
}

/**
 * Handles a NIP-34 status event (kind 1631). Fires only for the specific
 * shape a merged PR produces: an `e` tag marked "root" pointing at the PR
 * (kind 1618) being merged. The same kind is reused for "issue resolved" —
 * that's not a PR, so it's ignored — and we fetch the root event's own
 * `kind` field to tell the two apart rather than trusting the trigger event.
 */
export async function handleMergeStatus(event: Event, deps: BountyFlowDeps): Promise<void> {
  const { store, bounties } = deps;

  if (store.hasSourceEvent(event.id)) return; // already processed (e.g. relay redelivery on reconnect)

  const rootTag = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'root') ?? event.tags.find((tag) => tag[0] === 'e');
  const targetEventId = rootTag?.[1];
  if (!targetEventId) return;

  const bounty = bounties.getOpen(targetEventId);
  if (!bounty) return; // nobody promised sats for this PR

  // The PR is a NIP-34 event, not a channel message — it has no channel_id,
  // so threading a reply under it gets rejected by the relay ("parent event
  // has no channel association"). Post unthreaded.
  await attemptBountyPayout(bounty, event.id, null, deps, { mergeEventId: event.id, targetEventId });
}

/**
 * Handles `/retry-bounty <event-id>`, posted as a normal channel message —
 * the gap PR #9/#12's notes both left open: the merge event only fires
 * once, so a bounty whose payout failed or timed out (wallet down, invoice
 * request 503) stays 'open' forever with nothing to re-trigger it. Gated to
 * the same channel owner/admin set as `/bounty` itself (git_perms.rs:
 * "channel role = repo role") since this re-requests a real payout, not a
 * read-only action.
 *
 * Re-checks merge status via `hasMergeStatusEvent` rather than trusting the
 * command alone — otherwise any admin could bypass the entire "bounties pay
 * out on merge" model by just asking early. Fails closed: no confirmed
 * merge (including a relay timeout) means no retry.
 */
export async function handleRetryBountyCommand(event: Event, deps: BountyFlowDeps): Promise<void> {
  const command = parseRetryBountyCommand(event);
  if (!command) return;

  const { relay, config, botSecretKey, bounties, logger } = deps;

  const admins = await fetchChannelAdmins(relay, config.channelId);
  if (!admins.has(event.pubkey)) {
    logger.debug({ pubkey: event.pubkey, channelId: config.channelId }, '/retry-bounty ignored — not an owner/admin of this channel');
    return;
  }

  const reply = (content: string) =>
    publish(relay, buildChannelReply(config.channelId, { threadEventId: event.id, mentionPubkey: event.pubkey }, content, botSecretKey), logger);

  const bounty = bounties.getOpen(command.targetEventId);
  if (!bounty) {
    await reply(`No hay ningún bounty abierto para ${command.targetEventId.slice(0, 8)}… (¿ya se pagó, o nunca se registró?).`);
    return;
  }

  if (!(await hasMergeStatusEvent(relay, command.targetEventId))) {
    await reply(`${command.targetEventId.slice(0, 8)}… todavía no aparece como mergeado — no reintento el pago.`);
    return;
  }

  logger.info({ targetEventId: command.targetEventId, requestedBy: event.pubkey }, 'manual bounty payout retry triggered');
  await attemptBountyPayout(bounty, event.id, event.id, deps, { targetEventId: command.targetEventId, retriedBy: event.pubkey });
}
