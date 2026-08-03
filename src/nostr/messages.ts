import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';

export interface ReplyTarget {
  /**
   * Event this reply threads under (NIP-10 `e` tag), or null to post a plain
   * top-level channel message. Must be a channel-scoped event (kind 9/40002)
   * when set — the relay resolves NIP-10 thread ancestry for any kind:9 with
   * a `reply`/`root`-marked `e` tag (`resolve_nip10_thread_meta` in
   * buzz-relay) and rejects it with "parent event has no channel
   * association" if the target has no channel_id. A NIP-34 PR/issue is a
   * real example that trips this — confirmed the hard way running the
   * bounty flow live, not by reading the code first.
   */
  threadEventId: string | null;
  /** Who gets @-mentioned (NIP-10 `p` tag) — the command sender, or whoever triggered the action. */
  mentionPubkey: string;
}

/** A NIP-10 reply (kind 9, channel-scoped via `h`), or a plain channel message when `threadEventId` is null. */
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
        ...(target.threadEventId ? [['e', target.threadEventId, '', 'reply']] : []),
        ['p', target.mentionPubkey],
      ],
    },
    secretKey,
  );
}
