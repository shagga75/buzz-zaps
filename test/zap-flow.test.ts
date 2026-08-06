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

/** Like settledLawallet, but the fee's own verify URL never settles — lets a test exercise the fee's independent timeout path. */
function lawalletWithUnsettledFee(feeUsername: string) {
  return {
    requestInvoice: vi.fn(async (username: string) => ({
      bolt11: username === feeUsername ? 'lnbc-fee' : 'lnbc-main',
      verifyUrl: `https://verify/${username}`,
    })),
    pollUntilSettled: vi.fn(async (verifyUrl: string) => {
      if (verifyUrl === `https://verify/${feeUsername}`) return { settled: false, preimage: null };
      return { settled: true, preimage: 'ff'.repeat(16) };
    }),
  } as unknown as LaWalletClient;
}

function makeStore() {
  return { insertPending: vi.fn(() => 1), markPaid: vi.fn(), markExpired: vi.fn() } as any;
}

function makeFeeStore() {
  return { insertPending: vi.fn(() => 10), markPaid: vi.fn(), markExpired: vi.fn() } as any;
}

/** Lets the fee's background settlement-watcher (fire-and-forget) resolve before assertions run. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('runZapFlow fee middleware', () => {
  it('does not request a fee invoice when no fee is configured', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet(() => 'lnbc-main');
    const store = makeStore();
    const feeStore = makeFeeStore();

    const outcome = await runZapFlow(baseReq(), { relay, config: baseConfig, botSecretKey, lawallet, store, feeStore, logger: noopLogger });

    expect(outcome).toBe('paid');
    expect(lawallet.requestInvoice).toHaveBeenCalledTimes(1);
    expect(lawallet.requestInvoice).toHaveBeenCalledWith('alice', 100, expect.any(String));
    expect(feeStore.insertPending).not.toHaveBeenCalled();
  });

  it('requests a second invoice for the fee, to the community fee wallet, without blocking the main zap', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet((u) => (u === 'buzz-zaps-fees' ? 'lnbc-fee' : 'lnbc-main'));
    const store = makeStore();
    const feeStore = makeFeeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    const outcome = await runZapFlow(baseReq({ amountSats: 100 }), { relay, config, botSecretKey, lawallet, store, feeStore, logger: noopLogger });

    expect(outcome).toBe('paid'); // main outcome unaffected by the fee side-flow
    expect(lawallet.requestInvoice).toHaveBeenCalledWith('alice', 100, expect.any(String));
    expect(lawallet.requestInvoice).toHaveBeenCalledWith('buzz-zaps-fees', 2, expect.any(String)); // 2% of 100 sats
    expect(store.markPaid).toHaveBeenCalled();
    expect(feeStore.insertPending).toHaveBeenCalledWith(
      expect.objectContaining({ zapId: 1, serviceUsername: 'buzz-zaps-fees', amountSats: 2, bolt11: 'lnbc-fee' }),
    );
  });

  it('tracks the fee invoice as paid once its own settlement is confirmed', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet((u) => (u === 'buzz-zaps-fees' ? 'lnbc-fee' : 'lnbc-main'));
    const store = makeStore();
    const feeStore = makeFeeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    await runZapFlow(baseReq({ amountSats: 100 }), { relay, config, botSecretKey, lawallet, store, feeStore, logger: noopLogger });
    await flushMicrotasks(); // the fee settlement watcher is fire-and-forget, not awaited by runZapFlow

    expect(feeStore.markPaid).toHaveBeenCalledWith(10); // the id insertPending() returned
    expect(feeStore.markExpired).not.toHaveBeenCalled();
  });

  it('tracks the fee invoice as expired when its own settlement times out, without touching the main zap outcome', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = lawalletWithUnsettledFee('buzz-zaps-fees');
    const store = makeStore();
    const feeStore = makeFeeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    const outcome = await runZapFlow(baseReq({ amountSats: 100 }), { relay, config, botSecretKey, lawallet, store, feeStore, logger: noopLogger });
    await flushMicrotasks();

    expect(outcome).toBe('paid'); // the main zap still settled fine — only the fee's own poll timed out
    expect(store.markPaid).toHaveBeenCalled();
    expect(feeStore.markExpired).toHaveBeenCalledWith(10);
    expect(feeStore.markPaid).not.toHaveBeenCalled();
  });

  it('skips the fee when the zap already targets the fee wallet itself (no fee on a fee)', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet(() => 'lnbc-main');
    const store = makeStore();
    const feeStore = makeFeeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    await runZapFlow(baseReq({ targetUsername: 'buzz-zaps-fees' }), { relay, config, botSecretKey, lawallet, store, feeStore, logger: noopLogger });

    expect(lawallet.requestInvoice).toHaveBeenCalledTimes(1);
    expect(feeStore.insertPending).not.toHaveBeenCalled();
  });

  it('skips the fee when it rounds down to 0 sats', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = settledLawallet(() => 'lnbc-main');
    const store = makeStore();
    const feeStore = makeFeeStore();
    const config = { ...baseConfig, fee: { bps: 50, serviceUsername: 'buzz-zaps-fees' } } as AppConfig; // 0.5% of 10 sats -> 0.05, floors to 0

    await runZapFlow(baseReq({ amountSats: 10 }), { relay, config, botSecretKey, lawallet, store, feeStore, logger: noopLogger });

    expect(lawallet.requestInvoice).toHaveBeenCalledTimes(1);
    expect(feeStore.insertPending).not.toHaveBeenCalled();
  });

  it('does not fail the main zap or track anything when the fee invoice request itself fails', async () => {
    const relay = { publish: vi.fn(async () => '') } as unknown as Relay;
    const lawallet = {
      requestInvoice: vi.fn(async (username: string) => {
        if (username === 'buzz-zaps-fees') throw new LaWalletError('fee wallet unreachable');
        return { bolt11: 'lnbc-main', verifyUrl: 'https://verify/main' };
      }),
      pollUntilSettled: vi.fn().mockResolvedValue({ settled: true, preimage: 'ff'.repeat(16) }),
    } as unknown as LaWalletClient;
    const store = makeStore();
    const feeStore = makeFeeStore();
    const config = { ...baseConfig, fee: { bps: 200, serviceUsername: 'buzz-zaps-fees' } } as AppConfig;

    const outcome = await runZapFlow(baseReq(), { relay, config, botSecretKey, lawallet, store, feeStore, logger: noopLogger });

    expect(outcome).toBe('paid');
    expect(store.markPaid).toHaveBeenCalled();
    expect(feeStore.insertPending).not.toHaveBeenCalled();
  });
});
