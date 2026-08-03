/** Bounded eventId -> pubkey cache, fed by every channel message we observe. */
export class MessageAuthorCache {
  private map = new Map<string, string>();

  constructor(private readonly maxSize = 5000) {}

  set(eventId: string, pubkey: string) {
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(eventId, pubkey);
  }

  get(eventId: string): string | undefined {
    return this.map.get(eventId);
  }
}
