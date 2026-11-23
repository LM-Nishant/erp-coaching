/*
 * Loads the rich demo data (seed.ts) into the database configured in backend/.env:
 *   npm run db:seed:demo [-- --only=apex] [-- --allow-production] [-- --allow-real-providers]
 * Requires the base demo seed (npm run db:seed with SEED_DEMO_DATA=true). Safe to re-run.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);

// Only mock/console providers in this process: nothing reaches a real SMS, email, payment or
// streaming vendor while the demo data is created.
Object.assign(process.env, {
  SMS_PROVIDER: 'console',
  WHATSAPP_PROVIDER: 'console',
  EMAIL_PROVIDER: 'console',
  PUSH_PROVIDER: 'console',
  PAYMENT_GATEWAY: 'mock',
  STREAMING_PROVIDER: 'mock',
  BIOMETRIC_PROVIDER: 'mock',
  CALENDAR_PROVIDER: 'mock',
  RATE_LIMIT_ENABLED: 'false',
  JOBS_WORKER_ENABLED: 'false',
  LOG_LEVEL: process.env.DEMO_SEED_LOG_LEVEL ?? 'warn',
});

async function main() {
  if (
    process.env.NODE_ENV === 'production' &&
    !flag('allow-production') &&
    process.env.DEMO_SEED_ALLOW_PRODUCTION !== 'true'
  ) {
    console.error(
      'Refusing to load demo data with NODE_ENV=production. Pass --allow-production (or set DEMO_SEED_ALLOW_PRODUCTION=true) if you really mean it.',
    );
    process.exit(1);
  }
  const { bootstrap } = await import('../../../bootstrap');
  const { createApp } = await import('../../../app');
  const { closeSequelize } = await import('../sequelize');
  const { seedRichDemo, configuredRealProviders } = await import('./seed');
  try {
    const modules = await bootstrap();
    const real = await configuredRealProviders();
    if (real.length && !flag('allow-real-providers')) {
      console.error(
        `Refusing to load demo data: real messaging providers are configured (${real.join(', ')}). ` +
          'The seed queues notifications that a running job worker would deliver through them. ' +
          'Pass --allow-real-providers to continue anyway.',
      );
      process.exitCode = 1;
      return;
    }
    const only = args
      .find((a) => a.startsWith('--only='))
      ?.slice('--only='.length)
      .split(',');
    const summary = await seedRichDemo({ app: createApp(modules) as never, only });
    for (const i of summary.institutes) console.log(`${i.slug}: done (${i.steps.join(', ')})`);
    if (!summary.institutes.length) process.exitCode = 1;
  } finally {
    await closeSequelize();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
