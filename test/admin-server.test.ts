import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAdminRequest } from '../src/admin/server.js';
import type { ResolvedCommunity } from '../src/config.js';

describe('handleAdminRequest', () => {
  let dir: string;
  let communities: ResolvedCommunity[];
  const token = 'a-real-secret-token';

  function community(name: string): ResolvedCommunity {
    return {
      name,
      config: {
        buzzRelayUrl: 'ws://localhost:3000',
        channelId: `chan-${name}`,
        lawalletBaseUrl: 'http://localhost:2288',
        verifyPollIntervalMs: 2000,
        verifyTimeoutMs: 120_000,
        zapReceiptExtraRelays: [],
      },
      repoCoord: undefined,
      dbPath: join(dir, `${name}.sqlite3`),
      triggers: { triggers: [] },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buzz-zaps-admin-server-test-'));
    communities = [community('alpha'), community('beta')];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a request with no Authorization header', () => {
    const result = handleAdminRequest({ method: 'GET', url: '/report', authorizationHeader: undefined }, communities, token);
    expect(result.status).toBe(401);
  });

  it('rejects a request with the wrong token', () => {
    const result = handleAdminRequest({ method: 'GET', url: '/report', authorizationHeader: 'Bearer wrong-token' }, communities, token);
    expect(result.status).toBe(401);
  });

  it('rejects a token of the wrong length just like any other wrong token', () => {
    const result = handleAdminRequest({ method: 'GET', url: '/report', authorizationHeader: 'Bearer short' }, communities, token);
    expect(result.status).toBe(401);
  });

  it('rejects a non-GET method even with a valid token', () => {
    const result = handleAdminRequest({ method: 'POST', url: '/report', authorizationHeader: `Bearer ${token}` }, communities, token);
    expect(result.status).toBe(405);
  });

  it('rejects an unknown path even with a valid token', () => {
    const result = handleAdminRequest({ method: 'GET', url: '/nope', authorizationHeader: `Bearer ${token}` }, communities, token);
    expect(result.status).toBe(404);
  });

  it('returns every community when no ?community filter is given', () => {
    const result = handleAdminRequest({ method: 'GET', url: '/report', authorizationHeader: `Bearer ${token}` }, communities, token);
    expect(result.status).toBe(200);
    const body = result.body as { communities: { name: string }[] };
    expect(body.communities.map((c) => c.name)).toEqual(['alpha', 'beta']);
  });

  it('filters to a single community via ?community=<name>', () => {
    const result = handleAdminRequest(
      { method: 'GET', url: '/report?community=beta', authorizationHeader: `Bearer ${token}` },
      communities,
      token,
    );
    expect(result.status).toBe(200);
    const body = result.body as { communities: { name: string }[] };
    expect(body.communities.map((c) => c.name)).toEqual(['beta']);
  });

  it('returns 404 for a ?community filter that matches nothing', () => {
    const result = handleAdminRequest(
      { method: 'GET', url: '/report?community=nope', authorizationHeader: `Bearer ${token}` },
      communities,
      token,
    );
    expect(result.status).toBe(404);
  });
});
