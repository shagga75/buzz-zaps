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

export async function publish(relay: Relay, event: Event, logger: Logger): Promise<void> {
  await relay.publish(event);
  logger.info({ id: event.id, kind: event.kind }, 'published event');
}
