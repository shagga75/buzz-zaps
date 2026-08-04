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

  it('omits the root e-tag when rootEventId equals threadEventId (the common, depth-0 case)', () => {
    const event = buildChannelReply('chan-1', { threadEventId: 'msg-1', rootEventId: 'msg-1', mentionPubkey }, 'hi', secretKey);
    const eTags = event.tags.filter((t) => t[0] === 'e');
    expect(eTags).toEqual([['e', 'msg-1', '', 'reply']]);
  });

  it('adds an explicit root e-tag when rootEventId diverges from threadEventId (replying under a message that is itself a reply)', () => {
    // Real case: agent_task_completed threads the bot's reply under the
    // agent's own reply, which is already a reply to the human's original
    // message — the relay rejects the lone-reply-tag shorthand there
    // ("root tag does not match thread ancestry", confirmed live), because
    // it no longer holds that the immediate parent is the thread root.
    const event = buildChannelReply(
      'chan-1',
      { threadEventId: 'agent-reply-1', rootEventId: 'human-msg-1', mentionPubkey },
      'hi',
      secretKey,
    );
    const eTags = event.tags.filter((t) => t[0] === 'e');
    expect(eTags).toEqual([
      ['e', 'human-msg-1', '', 'root'],
      ['e', 'agent-reply-1', '', 'reply'],
    ]);
  });
});
