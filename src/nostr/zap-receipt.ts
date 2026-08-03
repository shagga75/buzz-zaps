import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';

/**
 * KNOWN LIMITATION (see README "Known limitations"): a fully NIP-57-compliant
 * zap has the LNURL server hash the zap request (kind:9734) into the bolt11's
 * description, so any client can verify receipt <-> invoice <-> request
 * consistency. LaWallet NWC's `/cb` endpoint accepts a `nostr=` param but only
 * wires it into the invoice description for its "proxyAlias" forwarding route
 * (see apps/web/app/api/lud16/[username]/cb/route.ts) — a normal wallet-backed
 * address ignores it entirely (confirmed in code, not assumed).
 *
 * Until that's fixed upstream, buzz-zaps self-signs BOTH the zap request and
 * the zap receipt with its own bot key, acting as the "zap issuer" on behalf
 * of whoever ran the manual `/zap` command. This produces a well-formed,
 * NIP-57-*shaped* kind:9735 that any Nostr client can read and render, but
 * strict validators that check bolt11-description-hash-matches-zap-request
 * will find no match. That's a real, documented gap — not a bug in this code.
 */

export interface ZapRequestInput {
  recipientPubkey: string;
  zappedEventId: string;
  channelId: string;
  amountMsats: number;
  relays: string[];
  comment?: string;
}

export function buildSyntheticZapRequest(input: ZapRequestInput, secretKey: Uint8Array): VerifiedEvent {
  return finalizeEvent(
    {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000),
      content: input.comment ?? '',
      tags: [
        ['p', input.recipientPubkey],
        ['e', input.zappedEventId],
        ['h', input.channelId],
        ['amount', String(input.amountMsats)],
        ['relays', ...input.relays],
      ],
    },
    secretKey,
  );
}

export interface ZapReceiptInput {
  recipientPubkey: string;
  zappedEventId: string;
  channelId: string;
  bolt11: string;
  preimage: string | null;
  paidAt: Date;
  zapRequest: VerifiedEvent;
}

export function buildZapReceipt(input: ZapReceiptInput, secretKey: Uint8Array): VerifiedEvent {
  const tags: string[][] = [
    ['p', input.recipientPubkey],
    ['e', input.zappedEventId],
    ['h', input.channelId],
    ['bolt11', input.bolt11],
    ['description', JSON.stringify(input.zapRequest)],
  ];
  if (input.preimage) tags.push(['preimage', input.preimage]);

  return finalizeEvent(
    {
      kind: 9735,
      created_at: Math.floor(input.paidAt.getTime() / 1000),
      content: '',
      tags,
    },
    secretKey,
  );
}
