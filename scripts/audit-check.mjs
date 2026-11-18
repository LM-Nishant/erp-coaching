#!/usr/bin/env node
/**
 * Dependency audit gate, run by the CI `audit` job (see docs/security.md › Dependency scanning).
 *
 * Fails on advisories at or above AUDIT_LEVEL_PROD (default `high`) in production dependencies and
 * at or above AUDIT_LEVEL_ALL (default `critical`) anywhere, dev tooling included. An advisory in
 * .github/audit-allowlist.json (triaged: no fixed release yet and not reachable) only warns until
 * its `expires` date, so every exception gets looked at again.
 *
 *   node scripts/audit-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];

function rank(level) {
  const i = LEVELS.indexOf(level);
  if (i < 0) throw new Error(`Unknown audit level "${level}" (use one of ${LEVELS.join(', ')})`);
  return i;
}

const ALLOWLIST_FILE = fileURLToPath(new URL('../.github/audit-allowlist.json', import.meta.url));
const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')).advisories;
const today = new Date().toISOString().slice(0, 10);

function npmAudit(args) {
  let out;
  try {
    out = execFileSync('npm', ['audit', '--json', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    // npm audit exits non-zero whenever it finds anything; the JSON report is still on stdout.
    out = err.stdout;
    if (!out) throw err;
  }
  const report = JSON.parse(out);
  if (report.error)
    throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  return report;
}

/** One entry per advisory (GHSA id), with the vulnerable package ranges it covers. */
function advisories(report) {
  const byId = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue; // vulnerable only through another package
      const id = via.url?.split('/').pop() || String(via.source);
      const entry = byId.get(id) ?? {
        id,
        title: via.title,
        severity: via.severity,
        url: via.url,
        packages: [],
      };
      const pkg = `${via.name}@${via.range}`;
      if (!entry.packages.includes(pkg)) entry.packages.push(pkg);
      byId.set(id, entry);
    }
  }
  return [...byId.values()];
}

const scopes = [
  { name: 'Production dependencies', args: ['--omit=dev'], level: process.env.AUDIT_LEVEL_PROD || 'high' },
  { name: 'All dependencies', args: [], level: process.env.AUDIT_LEVEL_ALL || 'critical' },
];

let failures = 0;
for (const scope of scopes) {
  const found = advisories(npmAudit(scope.args)).filter((a) => rank(a.severity) >= rank(scope.level));
  console.log(`\n${scope.name}: ${found.length} advisories at "${scope.level}" or above`);
  for (const a of found) {
    const line = `${a.severity} ${a.id} ${a.title} [${a.packages.join(', ')}] ${a.url ?? ''}`;
    const allowed = allowlist.find((entry) => entry.id === a.id);
    if (allowed && allowed.expires >= today) {
      console.log(`  allowed until ${allowed.expires}: ${line}\n    ${allowed.reason}`);
      continue;
    }
    failures++;
    console.log(`  ${allowed ? `FAIL (allow-list entry expired ${allowed.expires})` : 'FAIL'}: ${line}`);
  }
}

if (failures) {
  console.error(
    `\n${failures} advisories need a fix: update the dependency (npm update / overrides), or triage it in .github/audit-allowlist.json.`,
  );
  process.exit(1);
}
console.log('\nDependency audit passed.');
