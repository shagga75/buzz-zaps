import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildChannelReply } from '../src/nostr/messages.js';

const secretKey = generateSecretKey();
const mentionPubkey = 'a'.repeat(64);

describe('buildChannelReply', () => {
  it('adds a NIP-10 reply e-tag when threadEventId is set', () => {
    const event = buildChannelReply('chan-1', { threadEventId: 'msg-1', mentionPubkey }, 'hi', secretKey);
    expect(event.tags).toContainEqual(['e', 'msg-1', '', 'reply']);
  });

  it('omits the e-tag entirely when threadEventId is null (e.g. bounty payouts, whose target is not a channel message)', () => {
    const event = buildChannelReply('chan-1', { threadEventId: null, mentionPubkey }, 'hi', secretKey);
    expect(event.tags.some((t) => t[0] === 'e')).toBe(false);
    expect(event.tags).toContainEqual(['h', 'chan-1']);
    expect(event.tags).toContainEqual(['p', mentionPubkey]);
  });
});
