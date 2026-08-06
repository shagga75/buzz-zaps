import Database from 'better-sqlite3';

export type FeeStatus = 'pending' | 'paid' | 'expired';

export interface FeeRecord {
  zapId: number;
  serviceUsername: string;
  amountSats: number;
  bolt11: string;
  verifyUrl: string;
}

/**
 * Tracks the fee middleware's second invoice (see zap-flow.ts's
 * chargeFeeIfConfigured) separately from ZapStore: a fee only exists for
 * communities with `fee` configured, and its own settlement is polled
 * independently of the main zap it rides alongside. Still honor-system —
 * nothing here blocks or delays the main zap — this only adds visibility
 * into whether the fee actually got paid.
 */
export class FeeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        zap_id INTEGER NOT NULL,
        service_username TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        bolt11 TEXT NOT NULL,
        verify_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fees_status ON fees(status);
    `);
  }

  insertPending(record: FeeRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO fees (zap_id, service_username, amount_sats, bolt11, verify_url, status)
      VALUES (@zapId, @serviceUsername, @amountSats, @bolt11, @verifyUrl, 'pending')
    `);
    const info = stmt.run(record);
    return Number(info.lastInsertRowid);
  }

  markPaid(id: number) {
    this.db.prepare(`UPDATE fees SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`).run({ id });
  }

  markExpired(id: number) {
    this.db.prepare(`UPDATE fees SET status = 'expired' WHERE id = @id`).run({ id });
  }

  /** Count and total sats, by status — for the admin report (scripts/admin-report.ts). */
  summarize(): Record<FeeStatus, { count: number; totalSats: number }> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as count, COALESCE(SUM(amount_sats), 0) as total FROM fees GROUP BY status`).all() as {
      status: FeeStatus;
      count: number;
      total: number;
    }[];
    const summary: Record<FeeStatus, { count: number; totalSats: number }> = {
      pending: { count: 0, totalSats: 0 },
      paid: { count: 0, totalSats: 0 },
      expired: { count: 0, totalSats: 0 },
    };
    for (const row of rows) summary[row.status] = { count: row.count, totalSats: row.total };
    return summary;
  }

  close() {
    this.db.close();
  }
}
