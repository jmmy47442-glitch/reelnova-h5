import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const contract = JSON.parse(readFileSync(resolve(projectRoot, 'database/schema-contract.json'), 'utf8'));
const migrationDirectory = resolve(projectRoot, 'migrations');

const usage = `Usage:
  npm run db:migrate:check
  npm run db:migrate -- --apply
  npm run db:migrate -- --apply --adopt-existing

Options:
  --apply             Apply every pending migration in numeric order.
  --adopt-existing    Record an existing database only after its full schema passes.
  --env-file <path>   Read Cloudflare credentials from this file (default: .env).
  --help              Show this help.`;

const parseArguments = () => {
  const options = { apply: false, adoptExisting: false, envFile: '.env' };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--adopt-existing') options.adoptExisting = true;
    else if (argument === '--env-file' && args[index + 1]) options.envFile = args[++index];
    else if (argument === '--help') {
      console.log(usage);
      process.exit(0);
    } else throw new Error(`Unknown or incomplete option: ${argument}\n\n${usage}`);
  }
  if (options.adoptExisting && !options.apply) throw new Error('--adopt-existing requires --apply');
  return options;
};

const loadEnvFile = (fileName) => {
  const file = resolve(projectRoot, fileName);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
};

const loadMigrations = () => {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  if (files.length !== contract.migrations.length || files.some((name, index) => name !== contract.migrations[index])) {
    throw new Error('Migration files do not exactly match database/schema-contract.json');
  }
  return files.map((name, index) => {
    const version = Number(name.slice(0, 4));
    if (version !== index + 1) throw new Error(`Migration sequence has a gap before ${name}`);
    const sql = readFileSync(resolve(migrationDirectory, name), 'utf8');
    return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
};

const options = parseArguments();
loadEnvFile(options.envFile);
const migrations = loadMigrations();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !databaseId || !apiToken) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required');
}

const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
const d1Query = async (sql, params = []) => {
  const response = await fetch(queryUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => ({}));
  const failedResult = payload.result?.find((result) => !result.success);
  if (!response.ok || !payload.success || failedResult) {
    throw new Error(failedResult?.error || payload.errors?.[0]?.message || `Cloudflare D1 returned HTTP ${response.status}`);
  }
  return payload.result || [];
};

const readSchemaObjects = async () => {
  const [result] = await d1Query("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')");
  return result?.results || [];
};

const readColumns = async (existingTables) => {
  const tableNames = Object.keys(contract.tables).filter((name) => existingTables.has(name));
  if (!tableNames.length) return [];
  const results = await Promise.all(tableNames.map(async (tableName) => {
    const [result] = await d1Query(
      `SELECT '${tableName}' AS table_name, name AS column_name FROM pragma_table_info('${tableName}')`);
    return result?.results || [];
  }));
  return results.flat();
};

const readMigrationRows = async (tableNames) => {
  if (!tableNames.has('schema_migrations')) return [];
  const [result] = await d1Query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return result?.results || [];
};

const validateMigrationRows = (rows, requireLatest) => {
  for (let index = 0; index < rows.length; index += 1) {
    const expected = migrations[index];
    const row = rows[index];
    if (!expected || Number(row.version) !== expected.version) {
      throw new Error(`Migration history is not contiguous at version ${index + 1}`);
    }
    if (row.name !== expected.name) throw new Error(`Migration ${expected.version} name does not match the repository`);
    if (row.checksum !== expected.checksum) throw new Error(`Migration ${expected.version} checksum does not match the repository`);
  }
  if (requireLatest && rows.length !== migrations.length) {
    throw new Error(`Database is at migration ${rows.length}; migration ${migrations.length} is required`);
  }
};

const inspectSchema = async ({ requireLatestHistory = true } = {}) => {
  const objects = await readSchemaObjects();
  const namesByType = new Map(['table', 'index', 'trigger'].map((type) => [type, new Set()]));
  for (const object of objects) namesByType.get(object.type)?.add(object.name);
  const tableNames = namesByType.get('table');
  const columns = await readColumns(tableNames);
  const columnsByTable = new Map();
  for (const row of columns) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  }
  const missing = {
    tables: Object.keys(contract.tables).filter((name) => !tableNames.has(name)),
    columns: Object.entries(contract.tables).flatMap(([tableName, expectedColumns]) => tableNames.has(tableName)
      ? expectedColumns.filter((column) => !columnsByTable.get(tableName)?.has(column)).map((column) => `${tableName}.${column}`)
      : []),
    indexes: contract.indexes.filter((name) => !namesByType.get('index').has(name)),
    triggers: contract.triggers.filter((name) => !namesByType.get('trigger').has(name)),
  };
  const migrationRows = await readMigrationRows(tableNames);
  let migrationError = null;
  try {
    validateMigrationRows(migrationRows, requireLatestHistory);
    if (!tableNames.has('schema_migrations')) migrationError = 'Migration history table schema_migrations is missing';
  } catch (error) {
    migrationError = error.message;
  }
  return { objects, tableNames, migrationRows, migrationError, missing };
};

const schemaIssues = (inspection, { ignoreHistory = false, ignoreLedgerTable = false } = {}) => {
  const missingTables = ignoreLedgerTable
    ? inspection.missing.tables.filter((name) => name !== 'schema_migrations')
    : inspection.missing.tables;
  const missingColumns = ignoreLedgerTable
    ? inspection.missing.columns.filter((name) => !name.startsWith('schema_migrations.'))
    : inspection.missing.columns;
  return [
    ...(!ignoreHistory && inspection.migrationError ? [inspection.migrationError] : []),
    ...(missingTables.length ? [`Missing tables: ${missingTables.join(', ')}`] : []),
    ...(missingColumns.length ? [`Missing columns: ${missingColumns.join(', ')}`] : []),
    ...(inspection.missing.indexes.length ? [`Missing indexes: ${inspection.missing.indexes.join(', ')}`] : []),
    ...(inspection.missing.triggers.length ? [`Missing triggers: ${inspection.missing.triggers.join(', ')}`] : []),
  ];
};

const ensureMigrationTable = async () => {
  await d1Query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL,
    applied_via TEXT NOT NULL CHECK (applied_via IN ('migration', 'baseline')),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
  )`);
};

const recordMigration = async (migration, appliedVia, durationMs) => {
  const results = await d1Query(`INSERT INTO schema_migrations
    (version, name, checksum, applied_at, applied_via, duration_ms)
    SELECT ?, ?, ?, datetime('now'), ?, ?
    WHERE COALESCE((SELECT MAX(version) FROM schema_migrations), 0) = ?`, [
    migration.version, migration.name, migration.checksum, appliedVia, durationMs, migration.version - 1,
  ]);
  const changes = Number(results[0]?.meta?.changes || 0);
  if (changes !== 1) throw new Error(`Migration ${migration.version} could not be recorded in sequence`);
};

const printInspection = (inspection) => {
  const issues = schemaIssues(inspection);
  const applied = inspection.migrationRows.length
    ? Number(inspection.migrationRows.at(-1).version)
    : 0;
  console.log(`D1 migration version: ${applied}/${migrations.length}`);
  if (issues.length) {
    for (const issue of issues) console.log(`- ${issue}`);
  } else console.log('D1 schema contract: OK');
  return issues;
};

if (!options.apply) {
  const inspection = await inspectSchema();
  const issues = printInspection(inspection);
  if (issues.length) process.exitCode = 1;
} else {
  await ensureMigrationTable();
  let inspection = await inspectSchema({ requireLatestHistory: false });
  validateMigrationRows(inspection.migrationRows, false);

  if (options.adoptExisting) {
    const issues = schemaIssues(inspection, { ignoreHistory: true });
    if (issues.length) throw new Error(`Cannot adopt an incomplete database:\n- ${issues.join('\n- ')}`);
    for (const migration of migrations.slice(inspection.migrationRows.length)) {
      await recordMigration(migration, 'baseline', 0);
      console.log(`Adopted ${migration.name}`);
    }
  } else {
    const applicationTables = [...inspection.tableNames].filter((name) =>
      name !== 'schema_migrations' && name !== '_cf_KV' && !name.startsWith('sqlite_'));
    if (!inspection.migrationRows.length && applicationTables.length) {
      throw new Error('Existing schema has no migration history. Repair all schema gaps, then run with --apply --adopt-existing.');
    }
    for (const migration of migrations.slice(inspection.migrationRows.length)) {
      const startedAt = Date.now();
      await d1Query(migration.sql);
      const durationMs = Date.now() - startedAt;
      await recordMigration(migration, 'migration', durationMs);
      console.log(`Applied ${migration.name} (${durationMs} ms)`);
    }
  }

  inspection = await inspectSchema();
  const issues = printInspection(inspection);
  if (issues.length) throw new Error('D1 migration completed with schema contract violations');
}
