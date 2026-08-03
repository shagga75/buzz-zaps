import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type ZapStatus = 'pending' | 'paid' | 'expired' | 'failed';

export interface ZapRecord {
  id?: number;
  channelId: string;
  sourceEventId: string;
  requestedByPubkey: string;
  targetUsername: string;
  targetPubkey: string;
  amountSats: number;
  bolt11: string;
  verifyUrl: string;
  status: ZapStatus;
  receiptEventId: string | null;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
}

export class ZapStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        requested_by_pubkey TEXT NOT NULL,
        target_username TEXT NOT NULL,
        target_pubkey TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        bolt11 TEXT NOT NULL,
        verify_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        receipt_event_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_zaps_status ON zaps(status);
    `);
  }

  insertPending(record: Omit<ZapRecord, 'id' | 'status' | 'receiptEventId' | 'error' | 'createdAt' | 'paidAt'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO zaps (channel_id, source_event_id, requested_by_pubkey, target_username, target_pubkey, amount_sats, bolt11, verify_url, status)
      VALUES (@channelId, @sourceEventId, @requestedByPubkey, @targetUsername, @targetPubkey, @amountSats, @bolt11, @verifyUrl, 'pending')
    `);
    const info = stmt.run(record);
    return Number(info.lastInsertRowid);
  }

  markPaid(id: number, receiptEventId: string) {
    this.db
      .prepare(
        `UPDATE zaps SET status = 'paid', receipt_event_id = @receiptEventId, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`,
      )
      .run({ id, receiptEventId });
  }

  markFailed(id: number, error: string) {
    this.db.prepare(`UPDATE zaps SET status = 'failed', error = @error WHERE id = @id`).run({ id, error });
  }

  markExpired(id: number) {
    this.db.prepare(`UPDATE zaps SET status = 'expired' WHERE id = @id`).run({ id });
  }

  close() {
    this.db.close();
  }
}
