import { loadConfig, loadTriggersConfig } from './config.js';
import { createLogger } from './logger.js';
import { loadBotIdentity } from './nostr/identity.js';
import { connectAndAuthenticate, subscribeToChannel, subscribeGlobal } from './bot/relay-client.js';
import { handleChannelMessage } from './bot/zap-flow.js';
import { handleLinkCommand } from './bot/link-flow.js';
import { handleReaction } from './bot/reaction-flow.js';
import { handleBountyCommand, handleMergeStatus, KIND_GIT_STATUS_MERGED } from './bot/bounty-flow.js';
import { MessageAuthorCache } from './bot/message-author-cache.js';
import { LaWalletClient } from './lightning/lawallet-client.js';
import { ZapStore } from './db/store.js';
import { LinkStore } from './db/links.js';
import { BountyStore } from './db/bounties.js';

// Both the legacy (kind 9) and current (kind 40002) channel-message kinds are
// accepted by the relay today — see crates/buzz-core/src/kind.rs in the buzz
// fork. We listen to both so the bot works regardless of which one a given
// Buzz client version is emitting.
const CHANNEL_MESSAGE_KINDS = [9, 40002];
const REACTION_KIND = 7;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bot = loadBotIdentity(config.botNsec);
  const triggers = loadTriggersConfig(config.triggersConfigPath);

  logger.info({ pubkey: bot.pubkey, channelId: config.channelId }, 'starting buzz-zaps');

  const store = new ZapStore(config.dbPath);
  const links = new LinkStore(config.dbPath);
  const bounties = new BountyStore(config.dbPath);
  const lawallet = new LaWalletClient(config.lawalletBaseUrl, logger);
  const relay = await connectAndAuthenticate(config.buzzRelayUrl, bot.secretKey, logger);
  const authorCache = new MessageAuthorCache();

  // Channel-scoped: the manual /zap, /link, /bounty commands and reaction triggers.
  subscribeToChannel(
    relay,
    config.channelId,
    [...CHANNEL_MESSAGE_KINDS, REACTION_KIND],
    (event) => {
      if (CHANNEL_MESSAGE_KINDS.includes(event.kind)) {
        authorCache.set(event.id, event.pubkey);
        void handleChannelMessage(event, { relay, config, botSecretKey: bot.secretKey, lawallet, store, logger }).catch((err) => {
          logger.error({ err, eventId: event.id }, 'unhandled error processing /zap command');
        });
        void handleLinkCommand(event, { relay, config, botSecretKey: bot.secretKey, links, logger }).catch((err) => {
          logger.error({ err, eventId: event.id }, 'unhandled error processing /link command');
        });
        void handleBountyCommand(event, { relay, config, botSecretKey: bot.secretKey, lawallet, store, links, bounties, logger }).catch((err) => {
          logger.error({ err, eventId: event.id }, 'unhandled error processing /bounty command');
        });
        return;
      }
      if (event.kind === REACTION_KIND) {
        void handleReaction(event, { relay, config, botSecretKey: bot.secretKey, lawallet, store, links, logger, authorCache, triggers }).catch(
          (err) => {
            logger.error({ err, eventId: event.id }, 'unhandled error processing reaction');
          },
        );
      }
    },
    logger,
  );

  // Not channel-scoped: NIP-34 git status events live in the repo/community
  // namespace, not under any `h` tag (confirmed in buzz-relay's
  // requires_h_channel_scope — git kinds aren't in that list).
  subscribeGlobal(
    relay,
    [KIND_GIT_STATUS_MERGED],
    (event) => {
      void handleMergeStatus(event, { relay, config, botSecretKey: bot.secretKey, lawallet, store, links, bounties, logger }).catch((err) => {
        logger.error({ err, eventId: event.id }, 'unhandled error processing merge status');
      });
    },
    logger,
    config.repoCoord,
  );

  const shutdown = () => {
    logger.info('shutting down');
    relay.close();
    store.close();
    links.close();
    bounties.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal error starting buzz-zaps:', err);
  process.exit(1);
});
