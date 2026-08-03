import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import { LaWalletClient, LaWalletError } from '../lightning/lawallet-client.js';
import { ZapStore } from '../db/store.js';
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
  threadEventId: string;
  mentionPubkey: string;
  requestedByPubkey: string;
  targetUsername: string;
  targetPubkey: string;
  amountSats: number;
  comment?: string;
}

export type ZapOutcome = 'paid' | 'expired' | 'invoice_failed';

export async function runZapFlow(req: ZapRequest, deps: ZapFlowDeps): Promise<ZapOutcome> {
  const { relay, config, botSecretKey, lawallet, store, logger } = deps;
  const log = logger.child({ sourceEventId: req.sourceEventId, target: req.targetUsername, amountSats: req.amountSats });

  const reply = (content: string) =>
    publish(relay, buildChannelReply(config.channelId, { threadEventId: req.threadEventId, mentionPubkey: req.mentionPubkey }, content, botSecretKey), logger);

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
      mentionPubkey: event.pubkey,
      requestedByPubkey: event.pubkey,
      targetUsername: command.targetUsername,
      targetPubkey: command.targetPubkey,
      amountSats: command.amountSats,
    },
    deps,
  );
}
