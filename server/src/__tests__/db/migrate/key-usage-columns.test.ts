import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { down, up } from '../../../db/migrations/20261001_000002_key_usage_columns.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

const COLUMN_NAMES = ['usage_remaining', 'usage_allowance', 'usage_updated_at'] as const;

function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map(c => c.name);
}

describe('20261001 key usage columns', () => {
  it('adds the three usage columns as nullable, no default', async () => {
    const db = new Database(':memory:');
    await runMigrations(db, 'up');
    const info = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string; dflt_value: unknown; notnull: number }[];
    for (const name of COLUMN_NAMES) {
      const col = info.find(c => c.name === name);
      expect(col, `${name} must exist`).toBeDefined();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
    db.close();
  });

  it('down() removes the columns and up() restores them', async () => {
    const db = new Database(':memory:');
    await runMigrations(db, 'up');
    down(db);
    let names = columnNames(db);
    for (const name of COLUMN_NAMES) expect(names).not.toContain(name);
    up(db);
    names = columnNames(db);
    for (const name of COLUMN_NAMES) expect(names).toContain(name);
    db.close();
  });
});
