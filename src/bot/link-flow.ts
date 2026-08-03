import type { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools/pure';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import { LinkStore } from '../db/links.js';
import { buildChannelReply } from '../nostr/messages.js';
import { parseLinkCommand } from './command-parser.js';
import { publish } from './relay-client.js';

export interface LinkFlowDeps {
  relay: Relay;
  config: AppConfig;
  botSecretKey: Uint8Array;
  links: LinkStore;
  logger: Logger;
}

/**
 * Handles `/link <lawallet-username>`: self-registers event.pubkey → username
 * so reaction-triggered zaps (Fase 2) know where to send them. Self-service
 * by design — the pubkey is whoever signed this event, so nobody can link an
 * identity that isn't their own.
 */
export async function handleLinkCommand(event: Event, deps: LinkFlowDeps): Promise<void> {
  const command = parseLinkCommand(event);
  if (!command) return;

  const { relay, config, botSecretKey, links, logger } = deps;
  links.link(event.pubkey, command.lawalletUsername);
  logger.info({ pubkey: event.pubkey, username: command.lawalletUsername }, 'linked pubkey to LaWallet username');

  const reply = buildChannelReply(
    config.channelId,
    { threadEventId: event.id, mentionPubkey: event.pubkey },
    `🔗 Linked! Reactions on your messages can now zap @${command.lawalletUsername}.`,
    botSecretKey,
  );
  await publish(relay, reply, logger);
}
