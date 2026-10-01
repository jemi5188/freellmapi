import type { Db } from '../types.js';

/**
 * Cached per-key usage snapshot for the dashboard badge (spec:
 * docs/superpowers/specs/2026-10-01-puter-usage-badge-design.md). Generic
 * column names on purpose — another platform with a metering read can adopt
 * the same columns later. NULL = never fetched; the API spells that as
 * `usage: null` and the dashboard hides the badge.
 */
const COLUMNS: { name: string; decl: string }[] = [
  { name: 'usage_remaining', decl: 'REAL' },
  { name: 'usage_allowance', decl: 'REAL' },
  { name: 'usage_updated_at', decl: 'INTEGER' },
];

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  for (const column of COLUMNS) {
    if (!hasColumn(db, 'api_keys', column.name)) {
      db.prepare(`ALTER TABLE api_keys ADD COLUMN ${column.name} ${column.decl}`).run();
    }
  }
}

export function down(db: Db): void {
  for (const column of COLUMNS) {
    if (hasColumn(db, 'api_keys', column.name)) {
      db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column.name}`).run();
    }
  }
}
