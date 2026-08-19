import type { H3Event } from 'h3';
import schemaContract from '../../database/schema-contract.json';
import { d1All } from './cloudflare-d1';

interface SchemaObjectRow {
  type: 'table' | 'index' | 'trigger';
  name: string;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
}

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export interface DatabaseSchemaHealth {
  healthy: boolean;
  latestRequiredMigration: number;
  latestAppliedMigration: number;
  migrationHistoryValid: boolean;
  migrationError: string | null;
  missing: {
    tables: string[];
    columns: string[];
    indexes: string[];
    triggers: string[];
  };
}

const expectedMigrationName = (version: number) => schemaContract.migrations[version - 1];

const inspectMigrationHistory = (rows: MigrationRow[]) => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedVersion = index + 1;
    if (Number(row.version) !== expectedVersion) {
      return `Migration history is not contiguous: expected ${expectedVersion}, found ${row.version}`;
    }
    if (row.name !== expectedMigrationName(expectedVersion)) {
      return `Migration ${expectedVersion} name mismatch: expected ${expectedMigrationName(expectedVersion)}, found ${row.name}`;
    }
    if (!/^[a-f0-9]{64}$/i.test(row.checksum)) {
      return `Migration ${expectedVersion} has an invalid checksum`;
    }
  }
  if (rows.length !== schemaContract.migrations.length) {
    return `Database is at migration ${rows.length}; migration ${schemaContract.migrations.length} is required`;
  }
  return null;
};

export const inspectDatabaseSchema = async (event: H3Event): Promise<DatabaseSchemaHealth> => {
  const objects = await d1All<SchemaObjectRow>(event,
    "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')");
  const objectNames = new Map<string, Set<string>>();
  for (const type of ['table', 'index', 'trigger']) objectNames.set(type, new Set());
  for (const object of objects) objectNames.get(object.type)?.add(object.name);

  const tableNames = Object.keys(schemaContract.tables);
  const missingTables = tableNames.filter((name) => !objectNames.get('table')?.has(name));
  const existingApplicationTables = tableNames.filter((name) => !missingTables.includes(name));
  const columnBatches = await Promise.all(existingApplicationTables.map((tableName) =>
    d1All<ColumnRow>(event,
      `SELECT '${tableName}' AS table_name, name AS column_name FROM pragma_table_info('${tableName}')`)));
  const columns = columnBatches.flat();
  const actualColumns = new Map<string, Set<string>>();
  for (const column of columns) {
    if (!actualColumns.has(column.table_name)) actualColumns.set(column.table_name, new Set());
    actualColumns.get(column.table_name)?.add(column.column_name);
  }
  const missingColumns = Object.entries(schemaContract.tables).flatMap(([tableName, expectedColumns]) =>
    missingTables.includes(tableName)
      ? []
      : expectedColumns.filter((column) => !actualColumns.get(tableName)?.has(column)).map((column) => `${tableName}.${column}`));
  const missingIndexes = schemaContract.indexes.filter((name) => !objectNames.get('index')?.has(name));
  const missingTriggers = schemaContract.triggers.filter((name) => !objectNames.get('trigger')?.has(name));

  let migrationRows: MigrationRow[] = [];
  if (!missingTables.includes('schema_migrations')) {
    migrationRows = await d1All<MigrationRow>(event,
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  }
  const migrationError = missingTables.includes('schema_migrations')
    ? 'Migration history table schema_migrations is missing'
    : inspectMigrationHistory(migrationRows);
  const missing = { tables: missingTables, columns: missingColumns, indexes: missingIndexes, triggers: missingTriggers };
  return {
    healthy: !migrationError && Object.values(missing).every((items) => items.length === 0),
    latestRequiredMigration: schemaContract.migrations.length,
    latestAppliedMigration: migrationRows.length ? Number(migrationRows.at(-1)?.version) : 0,
    migrationHistoryValid: !migrationError,
    migrationError,
    missing,
  };
};

export const formatDatabaseSchemaError = (health: DatabaseSchemaHealth) => {
  const issues = [health.migrationError];
  for (const [kind, items] of Object.entries(health.missing)) {
    if (items.length) issues.push(`Missing ${kind}: ${items.join(', ')}`);
  }
  return issues.filter(Boolean).join('; ') || 'Database schema check failed';
};
