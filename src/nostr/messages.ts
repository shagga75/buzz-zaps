import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/pure';

/** A NIP-10 reply (kind 9, channel-scoped via `h`) to the original command message. */
export function buildChannelReply(
  channelId: string,
  parentEvent: Event,
  content: string,
  secretKey: Uint8Array,
): VerifiedEvent {
  return finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [
        ['h', channelId],
        ['e', parentEvent.id, '', 'reply'],
        ['p', parentEvent.pubkey],
      ],
    },
    secretKey,
  );
}
