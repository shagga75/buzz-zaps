import type { ResolvedCommunity, Trigger } from '../config.js';
import { ZapStore, type ZapStatus } from '../db/store.js';
import { FeeStore, type FeeStatus } from '../db/fees.js';
import { LinkStore } from '../db/links.js';
import { BountyStore, type BountyStatus } from '../db/bounties.js';

export function formatTrigger(trigger: Trigger): string {
  switch (trigger.on) {
    case 'manual_zap_command':
      return `manual_zap_command(${trigger.command})`;
    case 'reaction_added':
      return `reaction_added(${trigger.emoji},${trigger.amount_sats})`;
    case 'agent_task_completed':
      return `agent_task_completed(${trigger.amount_sats}→${trigger.service_username})`;
  }
}

export interface CommunityReport {
  name: string;
  channelId: string;
  relayUrl: string;
  lawalletBaseUrl: string;
  triggers: string[];
  fee: { bps: number; serviceUsername: string } | null;
  zaps: Record<ZapStatus, number>;
  /** null when this community has no fee configured — not the same as all-zero counts. */
  fees: Record<FeeStatus, { count: number; totalSats: number }> | null;
  bounties: Record<BountyStatus, { count: number; totalSats: number }>;
  linksRegistered: number;
}

/**
 * Gathers the same data `pnpm admin-report` prints, as a plain object —
 * shared by the CLI script (scripts/admin-report.ts, formats it as text)
 * and the HTTP server (scripts/admin-server.ts, serves it as JSON), so
 * the two never drift out of sync with each other.
 *
 * Opens and closes its own SQLite handles per call rather than taking
 * already-open stores — this always runs as a separate, short-lived read
 * against files the long-running bot process (or another admin-report
 * invocation) may have open at the same time. WAL mode (set by every
 * store's constructor) is what makes that safe.
 */
export function buildCommunityReport(community: ResolvedCommunity): CommunityReport {
  const store = new ZapStore(community.dbPath);
  const feeStore = new FeeStore(community.dbPath);
  const links = new LinkStore(community.dbPath);
  const bounties = new BountyStore(community.dbPath);

  try {
    return {
      name: community.name,
      channelId: community.config.channelId,
      relayUrl: community.config.buzzRelayUrl,
      lawalletBaseUrl: community.config.lawalletBaseUrl,
      triggers: community.triggers.triggers.map(formatTrigger),
      fee: community.config.fee ? { bps: community.config.fee.bps, serviceUsername: community.config.fee.serviceUsername } : null,
      zaps: store.summarizeStatus(),
      fees: community.config.fee ? feeStore.summarize() : null,
      bounties: bounties.summarize(),
      linksRegistered: links.count(),
    };
  } finally {
    store.close();
    feeStore.close();
    links.close();
    bounties.close();
  }
}
