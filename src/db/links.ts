import Database from 'better-sqlite3';

/**
 * Maps a Buzz Nostr pubkey to a LaWallet username, self-registered via the
 * `/link` command. Self-registration matters: the pubkey is whoever signed
 * the `/link` event, so the mapping is cryptographically self-asserted —
 * nobody can link someone else's identity to a username. This sidesteps
 * LaWallet not exposing any public pubkey → username lookup (confirmed by
 * reading its API routes: the only such endpoint requires admin auth).
 */
export class LinkStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_links (
        pubkey TEXT PRIMARY KEY,
        lawallet_username TEXT NOT NULL,
        linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
  }

  link(pubkey: string, lawalletUsername: string) {
    this.db
      .prepare(
        `INSERT INTO user_links (pubkey, lawallet_username) VALUES (@pubkey, @lawalletUsername)
         ON CONFLICT(pubkey) DO UPDATE SET lawallet_username = excluded.lawallet_username, linked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run({ pubkey, lawalletUsername });
  }

  getUsername(pubkey: string): string | null {
    const row = this.db.prepare(`SELECT lawallet_username AS username FROM user_links WHERE pubkey = ?`).get(pubkey) as
      | { username: string }
      | undefined;
    return row?.username ?? null;
  }

  close() {
    this.db.close();
  }
}
