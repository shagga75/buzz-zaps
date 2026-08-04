import { describe, expect, it } from 'vitest';
import { ZapStore } from '../src/db/store.js';
import { LinkStore } from '../src/db/links.js';
import { BountyStore } from '../src/db/bounties.js';

// These three summary methods only exist for scripts/admin-report.ts — the
// script itself just does argv parsing + console.log, so the useful thing
// to test is the aggregation logic, not the CLI wrapper.

describe('ZapStore.summarizeStatus', () => {
  it('counts zero for every status on a fresh store', () => {
    const store = new ZapStore(':memory:');
    expect(store.summarizeStatus()).toEqual({ pending: 0, paid: 0, expired: 0, failed: 0 });
    store.close();
  });

  it('counts by status after inserts and transitions', () => {
    const store = new ZapStore(':memory:');
    const base = { channelId: 'chan-1', requestedByPubkey: 'a'.repeat(64), targetUsername: 'alice', targetPubkey: 'b'.repeat(64), bolt11: 'lnbc1', verifyUrl: 'https://verify/1' };

    const paidId = store.insertPending({ ...base, sourceEventId: 'ev-1', amountSats: 100 });
    store.markPaid(paidId, 'receipt-1');

    const expiredId = store.insertPending({ ...base, sourceEventId: 'ev-2', amountSats: 200 });
    store.markExpired(expiredId);

    store.insertPending({ ...base, sourceEventId: 'ev-3', amountSats: 300 }); // stays pending

    expect(store.summarizeStatus()).toEqual({ pending: 1, paid: 1, expired: 1, failed: 0 });
    store.close();
  });
});

describe('LinkStore.count', () => {
  it('reflects the number of registered links', () => {
    const links = new LinkStore(':memory:');
    expect(links.count()).toBe(0);
    links.link('a'.repeat(64), 'alice');
    links.link('b'.repeat(64), 'bob');
    expect(links.count()).toBe(2);
    links.link('a'.repeat(64), 'alice-renamed'); // re-linking the same pubkey doesn't add a row
    expect(links.count()).toBe(2);
    links.close();
  });
});

describe('BountyStore.summarize', () => {
  it('splits count and total sats by status', () => {
    const bounties = new BountyStore(':memory:');
    bounties.register('pr-1', 1000, 'a'.repeat(64));
    bounties.register('pr-2', 2000, 'a'.repeat(64));
    bounties.register('pr-3', 500, 'b'.repeat(64));
    bounties.markPaid('pr-2');

    expect(bounties.summarize()).toEqual({
      open: { count: 2, totalSats: 1500 },
      paid: { count: 1, totalSats: 2000 },
    });
    bounties.close();
  });

  it('returns zeroed summary when there are no bounties', () => {
    const bounties = new BountyStore(':memory:');
    expect(bounties.summarize()).toEqual({ open: { count: 0, totalSats: 0 }, paid: { count: 0, totalSats: 0 } });
    bounties.close();
  });
});
