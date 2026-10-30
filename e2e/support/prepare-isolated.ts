// Prepares the isolated e2e stack (`npm run test:e2e:isolated`): creates the dedicated database
// if it is missing, migrates it, and recreates an empty storage directory. It connects to the
// maintenance database `postgres` only to create the e2e database, and changes nothing outside
// that database and the temp storage directory.
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const databaseUrl =
  process.env['E2E_DATABASE_URL'] ?? 'postgres://evidomo:evidomo@localhost:5432/evidomo_e2e';
const url = new URL(databaseUrl);
const databaseName = decodeURIComponent(url.pathname.slice(1));
// Guard: this script must never be pointed at a development or production database.
if (!/^[a-z0-9_]*e2e[a-z0-9_]*$/.test(databaseName)) {
  throw new Error(
    `Refusing to prepare "${databaseName}": the e2e database name must contain "e2e"`,
  );
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    databaseName,
  ]);
  if (existing.rowCount === 0) {
    // The name passed the pattern above, so quoting it as an identifier is safe.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    console.log(`Created database ${databaseName}`);
  }
} finally {
  await admin.end();
}

const migrate = spawnSync('npm', ['run', 'db:migrate'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
if (migrate.status !== 0) {
  throw new Error(`Migrations failed (exit ${migrate.status ?? migrate.signal})`);
}

// Same path as playwright.config.ts. Recreated so uploads from earlier runs do not pile up.
const storageDir = path.join(os.tmpdir(), 'evidomo-e2e-storage');
await rm(storageDir, { recursive: true, force: true });
await mkdir(storageDir, { recursive: true, mode: 0o700 });
