import type { Logger } from '../logger.js';

/**
 * Thin client for LaWallet NWC's public LUD-16 surface. Endpoints and
 * response shapes below are read straight from the fork's source, not
 * guessed:
 *   - apps/web/app/api/lud16/[username]/route.ts        (payRequest metadata)
 *   - apps/web/app/api/lud16/[username]/cb/route.ts      (invoice minting)
 *   - apps/web/app/api/lud16/[username]/verify/[hash]/route.ts (LUD-21 verify)
 *
 * We deliberately do NOT depend on LaWallet's own NIP-57 zap-receipt code —
 * it only fires for the "proxyAlias" forwarding route, not for a normal
 * wallet-backed address (see README "Known limitations"). buzz-zaps treats
 * LaWallet purely as a Lightning payment rail: request invoice, poll for
 * settlement via the public LUD-21 verify URL. Nothing here requires auth.
 */

interface PayRequestResponse {
  status: 'OK' | 'ERROR';
  reason?: string;
  tag?: string;
  callback?: string;
  minSendable?: number;
  maxSendable?: number;
  metadata?: string;
  commentAllowed?: number;
}

interface CallbackResponse {
  status?: 'ERROR';
  reason?: string;
  pr?: string;
  routes?: unknown[];
  verify?: string;
}

interface VerifyResponse {
  status: 'OK' | 'ERROR';
  reason?: string;
  settled?: boolean;
  preimage?: string | null;
  pr?: string;
}

export interface InvoiceResult {
  bolt11: string;
  verifyUrl: string;
}

export interface SettlementResult {
  settled: boolean;
  preimage: string | null;
}

export class LaWalletError extends Error {}

export class LaWalletClient {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {}

  async requestInvoice(username: string, amountSats: number, comment?: string): Promise<InvoiceResult> {
    const payRequest = await this.fetchPayRequest(username);
    if (payRequest.status !== 'OK' || !payRequest.callback) {
      throw new LaWalletError(payRequest.reason ?? `LNURL payRequest for @${username} did not return status OK`);
    }

    const amountMsats = amountSats * 1000;
    if (payRequest.minSendable !== undefined && amountMsats < payRequest.minSendable) {
      throw new LaWalletError(`${amountSats} sats is below @${username}'s minimum (${payRequest.minSendable / 1000} sats)`);
    }
    if (payRequest.maxSendable !== undefined && amountMsats > payRequest.maxSendable) {
      throw new LaWalletError(`${amountSats} sats is above @${username}'s maximum (${payRequest.maxSendable / 1000} sats)`);
    }

    const callbackUrl = new URL(payRequest.callback);
    callbackUrl.searchParams.set('amount', String(amountMsats));
    if (comment) callbackUrl.searchParams.set('comment', comment);

    const res = await fetch(callbackUrl);
    const body = (await res.json()) as CallbackResponse;
    if (!res.ok || body.status === 'ERROR' || !body.pr || !body.verify) {
      throw new LaWalletError(body.reason ?? `LNURL callback for @${username} failed (HTTP ${res.status})`);
    }

    this.logger.info({ username, amountSats }, 'requested invoice from LaWallet');
    return { bolt11: body.pr, verifyUrl: body.verify };
  }

  /** Polls the LUD-21 verify URL until settled or timeoutMs elapses. */
  async pollUntilSettled(verifyUrl: string, intervalMs: number, timeoutMs: number): Promise<SettlementResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.checkVerify(verifyUrl);
      if (result.settled) return result;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { settled: false, preimage: null };
  }

  private async checkVerify(verifyUrl: string): Promise<SettlementResult> {
    const res = await fetch(verifyUrl);
    const body = (await res.json()) as VerifyResponse;
    if (!res.ok || body.status === 'ERROR') {
      throw new LaWalletError(body.reason ?? `LUD-21 verify failed (HTTP ${res.status})`);
    }
    return { settled: Boolean(body.settled), preimage: body.preimage ?? null };
  }

  private async fetchPayRequest(username: string): Promise<PayRequestResponse> {
    const res = await fetch(`${this.baseUrl}/.well-known/lnurlp/${encodeURIComponent(username)}`);
    const body = (await res.json()) as PayRequestResponse;
    if (!res.ok) {
      throw new LaWalletError(body.reason ?? `LNURL payRequest lookup failed for @${username} (HTTP ${res.status})`);
    }
    return body;
  }
}
