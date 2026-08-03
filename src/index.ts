import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { loadBotIdentity } from './nostr/identity.js';
import { connectAndAuthenticate, subscribeToChannel } from './bot/relay-client.js';
import { handleChannelMessage } from './bot/zap-flow.js';
import { LaWalletClient } from './lightning/lawallet-client.js';
import { ZapStore } from './db/store.js';

// Both the legacy (kind 9) and current (kind 40002) channel-message kinds are
// accepted by the relay today — see crates/buzz-core/src/kind.rs in the buzz
// fork. We listen to both so the bot works regardless of which one a given
// Buzz client version is emitting.
const CHANNEL_MESSAGE_KINDS = [9, 40002];

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bot = loadBotIdentity(config.botNsec);

  logger.info({ pubkey: bot.pubkey, channelId: config.channelId }, 'starting buzz-zaps');

  const store = new ZapStore(config.dbPath);
  const lawallet = new LaWalletClient(config.lawalletBaseUrl, logger);
  const relay = await connectAndAuthenticate(config.buzzRelayUrl, bot.secretKey, logger);

  subscribeToChannel(relay, config.channelId, CHANNEL_MESSAGE_KINDS, (event) => {
    void handleChannelMessage(event, {
      relay,
      config,
      botSecretKey: bot.secretKey,
      lawallet,
      store,
      logger,
    }).catch((err) => {
      logger.error({ err, eventId: event.id }, 'unhandled error processing channel message');
    });
  }, logger);

  const shutdown = () => {
    logger.info('shutting down');
    relay.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal error starting buzz-zaps:', err);
  process.exit(1);
});
