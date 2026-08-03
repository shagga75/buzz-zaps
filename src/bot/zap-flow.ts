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
 * Handles a single channel message: if it's a `/zap @user amount` command,
 * runs the full Fase 1 flow — request invoice, reply with it, poll for
 * settlement, publish the zap receipt (kind 9735). No-op for anything else.
 */
export async function handleChannelMessage(event: Event, deps: ZapFlowDeps): Promise<void> {
  const { relay, config, botSecretKey, lawallet, store, logger } = deps;
  const command = parseZapCommand(event);
  if (!command) return;

  const log = logger.child({ sourceEventId: event.id, target: command.targetUsername, amountSats: command.amountSats });
  log.info('detected /zap command');

  let invoice;
  try {
    invoice = await lawallet.requestInvoice(command.targetUsername, command.amountSats, `zap from Buzz channel ${config.channelId}`);
  } catch (err) {
    const message = err instanceof LaWalletError ? err.message : 'Unexpected error requesting the invoice.';
    log.error({ err }, 'invoice request failed');
    const reply = buildChannelReply(config.channelId, event, `⚠️ Couldn't create an invoice for @${command.targetUsername}: ${message}`, botSecretKey);
    await publish(relay, reply, logger);
    return;
  }

  const rowId = store.insertPending({
    channelId: config.channelId,
    sourceEventId: event.id,
    requestedByPubkey: event.pubkey,
    targetUsername: command.targetUsername,
    targetPubkey: command.targetPubkey,
    amountSats: command.amountSats,
    bolt11: invoice.bolt11,
    verifyUrl: invoice.verifyUrl,
  });

  const invoiceReply = buildChannelReply(
    config.channelId,
    event,
    `⚡ Invoice for ${command.amountSats} sats to @${command.targetUsername}:\n\n${invoice.bolt11}`,
    botSecretKey,
  );
  await publish(relay, invoiceReply, logger);

  const zapRequest = buildSyntheticZapRequest(
    {
      recipientPubkey: command.targetPubkey,
      zappedEventId: event.id,
      channelId: config.channelId,
      amountMsats: command.amountSats * 1000,
      relays: [config.buzzRelayUrl, ...config.zapReceiptExtraRelays],
    },
    botSecretKey,
  );

  log.info('waiting for payment to settle');
  const settlement = await lawallet.pollUntilSettled(invoice.verifyUrl, config.verifyPollIntervalMs, config.verifyTimeoutMs);

  if (!settlement.settled) {
    store.markExpired(rowId);
    log.warn('payment did not settle before timeout');
    const reply = buildChannelReply(config.channelId, event, `⌛ The invoice for @${command.targetUsername} wasn't paid in time.`, botSecretKey);
    await publish(relay, reply, logger);
    return;
  }

  const receipt = buildZapReceipt(
    {
      recipientPubkey: command.targetPubkey,
      zappedEventId: event.id,
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

  const confirmReply = buildChannelReply(
    config.channelId,
    event,
    `✅ ${command.amountSats} sats zapped to @${command.targetUsername}! Receipt: ${receipt.id}`,
    botSecretKey,
  );
  await publish(relay, confirmReply, logger);
}
