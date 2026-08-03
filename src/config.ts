import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const envSchema = z.object({
  BUZZ_RELAY_URL: z.string().url(),
  BUZZ_BOT_NSEC: z.string().startsWith('nsec1'),
  BUZZ_CHANNEL_ID: z.string().min(1, 'BUZZ_CHANNEL_ID is required (test channel UUID)'),
  LAWALLET_BASE_URL: z.string().url(),
  LAWALLET_VERIFY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  LAWALLET_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DB_PATH: z.string().default('./data/buzz-zaps.sqlite3'),
  TRIGGERS_CONFIG_PATH: z.string().default('./config/triggers.example.yaml'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ZAP_RECEIPT_EXTRA_RELAYS: z.string().default(''),
  // NIP-34 repo coordinate ("30617:<owner-hex>:<repo-d>", the `a`-tag value
  // pointing at the repo's kind:30617 announcement) to scope bounty payouts
  // to one repo. Unset watches every merged PR in the community — fine for
  // a single-repo test setup, but a real multi-repo Buzz instance will want
  // this set.
  BUZZ_REPO_COORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  buzzRelayUrl: string;
  botNsec: string;
  channelId: string;
  lawalletBaseUrl: string;
  verifyPollIntervalMs: number;
  verifyTimeoutMs: number;
  dbPath: string;
  logLevel: Env['LOG_LEVEL'];
  zapReceiptExtraRelays: string[];
  triggersConfigPath: string;
  repoCoord: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    buzzRelayUrl: parsed.BUZZ_RELAY_URL,
    botNsec: parsed.BUZZ_BOT_NSEC,
    channelId: parsed.BUZZ_CHANNEL_ID,
    lawalletBaseUrl: parsed.LAWALLET_BASE_URL.replace(/\/$/, ''),
    verifyPollIntervalMs: parsed.LAWALLET_VERIFY_POLL_INTERVAL_MS,
    verifyTimeoutMs: parsed.LAWALLET_VERIFY_TIMEOUT_MS,
    dbPath: parsed.DB_PATH,
    logLevel: parsed.LOG_LEVEL,
    zapReceiptExtraRelays: parsed.ZAP_RECEIPT_EXTRA_RELAYS.split(',')
      .map((relay) => relay.trim())
      .filter(Boolean),
    triggersConfigPath: parsed.TRIGGERS_CONFIG_PATH,
    repoCoord: parsed.BUZZ_REPO_COORD,
  };
}

// --- Fase 2 scaffolding: triggers.yaml schema (only `manual_zap_command` is
// active in the MVP; the rest documents the shape triggers will need later). ---

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
]);

const triggersFileSchema = z.object({
  community: z.string().optional(),
  triggers: z.array(triggerSchema).default([]),
});

export type TriggersFile = z.infer<typeof triggersFileSchema>;

export function loadTriggersConfig(path: string): TriggersFile {
  const raw = readFileSync(path, 'utf-8');
  return triggersFileSchema.parse(parseYaml(raw));
}
