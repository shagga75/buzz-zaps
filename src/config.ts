import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const envSchema = z.object({
  BUZZ_BOT_NSEC: z.string().startsWith('nsec1'),
  LAWALLET_VERIFY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  LAWALLET_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Base directory for each community's SQLite file, used when a community
  // entry doesn't set its own `db_path`. Per-community DB isolation matters
  // once one process serves several communities — see loadCommunities().
  DB_DIR: z.string().default('./data'),
  COMMUNITIES_CONFIG_PATH: z.string().default('./config/communities.example.yaml'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ZAP_RECEIPT_EXTRA_RELAYS: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

/** Config shared across every community this process serves. */
export interface GlobalConfig {
  botNsec: string;
  verifyPollIntervalMs: number;
  verifyTimeoutMs: number;
  dbDir: string;
  communitiesConfigPath: string;
  logLevel: Env['LOG_LEVEL'];
  zapReceiptExtraRelays: string[];
}

export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  const parsed = envSchema.parse(env);
  return {
    botNsec: parsed.BUZZ_BOT_NSEC,
    verifyPollIntervalMs: parsed.LAWALLET_VERIFY_POLL_INTERVAL_MS,
    verifyTimeoutMs: parsed.LAWALLET_VERIFY_TIMEOUT_MS,
    dbDir: parsed.DB_DIR,
    communitiesConfigPath: parsed.COMMUNITIES_CONFIG_PATH,
    logLevel: parsed.LOG_LEVEL,
    zapReceiptExtraRelays: parsed.ZAP_RECEIPT_EXTRA_RELAYS.split(',')
      .map((relay) => relay.trim())
      .filter(Boolean),
  };
}

/**
 * What the bot handlers (zap-flow, reaction-flow, bounty-flow,
 * task-completion-flow, link-flow) actually read — one instance per
 * community. Deliberately doesn't carry `repoCoord`/`dbPath`/triggers:
 * those are only needed by index.ts to bootstrap a community, never by a
 * handler mid-flow.
 */
export interface AppConfig {
  buzzRelayUrl: string;
  channelId: string;
  lawalletBaseUrl: string;
  verifyPollIntervalMs: number;
  verifyTimeoutMs: number;
  zapReceiptExtraRelays: string[];
}

const triggerSchema = z.discriminatedUnion('on', [
  z.object({
    on: z.literal('manual_zap_command'),
    command: z.string().default('/zap'),
  }),
  z.object({
    on: z.literal('reaction_added'),
    emoji: z.string(),
    amount_sats: z.number().int().positive(),
  }),
  z.object({
    on: z.literal('agent_task_completed'),
    amount_sats: z.number().int().positive(),
    // LaWallet username that receives the charge (buzz-zaps' own service
    // address, not a per-user one) — kept in the trigger itself, not a new
    // required env var, so communities that don't use this trigger don't
    // need to configure a service wallet just to boot.
    service_username: z.string().min(1),
  }),
]);

export type Trigger = z.infer<typeof triggerSchema>;

/** Shape reaction-flow.ts and task-completion-flow.ts match rules against. */
export interface TriggersFile {
  triggers: Trigger[];
}

// A Buzz "community" is resolved server-side from the connection's Host
// header (see TenantContext in buzz-core/src/tenant.rs) — it's never
// something a client picks per-channel. So one process serving N
// communities means N independent relay connections (one per community's
// host), each authenticated separately and each free to point at its own
// LaWallet instance. `relay_url` and `lawallet_base_url` are therefore
// per-community, not global env vars.
const communityEntrySchema = z.object({
  name: z.string().min(1),
  relay_url: z.string().url(),
  channel_id: z.string().min(1),
  lawallet_base_url: z.string().url(),
  // NIP-34 repo coordinate ("30617:<owner-hex>:<repo-d>") to scope this
  // community's bounty payouts to one repo. Unset watches every merged PR
  // this community's relay connection can see.
  repo_coord: z.string().optional(),
  // Defaults to `${DB_DIR}/${name}.sqlite3` — see resolveCommunities().
  db_path: z.string().optional(),
  triggers: z.array(triggerSchema).default([]),
});

const communitiesFileSchema = z
  .object({
    communities: z.array(communityEntrySchema).min(1, 'communities.yaml must declare at least one community'),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    val.communities.forEach((community, index) => {
      if (seen.has(community.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate community name "${community.name}" — names must be unique (used to derive the default db_path)`,
          path: ['communities', index, 'name'],
        });
      }
      seen.add(community.name);
    });
  });

export type CommunityEntry = z.infer<typeof communityEntrySchema>;

/** A fully-resolved community, ready to hand to index.ts's per-community bootstrap. */
export interface ResolvedCommunity {
  name: string;
  config: AppConfig;
  repoCoord: string | undefined;
  dbPath: string;
  triggers: TriggersFile;
}

export function loadCommunities(path: string, global: GlobalConfig): ResolvedCommunity[] {
  const raw = readFileSync(path, 'utf-8');
  const parsed = communitiesFileSchema.parse(parseYaml(raw));
  return parsed.communities.map((community) => ({
    name: community.name,
    config: {
      buzzRelayUrl: community.relay_url,
      channelId: community.channel_id,
      lawalletBaseUrl: community.lawallet_base_url.replace(/\/$/, ''),
      verifyPollIntervalMs: global.verifyPollIntervalMs,
      verifyTimeoutMs: global.verifyTimeoutMs,
      zapReceiptExtraRelays: global.zapReceiptExtraRelays,
    },
    repoCoord: community.repo_coord,
    dbPath: community.db_path ?? `${global.dbDir}/${community.name}.sqlite3`,
    triggers: { triggers: community.triggers },
  }));
}
