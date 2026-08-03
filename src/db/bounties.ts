import Database from 'better-sqlite3';

export type BountyStatus = 'open' | 'paid';

export interface Bounty {
  targetEventId: string;
  amountSats: number;
  createdByPubkey: string;
  status: BountyStatus;
}

/**
 * Bounties are "soft escrow": no funds move when a bounty is registered.
 * `/bounty <event-id> <amount>` just records a promise; the payout happens
 * at merge time straight from the community's connected wallet (same
 * non-custodial model as Fase 1/2 — nobody's sats sit anywhere in between).
 */
export class BountyStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bounties (
        target_event_id TEXT PRIMARY KEY,
        amount_sats INTEGER NOT NULL,
        created_by_pubkey TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        paid_at TEXT
      );
    `);
  }

  register(targetEventId: string, amountSats: number, createdByPubkey: string) {
    this.db
      .prepare(
        `INSERT INTO bounties (target_event_id, amount_sats, created_by_pubkey) VALUES (@targetEventId, @amountSats, @createdByPubkey)
         ON CONFLICT(target_event_id) DO UPDATE SET amount_sats = excluded.amount_sats, created_by_pubkey = excluded.created_by_pubkey
         WHERE status = 'open'`,
      )
      .run({ targetEventId, amountSats, createdByPubkey });
  }

  getOpen(targetEventId: string): Bounty | null {
    const row = this.db
      .prepare(`SELECT target_event_id AS targetEventId, amount_sats AS amountSats, created_by_pubkey AS createdByPubkey, status FROM bounties WHERE target_event_id = ? AND status = 'open'`)
      .get(targetEventId) as Bounty | undefined;
    return row ?? null;
  }

  markPaid(targetEventId: string) {
    this.db
      .prepare(`UPDATE bounties SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE target_event_id = ?`)
      .run(targetEventId);
  }

  close() {
    this.db.close();
  }
}
