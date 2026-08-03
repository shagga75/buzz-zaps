export interface ZapCommand {
  /** Text typed after the @ — the LaWallet username we'll request an invoice for. */
  targetUsername: string;
  amountSats: number;
  /** Nostr pubkey of the mentioned user, taken from the message's `p` tag. */
  targetPubkey: string;
}

// `/zap @username 100` — username matches LaWallet's allowed username charset.
const ZAP_COMMAND_RE = /^\s*\/zap\s+@([a-zA-Z0-9_.-]+)\s+(\d+)\s*$/;

/**
 * Parses a Buzz channel message (kind 9 / 40002) for a manual `/zap` command.
 *
 * Requires the message to carry a `p` tag for the mentioned user — that's how
 * Buzz clients tag an `@mention` today, and it's the only reliable way we
 * have to resolve "@username" to a Nostr pubkey without a separate identity
 * lookup. Returns null if the content doesn't match or the mention is missing.
 */
export function parseZapCommand(event: { content: string; tags: string[][] }): ZapCommand | null {
  const match = ZAP_COMMAND_RE.exec(event.content);
  if (!match) return null;

  const [, targetUsername, amountRaw] = match;
  const amountSats = Number.parseInt(amountRaw, 10);
  if (!Number.isFinite(amountSats) || amountSats <= 0) return null;

  const pTag = event.tags.find((tag) => tag[0] === 'p' && tag[1]);
  if (!pTag) return null;

  return { targetUsername, amountSats, targetPubkey: pTag[1] };
}

// `/link username` — same charset LaWallet enforces when claiming a username
// (lowercase letters and numbers, max 16 chars).
const LINK_COMMAND_RE = /^\s*\/link\s+([a-z0-9]{1,16})\s*$/;

/** Parses a `/link <lawallet-username>` self-registration command. */
export function parseLinkCommand(event: { content: string }): { lawalletUsername: string } | null {
  const match = LINK_COMMAND_RE.exec(event.content);
  if (!match) return null;
  return { lawalletUsername: match[1] };
}
