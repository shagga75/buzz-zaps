import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommunityReport, formatTrigger } from '../src/admin/build-report.js';
import { ZapStore } from '../src/db/store.js';
import { FeeStore } from '../src/db/fees.js';
import { LinkStore } from '../src/db/links.js';
import { BountyStore } from '../src/db/bounties.js';
import type { ResolvedCommunity } from '../src/config.js';

describe('formatTrigger', () => {
  it('formats each trigger kind', () => {
    expect(formatTrigger({ on: 'manual_zap_command', command: '/zap' })).toBe('manual_zap_command(/zap)');
    expect(formatTrigger({ on: 'reaction_added', emoji: '🐝', amount_sats: 21 })).toBe('reaction_added(🐝,21)');
    expect(formatTrigger({ on: 'agent_task_completed', amount_sats: 50, service_username: 'svc' })).toBe(
      'agent_task_completed(50→svc)',
    );
  });
});

describe('buildCommunityReport', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buzz-zaps-report-test-'));
    dbPath = join(dir, 'test.sqlite3');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function community(overrides: Partial<ResolvedCommunity['config']> = {}): ResolvedCommunity {
    return {
      name: 'test-community',
      config: {
        buzzRelayUrl: 'ws://localhost:3000',
        channelId: 'chan-1',
        lawalletBaseUrl: 'http://localhost:2288',
        verifyPollIntervalMs: 2000,
        verifyTimeoutMs: 120_000,
        zapReceiptExtraRelays: [],
        ...overrides,
      },
      repoCoord: undefined,
      dbPath,
      triggers: { triggers: [{ on: 'manual_zap_command', command: '/zap' }] },
    };
  }

  it('reports fee as null (not just zero counts) when the community has no fee configured', () => {
    const report = buildCommunityReport(community());
    expect(report.fee).toBeNull();
    expect(report.fees).toBeNull();
  });

  it('includes fee config and a fee summary when the community has a fee configured', () => {
    const feeStore = new FeeStore(dbPath);
    feeStore.insertPending({ zapId: 1, serviceUsername: 'svc-fees', amountSats: 2, bolt11: 'lnbc1', verifyUrl: 'https://verify/1' });
    feeStore.close();

    const report = buildCommunityReport(community({ fee: { bps: 200, serviceUsername: 'svc-fees' } }));

    expect(report.fee).toEqual({ bps: 200, serviceUsername: 'svc-fees' });
    expect(report.fees).toEqual({
      pending: { count: 1, totalSats: 2 },
      paid: { count: 0, totalSats: 0 },
      expired: { count: 0, totalSats: 0 },
    });
  });

  it('reflects zap, bounty, and link counts from the community\'s own SQLite file', () => {
    const store = new ZapStore(dbPath);
    store.insertPending({
      channelId: 'chan-1',
      sourceEventId: 'ev-1',
      requestedByPubkey: 'a'.repeat(64),
      targetUsername: 'alice',
      targetPubkey: 'b'.repeat(64),
      amountSats: 100,
      bolt11: 'lnbc1',
      verifyUrl: 'https://verify/1',
    });
    store.close();

    const bounties = new BountyStore(dbPath);
    bounties.register('pr-1', 5000, 'a'.repeat(64));
    bounties.close();

    const links = new LinkStore(dbPath);
    links.link('a'.repeat(64), 'alice');
    links.close();

    const report = buildCommunityReport(community());

    expect(report.zaps).toEqual({ pending: 1, paid: 0, expired: 0, failed: 0 });
    expect(report.bounties).toEqual({ open: { count: 1, totalSats: 5000 }, paid: { count: 0, totalSats: 0 } });
    expect(report.linksRegistered).toBe(1);
    expect(report.triggers).toEqual(['manual_zap_command(/zap)']);
    expect(report.name).toBe('test-community');
    expect(report.channelId).toBe('chan-1');
  });
});
