import { timingSafeEqual } from 'node:crypto';
import type { ResolvedCommunity } from '../config.js';
import { buildCommunityReport } from './build-report.js';

export interface AdminRequest {
  method: string | undefined;
  url: string | undefined;
  authorizationHeader: string | undefined;
}

export interface AdminResponse {
  status: number;
  body: unknown;
}

/**
 * Constant-time token comparison — a plain `===` leaks how many leading
 * bytes matched through response timing, letting an attacker guess the
 * token byte by byte. `timingSafeEqual` requires equal-length buffers, so
 * a length mismatch (the common case: wrong token) is checked separately
 * rather than padding either side, which would just reintroduce a
 * length-dependent timing signal a different way.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Pure request handler for the admin HTTP server: data in
 * (method/url/header), a status+body decision out — no socket or Node
 * `http` response object touched here. `scripts/admin-server.ts` is a thin
 * wrapper around this that does the actual `node:http` plumbing; keeping
 * the decision logic separate from that is what makes it testable without
 * spinning up a real TCP listener.
 *
 * Single endpoint on purpose: `GET /report[?community=<name>]`, mirroring
 * `pnpm admin-report`'s own `--community` flag — same data
 * (`buildCommunityReport`), served as JSON instead of formatted for a
 * terminal.
 */
export function handleAdminRequest(req: AdminRequest, communities: ResolvedCommunity[], token: string): AdminResponse {
  const providedToken = req.authorizationHeader?.startsWith('Bearer ') ? req.authorizationHeader.slice('Bearer '.length) : undefined;
  if (!providedToken || !tokenMatches(providedToken, token)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  if (req.method !== 'GET') {
    return { status: 405, body: { error: 'method not allowed' } };
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/report') {
    return { status: 404, body: { error: 'not found' } };
  }

  const onlyCommunity = url.searchParams.get('community');
  const selected = onlyCommunity ? communities.filter((c) => c.name === onlyCommunity) : communities;
  if (onlyCommunity && selected.length === 0) {
    return { status: 404, body: { error: `no community named "${onlyCommunity}"` } };
  }

  return { status: 200, body: { communities: selected.map(buildCommunityReport) } };
}
