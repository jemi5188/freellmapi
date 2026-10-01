import type { Db } from '../types.js';

/**
 * Puter roster expansion, 2026-10-01.
 *
 * Puter's catalog grew from ~40 curated entries to 1000+ upstream-prefixed
 * ids since the baseline seeding (20260928_000001). This migration adds the
 * newest flagship generation per family. SMOKE GATE (run live 2026-10-01
 * against POST /drivers/call, one minimal single-turn request per id, both
 * account keys available): 24 of the 32 candidates answered 200 with content.
 * The 8 rejections are deliberately NOT seeded:
 *   - gpt-6-sol-pro / gpt-6.1-sol-pro / gpt-6-astra-pro / gpt-6-luna-pro /
 *     gpt-5.5-pro / gpt-5.4-pro / gpt-5-pro — "All providers failed": Puter's
 *     free ai-chat channel does not serve the -pro tier.
 *   - claude-opus-5-fast — "AI provider out of credits" on the upstream side.
 *
 * INSERT is `INSERT OR IGNORE` on UNIQUE(platform, model_id), so a re-run is
 * a no-op and a pre-existing user-modified row is never overwritten. The
 * roster array is exported so the migration test imports the same list.
 *
 * QUOTA facts are unchanged from the baseline seeding: metered, monthly,
 * account-wide — all numeric limits stay NULL.
 */

export interface PuterModel {
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: 'Frontier' | 'Large' | 'Medium';
  contextWindow: number;
  supportsVision: boolean;
}

// Describes the allowance without stating a number Puter never published.
const MONTHLY_BUDGET = 'metered (account-wide)';

// Ordered strongest-first within each family so backfilled fallback
// priorities follow the roster's intent.
export const PUTER_EXPANSION_MODELS: readonly PuterModel[] = [
  // openai — the gpt-6 generation plus the 5.6 interim line
  { modelId: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', intelligenceRank: 1, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-6-sol', displayName: 'GPT-6 Sol', intelligenceRank: 1, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra', intelligenceRank: 1, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', intelligenceRank: 2, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', intelligenceRank: 2, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', intelligenceRank: 2, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-5.5', displayName: 'GPT-5.5', intelligenceRank: 3, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 128000, supportsVision: true },
  { modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', intelligenceRank: 6, speedRank: 3, sizeLabel: 'Large', contextWindow: 128000, supportsVision: true },
  { modelId: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', intelligenceRank: 12, speedRank: 2, sizeLabel: 'Medium', contextWindow: 128000, supportsVision: true },
  // anthropic
  { modelId: 'claude-opus-5', displayName: 'Claude Opus 5', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'claude-fable-5', displayName: 'Claude Fable 5', intelligenceRank: 2, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', intelligenceRank: 3, speedRank: 5, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5 (dotted)', intelligenceRank: 3, speedRank: 5, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  // google
  { modelId: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', intelligenceRank: 3, speedRank: 2, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', intelligenceRank: 5, speedRank: 2, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', intelligenceRank: 8, speedRank: 1, sizeLabel: 'Large', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', intelligenceRank: 13, speedRank: 1, sizeLabel: 'Medium', contextWindow: 1048576, supportsVision: true },
  // xai
  { modelId: 'grok-4.7', displayName: 'Grok 4.7', intelligenceRank: 2, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 500000, supportsVision: true },
  { modelId: 'grok-4.3', displayName: 'Grok 4.3', intelligenceRank: 4, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 500000, supportsVision: true },
  { modelId: 'grok-4.20', displayName: 'Grok 4.20', intelligenceRank: 5, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 500000, supportsVision: true },
  // deepseek
  { modelId: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', intelligenceRank: 6, speedRank: 4, sizeLabel: 'Large', contextWindow: 1000000, supportsVision: false },
  // zai
  { modelId: 'glm-5.2', displayName: 'GLM-5.2', intelligenceRank: 5, speedRank: 6, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: false },
  // moonshotai
  { modelId: 'kimi-k2.6', displayName: 'Kimi K2.6', intelligenceRank: 4, speedRank: 6, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  // minimax
  { modelId: 'minimax-m2.5', displayName: 'MiniMax M2.5', intelligenceRank: 6, speedRank: 6, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
];

export function up(db: Db): void {
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, supports_vision, supports_tools
    ) VALUES ('puter', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1, ?, 1)
  `);

  // Scoped to this platform on purpose — same reasoning as the baseline
  // seeding: an unscoped sweep would hand fallback rows to deliberately
  // excluded custom models.
  const findMissingFallbacks = db.prepare(`
    SELECT m.id
      FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
     WHERE m.platform = 'puter' AND f.id IS NULL
     ORDER BY m.intelligence_rank ASC
  `);

  const apply = db.transaction(() => {
    for (const model of PUTER_EXPANSION_MODELS) {
      insertModel.run(
        model.modelId,
        model.displayName,
        model.intelligenceRank,
        model.speedRank,
        model.sizeLabel,
        MONTHLY_BUDGET,
        model.contextWindow,
        model.supportsVision ? 1 : 0,
      );
    }

    const missing = findMissingFallbacks.all() as { id: number }[];
    if (missing.length === 0) return;
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    const addFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (let i = 0; i < missing.length; i++) addFallback.run(missing[i].id, maxPriority + i + 1);
  });
  apply();

  // Re-arm only THIS migration's rows: down() below disables exactly these,
  // so a down/up cycle must flip exactly these back. Re-arming the whole
  // platform here would silently re-enable baseline rows the user turned off.
  const reArm = db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'puter' AND model_id = ?`);
  for (const model of PUTER_EXPANSION_MODELS) reArm.run(model.modelId);

  // The profile-chain backfill (20260714) runs BEFORE this migration, so on a
  // fresh install the new puter models never enter a profile chain. On a
  // down/up replay, however, the models rows survive (down() only disables)
  // and that backfill then chains them — a state the first up never produced,
  // which the round-trip test rightly rejects. Drop those rows to converge;
  // on a single normal run there is nothing to delete.
  db.prepare(`
    DELETE FROM profile_models
     WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'puter')
  `).run();
}

/**
 * Disable rather than DELETE — same rationale as the baseline seeding
 * (AUTOINCREMENT renumbering would break the round-trip snapshot and orphan
 * fallback_config references). Scoped to this migration's rows only: the
 * baseline roster and any user-disabled rows must survive a down() intact.
 */
export function down(db: Db): void {
  const disable = db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'puter' AND model_id = ?`);
  for (const model of PUTER_EXPANSION_MODELS) disable.run(model.modelId);
}
