import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import {
  down as puterExpansionDown,
  PUTER_EXPANSION_MODELS,
  up as puterExpansionUp,
} from '../../../db/migrations/20261001_000001_puter_models_expansion.js';

// The 2026-10-01 expansion smoke-tested 32 candidate models against the live
// ai-chat driver (one minimal request each, both account keys available).
// 24 answered 200 with content; every `-pro` variant returned
// "All providers failed" and claude-opus-5-fast was out of upstream credits,
// so only the 24 survivors are seeded here. The roster and the migration
// share one exported array so the two can never drift.

process.env.ENCRYPTION_KEY = '0'.repeat(64);

async function openMigratedDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  await runMigrations(db, 'up');
  return db;
}

describe('20261001 puter models expansion', () => {
  it('seeds every smoke-tested model enabled', async () => {
    const db = await openMigratedDb();
    const stmt = db.prepare(`SELECT enabled FROM models WHERE platform = 'puter' AND model_id = ?`);
    for (const model of PUTER_EXPANSION_MODELS) {
      const row = stmt.get(model.modelId) as { enabled: number } | undefined;
      expect(row, `${model.modelId} must exist`).toBeDefined();
      expect(row?.enabled, `${model.modelId} must be enabled`).toBe(1);
    }
    db.close();
  });

  it('leaves the 2026-09-28 baseline roster enabled', async () => {
    const db = await openMigratedDb();
    const rows = db.prepare(`
      SELECT model_id, enabled FROM models WHERE platform = 'puter' AND model_id IN
      ('gpt-6-luna','claude-opus-5-5','gemini-3.8-flash','grok-4.6','glm-5.3','kimi-k3','minimax-m3','qwen3.8-max')
    `).all() as { model_id: string; enabled: number }[];
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.enabled, `${row.model_id} must stay enabled`).toBe(1);
    db.close();
  });

  it('hands every new model a fallback chain row', async () => {
    const db = await openMigratedDb();
    const missing = db.prepare(`
      SELECT m.model_id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE m.platform = 'puter' AND f.id IS NULL
    `).all() as { model_id: string }[];
    expect(missing).toEqual([]);
    db.close();
  });

  it('down() disables only the expansion rows, keeping the baseline roster enabled', async () => {
    const db = await openMigratedDb();
    puterExpansionDown(db);
    const newRows = db.prepare(`
      SELECT model_id, enabled FROM models WHERE platform = 'puter' AND model_id IN
      (${PUTER_EXPANSION_MODELS.map(() => '?').join(',')})
    `).all(...PUTER_EXPANSION_MODELS.map(m => m.modelId)) as { model_id: string; enabled: number }[];
    expect(newRows).toHaveLength(PUTER_EXPANSION_MODELS.length);
    for (const row of newRows) expect(row.enabled, `${row.model_id} must be disabled by down()`).toBe(0);
    const baselineRows = db.prepare(`
      SELECT model_id, enabled FROM models WHERE platform = 'puter' AND model_id IN
      ('gpt-6-luna','claude-opus-5-5','gemini-3.8-flash')
    `).all() as { model_id: string; enabled: number }[];
    expect(baselineRows).toHaveLength(3);
    for (const row of baselineRows) expect(row.enabled, `${row.model_id} must survive down()`).toBe(1);
    db.close();
  });

  it('up() after down() re-enables every puter row', async () => {
    const db = await openMigratedDb();
    puterExpansionDown(db);
    puterExpansionUp(db);
    const disabled = db.prepare(`
      SELECT model_id FROM models WHERE platform = 'puter' AND enabled = 0
    `).all() as { model_id: string }[];
    expect(disabled).toEqual([]);
    db.close();
  });
});
