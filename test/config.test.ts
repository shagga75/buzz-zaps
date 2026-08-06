import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGlobalConfig, loadCommunities, type GlobalConfig } from '../src/config.js';

const baseEnv = {
  BUZZ_BOT_NSEC: 'nsec1x9mgeezkvm7qrjcg956kujwgdsh6mlqgp4mk997evuaw4qazz8vskmr3hs',
};

describe('loadGlobalConfig', () => {
  it('applies defaults and splits ZAP_RECEIPT_EXTRA_RELAYS on commas', () => {
    const config = loadGlobalConfig({
      ...baseEnv,
      ZAP_RECEIPT_EXTRA_RELAYS: 'wss://relay-a.example, wss://relay-b.example',
    });
    expect(config.dbDir).toBe('./data');
    expect(config.communitiesConfigPath).toBe('./config/communities.example.yaml');
    expect(config.verifyPollIntervalMs).toBe(2000);
    expect(config.zapReceiptExtraRelays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);
    expect(config.adminServerPort).toBe(8090);
    expect(config.adminServerToken).toBeUndefined();
  });

  it('passes through ADMIN_SERVER_PORT/ADMIN_SERVER_TOKEN when set', () => {
    const config = loadGlobalConfig({ ...baseEnv, ADMIN_SERVER_PORT: '9999', ADMIN_SERVER_TOKEN: 'secret-token' });
    expect(config.adminServerPort).toBe(9999);
    expect(config.adminServerToken).toBe('secret-token');
  });

  it('rejects a nsec that is not a valid nsec1 string', () => {
    expect(() => loadGlobalConfig({ BUZZ_BOT_NSEC: 'not-an-nsec' })).toThrow();
  });
});

describe('loadCommunities', () => {
  let dir: string;
  let global: GlobalConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'buzz-zaps-config-test-'));
    global = loadGlobalConfig(baseEnv);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCommunitiesYaml(contents: string): string {
    const path = join(dir, 'communities.yaml');
    writeFileSync(path, contents);
    return path;
  }

  it('resolves multiple communities, each with its own relay/wallet/db path', () => {
    const path = writeCommunitiesYaml(`
communities:
  - name: community-a
    relay_url: ws://a.example:3000
    channel_id: chan-a
    lawallet_base_url: http://lawallet-a.example/
    triggers:
      - on: manual_zap_command
        command: /zap
  - name: community-b
    relay_url: ws://b.example:3000
    channel_id: chan-b
    lawallet_base_url: http://lawallet-b.example
    db_path: /custom/path/b.sqlite3
    repo_coord: "30617:abc:repo"
    triggers: []
`);
    const communities = loadCommunities(path, global);

    expect(communities).toHaveLength(2);

    expect(communities[0].name).toBe('community-a');
    expect(communities[0].config.buzzRelayUrl).toBe('ws://a.example:3000');
    expect(communities[0].config.channelId).toBe('chan-a');
    // trailing slash stripped, same as the single-community loader used to do
    expect(communities[0].config.lawalletBaseUrl).toBe('http://lawallet-a.example');
    expect(communities[0].dbPath).toBe('./data/community-a.sqlite3'); // derived from DB_DIR + name
    expect(communities[0].repoCoord).toBeUndefined();
    expect(communities[0].triggers.triggers).toEqual([{ on: 'manual_zap_command', command: '/zap' }]);

    expect(communities[1].dbPath).toBe('/custom/path/b.sqlite3'); // explicit db_path wins over the default
    expect(communities[1].repoCoord).toBe('30617:abc:repo');
  });

  it('rejects two communities with the same name', () => {
    const path = writeCommunitiesYaml(`
communities:
  - name: dup
    relay_url: ws://a.example:3000
    channel_id: chan-a
    lawallet_base_url: http://lawallet-a.example
  - name: dup
    relay_url: ws://b.example:3000
    channel_id: chan-b
    lawallet_base_url: http://lawallet-b.example
`);
    expect(() => loadCommunities(path, global)).toThrow(/duplicate community name/);
  });

  it('rejects an empty communities list', () => {
    const path = writeCommunitiesYaml('communities: []\n');
    expect(() => loadCommunities(path, global)).toThrow();
  });

  it('resolves fee_bps/fee_service_username into a FeeConfig, and leaves it undefined when neither is set', () => {
    const path = writeCommunitiesYaml(`
communities:
  - name: with-fee
    relay_url: ws://a.example:3000
    channel_id: chan-a
    lawallet_base_url: http://lawallet-a.example
    fee_bps: 200
    fee_service_username: buzz-zaps-fees
  - name: without-fee
    relay_url: ws://b.example:3000
    channel_id: chan-b
    lawallet_base_url: http://lawallet-b.example
`);
    const communities = loadCommunities(path, global);

    expect(communities[0].config.fee).toEqual({ bps: 200, serviceUsername: 'buzz-zaps-fees' });
    expect(communities[1].config.fee).toBeUndefined();
  });

  it('rejects fee_bps set without fee_service_username (and vice versa)', () => {
    const onlyBps = writeCommunitiesYaml(`
communities:
  - name: broken
    relay_url: ws://a.example:3000
    channel_id: chan-a
    lawallet_base_url: http://lawallet-a.example
    fee_bps: 200
`);
    expect(() => loadCommunities(onlyBps, global)).toThrow(/fee_bps and fee_service_username must be set together/);

    const onlyUsername = writeCommunitiesYaml(`
communities:
  - name: broken
    relay_url: ws://a.example:3000
    channel_id: chan-a
    lawallet_base_url: http://lawallet-a.example
    fee_service_username: buzz-zaps-fees
`);
    expect(() => loadCommunities(onlyUsername, global)).toThrow(/fee_bps and fee_service_username must be set together/);
  });
});
