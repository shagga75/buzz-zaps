/** Bounded pubkey -> isAgent cache, avoids re-querying kind:10100 (AGENT_PROFILE) per message. */
export class AgentPubkeyCache {
  private map = new Map<string, boolean>();

  constructor(private readonly maxSize = 5000) {}

  set(pubkey: string, isAgent: boolean) {
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(pubkey, isAgent);
  }

  get(pubkey: string): boolean | undefined {
    return this.map.get(pubkey);
  }
}
