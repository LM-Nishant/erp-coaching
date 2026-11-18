/**
 * Load-test runner: builds a fresh institute through the API, runs the selected scenarios with
 * autocannon one after another, prints a summary table, writes a JSON report to load/results/ and
 * exits 1 when a scenario breaches its thresholds (2 when setup fails).
 *
 *   npm run load                         # all scenarios
 *   npm run load -- dashboards lists     # a subset
 *   npm run load -- --list               # names and descriptions
 *
 * Settings and threshold overrides come from LOAD_* environment variables; see docs/load-testing.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import autocannon from 'autocannon';
import { API_URL, REPO_ROOT, RESULTS_DIR, settings, thresholdOverrides } from './env';
import { allPersonas, buildWorld, refreshStaleTokens } from './fixtures';
import { scenarios, type Plan, type Scenario } from './scenarios';

interface Thresholds {
  maxP50Ms?: number;
  maxP95Ms?: number;
  maxP99Ms?: number;
  /** Fraction (0–1) of requests that failed: non-2xx responses, connection errors and timeouts. */
  maxErrorRate?: number;
  minRps?: number;
}

interface ScenarioResult {
  name: string;
  connections: number;
  seconds: number;
  requests: number;
  rps: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  statusCodes: Record<string, number>;
  errors: number;
  timeouts: number;
  errorRate: number;
  thresholds: Thresholds;
  breaches: string[];
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function selectScenarios(): Scenario[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const wanted = args.length ? args : settings.scenarios;
  if (!wanted.length) return scenarios;
  const unknown = wanted.filter((name) => !scenarios.some((s) => s.name === name));
  if (unknown.length)
    throw new Error(
      `Unknown scenario(s): ${unknown.join(', ')}. Available: ${scenarios.map((s) => s.name).join(', ')}`,
    );
  return scenarios.filter((s) => wanted.includes(s.name));
}

function thresholdsFor(name: string): Thresholds {
  let file: { defaults?: Thresholds; scenarios?: Record<string, Thresholds> } = {};
  if (fs.existsSync(settings.thresholdsFile))
    file = JSON.parse(fs.readFileSync(settings.thresholdsFile, 'utf8'));
  const overrides = Object.fromEntries(Object.entries(thresholdOverrides).filter(([, v]) => v !== undefined));
  return { ...file.defaults, ...file.scenarios?.[name], ...overrides };
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

async function runScenario(scenario: Scenario, plan: Plan): Promise<ScenarioResult> {
  const latencies: number[] = [];
  let nextClient = 0;
  const options: autocannon.Options = {
    url: API_URL,
    connections: plan.connections,
    ...(plan.amount ? { amount: plan.amount } : { duration: settings.durationSeconds }),
    timeout: settings.timeoutSeconds,
    // Called once per connection, in order, before its first request.
    setupClient: (client) => client.setRequests(plan.lists[nextClient++ % plan.lists.length]),
  };
  // autocannon's histograms have no p95, so latencies are collected from the response events.
  const result = await new Promise<autocannon.Result>((resolve, reject) => {
    const instance = autocannon(options, (error, finished) => (error ? reject(error) : resolve(finished)));
    instance.on('response', (_client, _status, _bytes, responseTime) => latencies.push(responseTime));
  });

  latencies.sort((a, b) => a - b);
  const statusCodes = Object.fromEntries(
    Object.entries(result.statusCodeStats ?? {}).map(([code, stat]) => [code, stat?.count ?? 0]),
  );
  const responses = latencies.length;
  const failed = result.non2xx + result.errors;
  const attempts = responses + result.errors;
  const latencyMs = {
    p50: round(percentile(latencies, 50)),
    p95: round(percentile(latencies, 95)),
    p99: round(percentile(latencies, 99)),
    max: round(latencies.at(-1) ?? 0),
    mean: round(responses ? latencies.reduce((sum, ms) => sum + ms, 0) / responses : 0),
  };
  const rps = round(result.duration > 0 ? responses / result.duration : 0);
  const errorRate = attempts ? failed / attempts : 0;
  const thresholds = thresholdsFor(scenario.name);
  const breaches: string[] = [];
  const over = (label: string, value: number, limit?: number) => {
    if (limit !== undefined && value > limit) breaches.push(`${label} ${value} > ${limit}`);
  };
  over('p50 ms', latencyMs.p50, thresholds.maxP50Ms);
  over('p95 ms', latencyMs.p95, thresholds.maxP95Ms);
  over('p99 ms', latencyMs.p99, thresholds.maxP99Ms);
  over('error rate', round(errorRate, 4), thresholds.maxErrorRate);
  if (thresholds.minRps !== undefined && rps < thresholds.minRps)
    breaches.push(`rps ${rps} < ${thresholds.minRps}`);
  if (!attempts) breaches.push('no requests completed');

  return {
    name: scenario.name,
    connections: plan.connections,
    seconds: round(result.duration),
    requests: attempts,
    rps,
    latencyMs,
    statusCodes,
    errors: result.errors,
    timeouts: result.timeouts,
    errorRate: round(errorRate, 4),
    thresholds,
    breaches,
  };
}

function hints(result: ScenarioResult): string[] {
  const codes = result.statusCodes;
  const notes: string[] = [];
  if (codes['429'])
    notes.push(
      '429 Too Many Requests: start the API with RATE_LIMIT_ENABLED=false (`npm run load:serve` does).',
    );
  if (codes['401']) notes.push('401: a token expired or its device session was revoked during the run.');
  if (result.name === 'lms-media' && (codes['403'] || codes['404'] || codes['410']))
    notes.push('Signed media URLs expired: keep LOAD_DURATION below the API’s SIGNED_URL_TTL_SECONDS.');
  if (result.timeouts)
    notes.push(`${result.timeouts} request(s) timed out after ${settings.timeoutSeconds} s.`);
  return notes;
}

function printTable(results: ScenarioResult[]): void {
  const header = [
    'scenario',
    'conns',
    'reqs',
    'req/s',
    'p50 ms',
    'p95 ms',
    'p99 ms',
    'max ms',
    'errors',
    'result',
  ];
  const rows = results.map((r) => [
    r.name,
    String(r.connections),
    String(r.requests),
    String(r.rps),
    String(r.latencyMs.p50),
    String(r.latencyMs.p95),
    String(r.latencyMs.p99),
    String(r.latencyMs.max),
    `${round(r.errorRate * 100, 2)}%`,
    r.breaches.length ? `FAIL: ${r.breaches.join('; ')}` : 'pass',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (i === 9 ? 0 : row[i].length))),
  );
  const line = (cells: string[]) => cells.map((c, i) => (i === 9 ? c : c.padEnd(widths[i]))).join('  ');
  log(`\n${line(header)}`);
  log(widths.map((w, i) => '-'.repeat(i === 9 ? 6 : w)).join('  '));
  for (const row of rows) log(line(row));
}

function writeReport(
  startedAt: Date,
  world: { instituteId: number; slug: string },
  results: ScenarioResult[],
): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  const cpus = os.cpus();
  const report = {
    startedAt: startedAt.toISOString(),
    apiUrl: API_URL,
    settings: {
      durationSeconds: settings.durationSeconds,
      connections: settings.connections,
      students: settings.students,
      timeoutSeconds: settings.timeoutSeconds,
      thresholdsFile: path.relative(REPO_ROOT, settings.thresholdsFile),
    },
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGb: round(os.totalmem() / 1024 ** 3),
      loadAverage: os.loadavg().map((n) => round(n, 2)),
    },
    world,
    results,
  };
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

async function main(): Promise<number> {
  if (process.argv.includes('--list')) {
    for (const s of scenarios) log(`${s.name.padEnd(12)} ${s.summary}`);
    return 0;
  }
  const selected = selectScenarios();
  const startedAt = new Date();

  try {
    const health = await fetch(`${API_URL}/api/health`);
    if (!health.ok) throw new Error(`status ${health.status}`);
  } catch (error) {
    throw new Error(
      `The API at ${API_URL} is not answering /api/health (${(error as Error).message}). ` +
        'Start it with `npm run load:serve` or point LOAD_API_URL at a running API.',
    );
  }

  log(`Load test against ${API_URL}: ${selected.map((s) => s.name).join(', ')}`);
  log(
    `  ${settings.connections} connections, ${settings.durationSeconds} s per scenario, ${settings.students} students`,
  );
  const setupStarted = Date.now();
  const world = await buildWorld((message) => log(`  setup: ${message}`));
  log(`  setup done in ${round((Date.now() - setupStarted) / 1000)} s`);

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    await refreshStaleTokens(allPersonas(world));
    const plan = await scenario.plan(world);
    log(
      `▶ ${scenario.name}: ${scenario.summary} ` +
        `(${plan.connections} connections, ${plan.amount ? `${plan.amount} requests` : `${settings.durationSeconds} s`})`,
    );
    const result = await runScenario(scenario, plan);
    results.push(result);
    for (const note of hints(result)) log(`  ! ${note}`);
  }

  printTable(results);
  const report = writeReport(startedAt, { instituteId: world.instituteId, slug: world.slug }, results);
  log(`\nReport: ${path.relative(REPO_ROOT, report)}`);
  const failed = results.filter((r) => r.breaches.length);
  if (failed.length) {
    log(`Thresholds breached in: ${failed.map((r) => r.name).join(', ')}`);
    return 1;
  }
  log('All thresholds met.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `Load test setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  },
);
