// Read-only report over every community's SQLite files + communities.yaml —
// no HTTP surface, no new auth model, same trust level as filesystem access
// to the box already has. Run: pnpm admin-report [--community <name>]
//
// The actual data-gathering (buildCommunityReport) is shared with
// scripts/admin-server.ts — this file only formats it as text for a
// terminal, the server formats the same shape as JSON.
import { loadGlobalConfig, loadCommunities } from '../src/config.js';
import { buildCommunityReport } from '../src/admin/build-report.js';

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
    const report = buildCommunityReport(community);

    console.log(`\n${report.name}  (chan: ${report.channelId})`);
    console.log(`  relay: ${report.relayUrl}`);
    console.log(`  lawallet: ${report.lawalletBaseUrl}`);
    console.log(`  triggers: ${report.triggers.join(', ') || '(ninguno)'}`);
    console.log(`  fee: ${report.fee ? `${report.fee.bps}bps -> @${report.fee.serviceUsername}` : '(sin fee configurada)'}`);

    console.log(
      `\n  zaps registrados:  pending:${report.zaps.pending}  paid:${report.zaps.paid}  expired:${report.zaps.expired}  failed:${report.zaps.failed}`,
    );
    console.log('    (un fallo al pedir el invoice nunca llega a insertarse acá — solo queda en los logs)');

    if (report.fees) {
      const feeSummary = report.fees;
      console.log(
        `\n  fees cobrados:   pagados:${feeSummary.paid.count} (${feeSummary.paid.totalSats} sats)  pendientes:${feeSummary.pending.count} (${feeSummary.pending.totalSats} sats)  vencidos:${feeSummary.expired.count} (${feeSummary.expired.totalSats} sats)`,
      );
      const totalFees = feeSummary.paid.count + feeSummary.pending.count + feeSummary.expired.count;
      if (totalFees > 0 && feeSummary.expired.count > 0) {
        console.log(`    ⚠ ${feeSummary.expired.count} invoice(s) de fee no se pagaron a tiempo — sin cobrar, honor-system`);
      }
    }

    console.log(`\n  bounties abiertos: ${report.bounties.open.count} (${report.bounties.open.totalSats} sats)`);
    console.log(`  bounties pagados:  ${report.bounties.paid.count} (${report.bounties.paid.totalSats} sats)`);

    console.log(`\n  links registrados: ${report.linksRegistered}`);
  }
  console.log();
}

main();
