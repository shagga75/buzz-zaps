import { Relay } from 'nostr-tools/relay';
import { finalizeEvent, verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { Logger } from '../logger.js';

/**
 * Buzz sends an unsolicited ["AUTH", challenge] right after the WebSocket
 * opens (see crates/buzz-ws-client/src/connection.rs::wait_for_auth_challenge
 * in the buzz repo). We mirror that: wait for the relay to hand us a
 * challenge, then sign+send a kind:22242 NIP-42 event and wait for OK.
 */
async function waitForChallenge(relay: Relay, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // `challenge` is a private field on AbstractRelay; nostr-tools doesn't
  // expose a public accessor or event for "challenge received".
  const relayInternals = relay as unknown as { challenge?: string };
  while (!relayInternals.challenge) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for NIP-42 AUTH challenge from ${relay.url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function connectAndAuthenticate(
  url: string,
  secretKey: Uint8Array,
  logger: Logger,
  timeoutMs = 15_000,
): Promise<Relay> {
  const relay = await Relay.connect(url);
  logger.info({ url }, 'connected to buzz relay');

  const signAuthEvent = async (evt: EventTemplate): Promise<VerifiedEvent> => finalizeEvent(evt, secretKey);
  relay.onauth = signAuthEvent;

  await waitForChallenge(relay, timeoutMs);
  await relay.auth(signAuthEvent);
  logger.info({ url }, 'NIP-42 auth accepted');

  return relay;
}

export function subscribeToChannel(
  relay: Relay,
  channelId: string,
  kinds: number[],
  onEvent: (event: Event) => void,
  logger: Logger,
) {
  const filter: Filter = { kinds, '#h': [channelId] };
  const sub = relay.subscribe([filter], {
    onevent(event) {
      if (!verifyEvent(event)) {
        logger.warn({ id: event.id }, 'ignoring event with invalid signature');
        return;
      }
      onEvent(event);
    },
    oneose() {
      logger.info({ channelId, kinds }, 'subscribed, caught up to end of stored events');
    },
    onclose(reason) {
      logger.warn({ channelId, reason }, 'channel subscription closed');
    },
  });
  return sub;
}

/**
 * Subscribes without an `#h` channel filter — for kinds that aren't
 * channel-scoped, like NIP-34 git status events (confirmed by reading
 * `requires_h_channel_scope` in the buzz fork: git kinds 1617–1633 aren't
 * in that list, so a PR merge notification never carries an `h` tag).
 * Optionally scoped to one repo via its `a`-tag coordinate.
 */
export function subscribeGlobal(relay: Relay, kinds: number[], onEvent: (event: Event) => void, logger: Logger, repoCoord?: string) {
  const filter: Filter = { kinds, ...(repoCoord ? { '#a': [repoCoord] } : {}) };
  const sub = relay.subscribe([filter], {
    onevent(event) {
      if (!verifyEvent(event)) {
        logger.warn({ id: event.id }, 'ignoring event with invalid signature');
        return;
      }
      onEvent(event);
    },
    oneose() {
      logger.info({ kinds, repoCoord }, 'global subscription caught up to end of stored events');
    },
    onclose(reason) {
      logger.warn({ kinds, reason }, 'global subscription closed');
    },
  });
  return sub;
}

export async function publish(relay: Relay, event: Event, logger: Logger): Promise<void> {
  await relay.publish(event);
  logger.info({ id: event.id, kind: event.kind }, 'published event');
}

// From crates/buzz-core/src/kind.rs in the buzz fork: replaceable, one per
// author. Its mere existence for a pubkey is Buzz's own "this is an agent"
// signal — no separate role/flag needed.
const KIND_AGENT_PROFILE = 10100;

/**
 * One-shot lookup for whether `pubkey` has ever published a kind:10100
 * (AGENT_PROFILE) event — used to tell an agent's reply apart from a human's
 * when deciding who to charge for a completed task.
 */
export function hasAgentProfile(relay: Relay, pubkey: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub.close();
      resolve(false);
    }, timeoutMs);

    const sub = relay.subscribe([{ kinds: [KIND_AGENT_PROFILE], authors: [pubkey], limit: 1 }], {
      onevent() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        resolve(true);
      },
      oneose() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        resolve(false);
      },
    });
  });
}

/**
 * One-shot lookup for a single event by id — used when a reaction targets a
 * message older than our in-memory author cache (e.g. posted before this
 * process started).
 */
export function fetchEventById(relay: Relay, id: string, timeoutMs = 5_000): Promise<Event | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub.close();
      resolve(null);
    }, timeoutMs);

    const sub = relay.subscribe([{ ids: [id] }], {
      onevent(event) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        resolve(event);
      },
      oneose() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        resolve(null);
      },
    });
  });
}

// From crates/buzz-core/src/kind.rs in the buzz fork: NIP-29 kind:39001, an
// addressable/replaceable event (`d` tag = channel id) the relay itself
// publishes and keeps current. Its `p` tags are pre-filtered server-side to
// just the channel's `owner`/`admin` members (crates/buzz-relay/src/
// handlers/side_effects.rs — confirmed reading the emission code, not
// assumed), so every `p` tag here already IS an admin or owner; there's no
// separate role check needed client-side.
const KIND_NIP29_GROUP_ADMINS = 39001;

/**
 * The set of pubkeys with `owner`/`admin` role in `channelId`, per Buzz's
 * own git-repo permission model (crates/buzz-core/src/git_perms.rs:
 * "channel role = repo role") — used to gate `/bounty` to the same people
 * who could push/administer the repo directly in Buzz, not a
 * community-wide role that might not even be a member of this channel.
 */
export function fetchChannelAdmins(relay: Relay, channelId: string, timeoutMs = 5_000): Promise<Set<string>> {
  return new Promise((resolve) => {
    let settled = false;
    let latest: Event | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub.close();
      resolve(new Set());
    }, timeoutMs);

    const sub = relay.subscribe([{ kinds: [KIND_NIP29_GROUP_ADMINS], '#d': [channelId] }], {
      onevent(event) {
        if (!latest || event.created_at > latest.created_at) latest = event;
      },
      oneose() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        const pubkeys = latest?.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]) ?? [];
        resolve(new Set(pubkeys));
      },
    });
  });
}
