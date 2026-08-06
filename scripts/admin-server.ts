// Read-only HTTP admin report — the one inbound HTTP surface buzz-zaps has.
// Deliberately minimal: a single `GET /report[?community=<name>]` endpoint,
// gated by a shared bearer token (ADMIN_SERVER_TOKEN), same data as
// `pnpm admin-report` (src/admin/build-report.ts) served as JSON instead of
// text. Chosen over NIP-98 (signed Nostr requests) for the same reason the
// CLI report itself stayed minimal: lowest new surface for a first version,
// see README "Fase 3 — dashboard de administración remoto" for the tradeoff.
//
// Plain HTTP, no TLS — put this behind a reverse proxy (nginx/caddy) if it's
// reachable outside a trusted network, same expectation as any bearer-token
// API. Run: pnpm admin-server
import { createServer } from 'node:http';
import { loadGlobalConfig, loadCommunities } from '../src/config.js';
import { handleAdminRequest } from '../src/admin/server.js';

function main() {
  const global = loadGlobalConfig();
  if (!global.adminServerToken) {
    console.error('ADMIN_SERVER_TOKEN is not set — refusing to start an unauthenticated admin server.');
    process.exitCode = 1;
    return;
  }
  const token = global.adminServerToken;
  const communities = loadCommunities(global.communitiesConfigPath, global);

  const server = createServer((req, res) => {
    req.resume(); // no request body is ever read — drain it so the socket doesn't hang waiting
    req.on('end', () => {
      const result = handleAdminRequest({ method: req.method, url: req.url, authorizationHeader: req.headers.authorization }, communities, token);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });

  server.listen(global.adminServerPort, () => {
    console.log(`admin-server listening on :${global.adminServerPort} (GET /report, Bearer token required)`);
  });
}

main();
