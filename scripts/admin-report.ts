// Read-only report over every community's SQLite files + communities.yaml —
// no HTTP surface, no new auth model, same trust level as filesystem access
// to the box already has. Run: pnpm admin-report [--community <name>]
import { loadGlobalConfig, loadCommunities, type Trigger } from '../src/config.js';
import { ZapStore } from '../src/db/store.js';
import { FeeStore } from '../src/db/fees.js';
import { LinkStore } from '../src/db/links.js';
import { BountyStore } from '../src/db/bounties.js';

function formatTrigger(trigger: Trigger): string {
  switch (trigger.on) {
    case 'manual_zap_command':
      return `manual_zap_command(${trigger.command})`;
    case 'reaction_added':
      return `reaction_added(${trigger.emoji},${trigger.amount_sats})`;
    case 'agent_task_completed':
      return `agent_task_completed(${trigger.amount_sats}→${trigger.service_username})`;
  }
}

function parseArgs(argv: string[]): { community?: string } {
  const idx = argv.indexOf('--community');
  if (idx === -1) return {};
  const name = argv[idx + 1];
  if (!name) throw new Error('--community requires a value, e.g. --community buzz-zaps-test');
  return { community: name };
}

function main() {
  const { community: onlyCommunity } = parseArgs(process.argv.slice(2));
  const global = loadGlobalConfig();
  const communities = loadCommunities(global.communitiesConfigPath, global);
  const selected = onlyCommunity ? communities.filter((c) => c.name === onlyCommunity) : communities;

  if (onlyCommunity && selected.length === 0) {
    console.error(`no community named "${onlyCommunity}" in ${global.communitiesConfigPath}`);
    process.exitCode = 1;
    return;
  }

  for (const community of selected) {
    console.log(`\n${community.name}  (chan: ${community.config.channelId})`);
    console.log(`  relay: ${community.config.buzzRelayUrl}`);
    console.log(`  lawallet: ${community.config.lawalletBaseUrl}`);
    console.log(`  triggers: ${community.triggers.triggers.map(formatTrigger).join(', ') || '(ninguno)'}`);
    console.log(`  fee: ${community.config.fee ? `${community.config.fee.bps}bps -> @${community.config.fee.serviceUsername}` : '(sin fee configurada)'}`);

    const store = new ZapStore(community.dbPath);
    const feeStore = new FeeStore(community.dbPath);
    const links = new LinkStore(community.dbPath);
    const bounties = new BountyStore(community.dbPath);

    const zapSummary = store.summarizeStatus();
    console.log(`\n  zaps registrados:  pending:${zapSummary.pending}  paid:${zapSummary.paid}  expired:${zapSummary.expired}  failed:${zapSummary.failed}`);
    console.log('    (un fallo al pedir el invoice nunca llega a insertarse acá — solo queda en los logs)');

    if (community.config.fee) {
      const feeSummary = feeStore.summarize();
      console.log(
        `\n  fees cobrados:   pagados:${feeSummary.paid.count} (${feeSummary.paid.totalSats} sats)  pendientes:${feeSummary.pending.count} (${feeSummary.pending.totalSats} sats)  vencidos:${feeSummary.expired.count} (${feeSummary.expired.totalSats} sats)`,
      );
      const totalFees = feeSummary.paid.count + feeSummary.pending.count + feeSummary.expired.count;
      if (totalFees > 0 && feeSummary.expired.count > 0) {
        console.log(`    ⚠ ${feeSummary.expired.count} invoice(s) de fee no se pagaron a tiempo — sin cobrar, honor-system`);
      }
    }

    const bountySummary = bounties.summarize();
    console.log(`\n  bounties abiertos: ${bountySummary.open.count} (${bountySummary.open.totalSats} sats)`);
    console.log(`  bounties pagados:  ${bountySummary.paid.count} (${bountySummary.paid.totalSats} sats)`);

    console.log(`\n  links registrados: ${links.count()}`);

    store.close();
    feeStore.close();
    links.close();
    bounties.close();
  }
  console.log();
}

main();
