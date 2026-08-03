import { getPublicKey } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';

export interface BotIdentity {
  secretKey: Uint8Array;
  pubkey: string;
}

export function loadBotIdentity(nsec: string): BotIdentity {
  const decoded = decode(nsec);
  if (decoded.type !== 'nsec') {
    throw new Error(`Expected an nsec1 key, got type "${decoded.type}"`);
  }
  const secretKey = decoded.data;
  return { secretKey, pubkey: getPublicKey(secretKey) };
}
