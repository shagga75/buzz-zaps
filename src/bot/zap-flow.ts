import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import { LaWalletClient, LaWalletError } from '../lightning/lawallet-client.js';
import { ZapStore } from '../db/store.js';
import { FeeStore } from '../db/fees.js';
import { buildChannelReply } from '../nostr/messages.js';
import { buildSyntheticZapRequest, buildZapReceipt } from '../nostr/zap-receipt.js';
import { parseZapCommand } from './command-parser.js';
import { publish } from './relay-client.js';

export interface ZapFlowDeps {
  relay: Relay;
  config: AppConfig;
  botSecretKey: Uint8Array;
  lawallet: LaWalletClient;
  store: ZapStore;
  feeStore: FeeStore;
  logger: Logger;
}

/**
 * A zap to run, independent of what triggered it (manual /zap command,
 * reaction, or any future Fase 2 trigger). `sourceEventId` is the DB
 * dedup key; `threadEventId` is what replies and the zap receipt's `e` tag
 * point at — usually the same event, but a reaction-triggered zap threads
 * under the *reacted-to* message, not the reaction itself.
 */
export interface ZapRequest {
  channelId: string;
  sourceEventId: string;
  /** What the zap request/receipt (kind 9734/9735) references as "zapped" — not channel-scope restricted. */
  threadEventId: string;
  /**
   * What the channel reply threads under, or null to post unthreaded. Must
   * be a channel-scoped event (kind 9/40002) — pass null when threadEventId
   * points at something outside the channel (e.g. a bounty's PR event), or
   * the relay rejects the reply. See `ReplyTarget` in nostr/messages.ts.
   */
  channelReplyEventId: string | null;
  /** NIP-10 root, only if `channelReplyEventId` is itself a reply (not the thread root) — see `ReplyTarget.rootEventId`. */
  channelReplyRootEventId?: string;
  mentionPubkey: string;
  requestedByPubkey: string;
  targetUsername: string;
  targetPubkey: string;
  amountSats: number;
  comment?: string;
}

export type ZapOutcome = 'paid' | 'expired' | 'invoice_failed';

/**
 * Fase 3 fee middleware: requests a second, separate invoice for
 * `fee_bps` of the zap amount, payable to the community's own
 * `fee_service_username` — see README "Fase 3 — fee middleware" for why
 * this is a second invoice rather than a split within the main one (LaWallet
 * has no split-payment primitive an external LUD-16 consumer can reach).
 *
 * Best-effort and non-blocking on purpose: a fee invoice failing (LaWallet
 * flakiness, misconfigured username) must never affect the main zap, which
 * is the thing users actually asked buzz-zaps to do. Still honor-system —
 * nothing here blocks or delays the main zap on the fee's outcome — but its
 * settlement is now tracked: watched in the background (fire-and-forget,
 * same non-blocking contract) and recorded in FeeStore so admin-report and
 * the logs show whether it actually got paid instead of assuming it did.
 */
async function chargeFeeIfConfigured(
  zapId: number,
  req: ZapRequest,
  deps: ZapFlowDeps,
  reply: (content: string) => Promise<void>,
  log: Logger,
): Promise<void> {
  const { config, lawallet, feeStore } = deps;
  const fee = config.fee;
  if (!fee) return;
  if (req.targetUsername === fee.serviceUsername) return; // already paying the fee wallet itself — no fee on a fee

  const feeSats = Math.floor((req.amountSats * fee.bps) / 10_000);
  if (feeSats < 1) return; // rounds to 0 for small zaps — not worth a second invoice

  let feeInvoice;
  try {
    feeInvoice = await lawallet.requestInvoice(
      fee.serviceUsername,
      feeSats,
      `buzz-zaps fee (${fee.bps / 100}%) on a ${req.amountSats}-sat zap to @${req.targetUsername}`,
    );
  } catch (err) {
    log.warn({ err, feeSats }, 'fee invoice request failed — continuing without it, the main zap is unaffected');
    return;
  }

  await reply(`💰 Fee (${fee.bps / 100}%): invoice for ${feeSats} sats to @${fee.serviceUsername}:\n\n${feeInvoice.bolt11}`);

  const feeRowId = feeStore.insertPending({
    zapId,
    serviceUsername: fee.serviceUsername,
    amountSats: feeSats,
    bolt11: feeInvoice.bolt11,
    verifyUrl: feeInvoice.verifyUrl,
  });

  // Deliberately not awaited: the fee's own settlement can take as long as
  // the main zap's (up to verifyTimeoutMs) and must not delay this function
  // returning, which is what lets runZapFlow move on to polling the main
  // invoice right after this. A failure here — including the poll itself
  // erroring — only ever logs; it can't affect the zap.
  void (async () => {
    try {
      const settlement = await lawallet.pollUntilSettled(feeInvoice.verifyUrl, config.verifyPollIntervalMs, config.verifyTimeoutMs);
      if (settlement.settled) {
        feeStore.markPaid(feeRowId);
        log.info({ feeRowId, feeSats }, 'fee invoice settled');
      } else {
        feeStore.markExpired(feeRowId);
        log.warn({ feeRowId, feeSats, serviceUsername: fee.serviceUsername }, 'fee invoice was not paid before timeout — fee went uncollected for this zap');
      }
    } catch (err) {
      log.warn({ err, feeRowId }, 'error polling fee invoice settlement');
    }
  })();
}

export async function runZapFlow(req: ZapRequest, deps: ZapFlowDeps): Promise<ZapOutcome> {
  const { relay, config, botSecretKey, lawallet, store, logger } = deps;
  const log = logger.child({ sourceEventId: req.sourceEventId, target: req.targetUsername, amountSats: req.amountSats });

  const reply = (content: string) =>
    publish(
      relay,
      buildChannelReply(
        config.channelId,
        { threadEventId: req.channelReplyEventId, rootEventId: req.channelReplyRootEventId, mentionPubkey: req.mentionPubkey },
        content,
        botSecretKey,
      ),
      logger,
    );

  let invoice;
  try {
    invoice = await lawallet.requestInvoice(req.targetUsername, req.amountSats, req.comment ?? `zap from Buzz channel ${config.channelId}`);
  } catch (err) {
    const message = err instanceof LaWalletError ? err.message : 'Unexpected error requesting the invoice.';
    log.error({ err }, 'invoice request failed');
    await reply(`⚠️ Couldn't create an invoice for @${req.targetUsername}: ${message}`);
    return 'invoice_failed';
  }

  const rowId = store.insertPending({
    channelId: config.channelId,
    sourceEventId: req.sourceEventId,
    requestedByPubkey: req.requestedByPubkey,
    targetUsername: req.targetUsername,
    targetPubkey: req.targetPubkey,
    amountSats: req.amountSats,
    bolt11: invoice.bolt11,
    verifyUrl: invoice.verifyUrl,
  });

  await reply(`⚡ Invoice for ${req.amountSats} sats to @${req.targetUsername}:\n\n${invoice.bolt11}`);

  await chargeFeeIfConfigured(rowId, req, deps, reply, log);

  const zapRequest = buildSyntheticZapRequest(
    {
      recipientPubkey: req.targetPubkey,
      zappedEventId: req.threadEventId,
      channelId: config.channelId,
      amountMsats: req.amountSats * 1000,
      relays: [config.buzzRelayUrl, ...config.zapReceiptExtraRelays],
    },
    botSecretKey,
  );

  log.info('waiting for payment to settle');
  const settlement = await lawallet.pollUntilSettled(invoice.verifyUrl, config.verifyPollIntervalMs, config.verifyTimeoutMs);

  if (!settlement.settled) {
    store.markExpired(rowId);
    log.warn('payment did not settle before timeout');
    await reply(`⌛ The invoice for @${req.targetUsername} wasn't paid in time.`);
    return 'expired';
  }

  const receipt = buildZapReceipt(
    {
      recipientPubkey: req.targetPubkey,
      zappedEventId: req.threadEventId,
      channelId: config.channelId,
      bolt11: invoice.bolt11,
      preimage: settlement.preimage,
      paidAt: new Date(),
      zapRequest,
    },
    botSecretKey,
  );
  await publish(relay, receipt, logger);
  store.markPaid(rowId, receipt.id);
  log.info({ receiptEventId: receipt.id }, 'zap receipt published');

  await reply(`✅ ${req.amountSats} sats zapped to @${req.targetUsername}! Receipt: ${receipt.id}`);
  return 'paid';
}

/**
 * Handles a single channel message: if it's a `/zap @user amount` command,
 * runs the full zap flow. No-op for anything else.
 */
export async function handleChannelMessage(event: Event, deps: ZapFlowDeps): Promise<void> {
  const command = parseZapCommand(event);
  if (!command) return;

  deps.logger.info({ sourceEventId: event.id, target: command.targetUsername, amountSats: command.amountSats }, 'detected /zap command');

  await runZapFlow(
    {
      channelId: deps.config.channelId,
      sourceEventId: event.id,
      threadEventId: event.id,
      channelReplyEventId: event.id,
      mentionPubkey: event.pubkey,
      requestedByPubkey: event.pubkey,
      targetUsername: command.targetUsername,
      targetPubkey: command.targetPubkey,
      amountSats: command.amountSats,
    },
    deps,
  );
}
