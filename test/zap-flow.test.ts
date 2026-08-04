import { describe, expect, it, vi } from 'vitest';
import type { Relay } from 'nostr-tools/relay';
import { generateSecretKey } from 'nostr-tools/pure';
import { runZapFlow, type ZapRequest } from '../src/bot/zap-flow.js';
import { LaWalletError, type LaWalletClient } from '../src/lightning/lawallet-client.js';
import type { AppConfig } from '../src/config.js';

const botSecretKey = generateSecretKey();
const baseConfig = {
  channelId: 'chan-1',
  buzzRelayUrl: 'ws://localhost:3000',
  zapReceiptExtraRelays: [],
  verifyPollIntervalMs: 10,
  verifyTimeoutMs: 1000,
} as unknown as AppConfig;
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => noopLogger } as any;

const recipientPubkey = 'recipient'.padEnd(64, '1');

function baseReq(overrides: Partial<ZapRequest> = {}): ZapRequest {
  return {
    channelId: 'chan-1',
    sourceEventId: 'src-1',
    threadEventId: 'src-1',
    channelReplyEventId: 'src-1',
    mentionPubkey: recipientPubkey,
    requestedByPubkey: recipientPubkey,
    targetUsername: 'alice',
    targetPubkey: recipientPubkey,
    amountSats: 100,
    ...overrides,
  };
}

function settledLawallet(bolt11ByUsername: (username: string) => string) {
  return {
    requestInvoice: vi.fn(async (username: string) => ({
      bolt11: bolt11ByUsername(username),
      verifyUrl: `https://verify/${username}`,
    })),
    pollUntilSettled: vi.fn().mockResolvedValue({ settled: true, preimage: 'ff'.repeat(16) }),
  } as unknown as LaWalletClient;
}

function makeStore() {
  return { insertPending: vi.fn(() => 1), markPaid: vi.fn(), markExpired: vi.fn() } as any;
}

describe('runZapFlow fee middleware', () => {
  it('does not request a fee invoice when no fee is configured', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet(() => 'lnbc-main');
    const store = makeStore();

    const outcome = await runZapFlow(baseReq(), { relay, config: baseConfig, botSecretKey, lawallet, store, logger: noopLogger });

    expect(outcome).toBe('paid');
    expect(lawallet.requestInvoice).toHaveBeenCalledTimes(1);
    expect(lawallet.requestInvoice).toHaveBeenCalledWith('alice', 100, expect.any(String));
  });

  it('requests a second invoice for the fee, to the community fee wallet, without blocking the main zap', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet((u) => (u === 'buzz-zaps-fees' ? 'lnbc-fee' : 'lnbc-main'));
    const store = makeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    const outcome = await runZapFlow(baseReq({ amountSats: 100 }), { relay, config, botSecretKey, lawallet, store, logger: noopLogger });

    expect(outcome).toBe('paid'); // main outcome unaffected by the fee side-flow
    expect(lawallet.requestInvoice).toHaveBeenCalledWith('alice', 100, expect.any(String));
    expect(lawallet.requestInvoice).toHaveBeenCalledWith('buzz-zaps-fees', 2, expect.any(String)); // 2% of 100 sats
    expect(store.markPaid).toHaveBeenCalled();
  });

  it('skips the fee when the zap already targets the fee wallet itself (no fee on a fee)', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet(() => 'lnbc-main');
    const store = makeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    await runZapFlow(baseReq({ targetUsername: 'buzz-zaps-fees' }), { relay, config, botSecretKey, lawallet, store, logger: noopLogger });

    expect(lawallet.requestInvoice).toHaveBeenCalledTimes(1);
  });

  it('skips the fee when it rounds down to 0 sats', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet(() => 'lnbc-main');
    const store = makeStore();
    const config = { ...baseConfig, fee: { bps: 50, serviceUsername: 'buzz-zaps-fees' } } as AppConfig; // 0.5% of 10 sats -> 0.05, floors to 0

    await runZapFlow(baseReq({ amountSats: 10 }), { relay, config, botSecretKey, lawallet, store, logger: noopLogger });

    expect(lawallet.requestInvoice).toHaveBeenCalledTimes(1);
  });

  it('does not fail the main zap when the fee invoice request itself fails', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = {
      requestInvoice: vi.fn(async (username: string) => {
        if (username === 'buzz-zaps-fees') throw new LaWalletError('fee wallet unreachable');
        return { bolt11: 'lnbc-main', verifyUrl: 'https://verify/main' };
      }),
      pollUntilSettled: vi.fn().mockResolvedValue({ settled: true, preimage: 'ff'.repeat(16) }),
    } as unknown as LaWalletClient;
    const store = makeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    const outcome = await runZapFlow(baseReq(), { relay, config, botSecretKey, lawallet, store, logger: noopLogger });

    expect(outcome).toBe('paid');
    expect(store.markPaid).toHaveBeenCalled();
  });
});
