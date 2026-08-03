import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';

export interface ReplyTarget {
  /** Event this reply threads under (NIP-10 `e` tag) — the message being reacted to or the command itself. */
  threadEventId: string;
  /** Who gets @-mentioned (NIP-10 `p` tag) — the command sender, or whoever triggered the action. */
  mentionPubkey: string;
}

/** A NIP-10 reply (kind 9, channel-scoped via `h`). */
export function buildChannelReply(
  channelId: string,
  target: ReplyTarget,
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
        ['e', target.threadEventId, '', 'reply'],
        ['p', target.mentionPubkey],
      ],
    },
    secretKey,
  );
}
