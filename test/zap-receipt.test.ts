import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { buildSyntheticZapRequest, buildZapReceipt } from '../src/nostr/zap-receipt.js';

describe('zap receipt construction', () => {
  const botSecretKey = generateSecretKey();
  const botPubkey = getPublicKey(botSecretKey);
  const recipientPubkey = 'b'.repeat(64);
  const zappedEventId = 'c'.repeat(64);

  it('builds a valid, self-consistent kind:9734 zap request', () => {
    const zapRequest = buildSyntheticZapRequest(
      { recipientPubkey, zappedEventId, channelId: 'chan-1', amountMsats: 100_000, relays: ['ws://localhost:3000'] },
      botSecretKey,
    );
    expect(zapRequest.kind).toBe(9734);
    expect(zapRequest.pubkey).toBe(botPubkey);
    expect(verifyEvent(zapRequest)).toBe(true);
    expect(zapRequest.tags).toContainEqual(['p', recipientPubkey]);
    expect(zapRequest.tags).toContainEqual(['amount', '100000']);
  });

  it('builds a valid kind:9735 zap receipt referencing the request and invoice', () => {
    const zapRequest = buildSyntheticZapRequest(
      { recipientPubkey, zappedEventId, channelId: 'chan-1', amountMsats: 100_000, relays: [] },
      botSecretKey,
    );
    const receipt = buildZapReceipt(
      {
        recipientPubkey,
        zappedEventId,
        channelId: 'chan-1',
        bolt11: 'lnbc1...',
        preimage: 'deadbeef',
        paidAt: new Date('2026-01-01T00:00:00Z'),
        zapRequest,
      },
      botSecretKey,
    );
    expect(receipt.kind).toBe(9735);
    expect(verifyEvent(receipt)).toBe(true);
    expect(receipt.tags).toContainEqual(['bolt11', 'lnbc1...']);
    expect(receipt.tags).toContainEqual(['preimage', 'deadbeef']);
    expect(receipt.tags).toContainEqual(['p', recipientPubkey]);
    expect(receipt.tags).toContainEqual(['e', zappedEventId]);
    const description = receipt.tags.find((t) => t[0] === 'description')?.[1];
    expect(description && JSON.parse(description).id).toBe(zapRequest.id);
  });

  it('omits the preimage tag when settlement did not report one', () => {
    const zapRequest = buildSyntheticZapRequest(
      { recipientPubkey, zappedEventId, channelId: 'chan-1', amountMsats: 1000, relays: [] },
      botSecretKey,
    );
    const receipt = buildZapReceipt(
      { recipientPubkey, zappedEventId, channelId: 'chan-1', bolt11: 'lnbc1...', preimage: null, paidAt: new Date(), zapRequest },
      botSecretKey,
    );
    expect(receipt.tags.some((t) => t[0] === 'preimage')).toBe(false);
  });
});
