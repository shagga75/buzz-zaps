import { fileURLToPath } from 'node:url';
import { loadGlobalConfig, loadCommunities, type AppConfig, type TriggersFile } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { loadBotIdentity, type BotIdentity } from './nostr/identity.js';
import { connectAndAuthenticate, subscribeToChannel, subscribeGlobal } from './bot/relay-client.js';
import { handleChannelMessage } from './bot/zap-flow.js';
import { handleLinkCommand } from './bot/link-flow.js';
import { handleReaction } from './bot/reaction-flow.js';
import { handleBountyCommand, handleMergeStatus, KIND_GIT_STATUS_MERGED } from './bot/bounty-flow.js';
import { handleAgentReply } from './bot/task-completion-flow.js';
import { MessageAuthorCache } from './bot/message-author-cache.js';
import { AgentPubkeyCache } from './bot/agent-cache.js';
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

export interface CommunityHandle {
  name: string;
  relay: Awaited<ReturnType<typeof connectAndAuthenticate>>;
  store: ZapStore;
  links: LinkStore;
  bounties: BountyStore;
}

/**
 * Splits Promise.allSettled results into the handles that started
 * successfully, logging (not throwing on) each rejection. Pulled out of
 * main() so the fail-soft decision — one bad community's rejection must
 * never take the healthy ones down with it — is testable without spinning
 * up real relay connections.
 */
export function partitionStartResults(
  results: PromiseSettledResult<CommunityHandle>[],
  communityNames: string[],
  logger: Logger,
): CommunityHandle[] {
  const handles: CommunityHandle[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      handles.push(result.value);
    } else {
      logger.error(
        { community: communityNames[index], err: result.reason },
        'community failed to start — continuing with the communities that did',
      );
    }
  }
  return handles;
}

/**
 * Boots one community end to end: its own relay connection (a community is
 * resolved server-side from the connection's host, so this can't be shared
 * across communities), its own LaWallet client, its own SQLite stores, and
 * the same command/trigger wiring every community gets.
 */
async function startCommunity(
  name: string,
  config: AppConfig,
  triggers: TriggersFile,
  repoCoord: string | undefined,
  dbPath: string,
  bot: BotIdentity,
  logger: Logger,
): Promise<CommunityHandle> {
  const store = new ZapStore(dbPath);
  const links = new LinkStore(dbPath);
  const bounties = new BountyStore(dbPath);
  const lawallet = new LaWalletClient(config.lawalletBaseUrl, logger);
  const relay = await connectAndAuthenticate(config.buzzRelayUrl, bot.secretKey, logger);
  const authorCache = new MessageAuthorCache();
  const agentCache = new AgentPubkeyCache();

  logger.info({ pubkey: bot.pubkey, channelId: config.channelId }, 'community online');

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
        void handleAgentReply(event, {
          relay,
          config,
          botPubkey: bot.pubkey,
          botSecretKey: bot.secretKey,
          lawallet,
          store,
          logger,
          authorCache,
          agentCache,
          triggers,
        }).catch((err) => {
          logger.error({ err, eventId: event.id }, 'unhandled error processing agent task completion');
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
  // requires_h_channel_scope — git kinds aren't in that list). Still safe to
  // reuse this community's own relay connection: the relay's host-resolved
  // community boundary applies to every subscription on it, scoped or not.
  subscribeGlobal(
    relay,
    [KIND_GIT_STATUS_MERGED],
    (event) => {
      void handleMergeStatus(event, { relay, config, botSecretKey: bot.secretKey, lawallet, store, links, bounties, logger }).catch((err) => {
        logger.error({ err, eventId: event.id }, 'unhandled error processing merge status');
      });
    },
    logger,
    repoCoord,
  );

  return { name, relay, store, links, bounties };
}

async function main() {
  const global = loadGlobalConfig();
  const rootLogger = createLogger(global.logLevel);
  const bot = loadBotIdentity(global.botNsec);
  const communities = loadCommunities(global.communitiesConfigPath, global);

  rootLogger.info({ pubkey: bot.pubkey, communities: communities.map((c) => c.name) }, 'starting buzz-zaps');

  // Fail-soft on purpose: one community with a bad relay host or an
  // unreachable relay must not take every other, healthy community down
  // with it. Promise.allSettled (not Promise.all) so a rejection from one
  // startCommunity() call doesn't abort the others — each is independent
  // (its own relay connection, its own stores), so there's no shared state
  // a partial failure could leave inconsistent.
  const results = await Promise.allSettled(
    communities.map((c) =>
      startCommunity(c.name, c.config, c.triggers, c.repoCoord, c.dbPath, bot, rootLogger.child({ community: c.name })),
    ),
  );

  const handles = partitionStartResults(
    results,
    communities.map((c) => c.name),
    rootLogger,
  );

  // A process serving zero communities isn't degraded, it's useless —
  // that's the one case worth failing hard on, since every startCommunity()
  // rejection already got logged above with the reason.
  if (handles.length === 0) {
    rootLogger.error('every community failed to start — nothing to serve, exiting');
    process.exit(1);
  }

  const shutdown = () => {
    rootLogger.info('shutting down');
    for (const handle of handles) {
      handle.relay.close();
      handle.store.close();
      handle.links.close();
      handle.bounties.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run main() when this file is executed directly (`tsx src/index.ts` /
// `node dist/index.js`), not when it's imported — e.g. test/index.test.ts
// imports partitionStartResults for unit testing and must not trigger a
// real startup (env/config loading, real relay connections) as a side
// effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('fatal error starting buzz-zaps:', err);
    process.exit(1);
  });
}
