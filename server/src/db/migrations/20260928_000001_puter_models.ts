import type { Db } from '../types.js';

/**
 * Puter's curated model roster.
 *
 * Puter is reachable only through the `ai-chat` driver (see
 * providers/puter.ts), so these rows are seeded here rather than pulled from
 * the hosted catalog — `api.freellmapi.co` will never list the platform
 * (§8.1). Insert is `INSERT OR IGNORE` on UNIQUE(platform, model_id), so a
 * re-run is a no-op.
 *
 * SMOKE GATE (§8.3, run live on 2026-09-28 against POST /drivers/call, one
 * minimal single-turn request per id): 39 of the 40 candidates answered 200
 * with content. The single failure — `gpt-5-pro` (provider
 * `openai-responses`) — returned HTTP 400
 * `{"error":"All AI providers failed","code":"upstream_failed"}`, so it is
 * deliberately NOT seeded below. Every id in PUTER_MODELS passed.
 *
 * QUOTA (§8.4): Puter publishes no numeric free-tier limit. The allowance is
 * metered, resets monthly, and is shared by every model of the account, so
 * neither per-model rate limits nor a monthly token figure are invented here —
 * all limits stay NULL and `monthly_token_budget` carries a description. The
 * account-wide pool lives in services/provider-quota.ts (`puter::account`).
 */

interface PuterModel {
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: 'Frontier' | 'Large' | 'Medium';
  contextWindow: number;
  supportsVision: boolean;
  /** Only set false for families that emit tool calls as plain text — the Gemma
   *  line does (pinned by routes/proxy-tools-routing.test.ts); flagging it
   *  tool-capable would route requireTools traffic to a model that cannot. */
  supportsTools?: boolean;
}

// Describes the allowance without stating a number Puter never published.
const MONTHLY_BUDGET = 'metered (account-wide)';

// Ordered roughly strongest-first within each family so the backfilled
// fallback priorities follow the roster's intent.
const PUTER_MODELS: readonly PuterModel[] = [
  // azure-openai
  { modelId: 'gpt-5-nano', displayName: 'GPT-5 Nano', intelligenceRank: 12, speedRank: 2, sizeLabel: 'Medium', contextWindow: 128000, supportsVision: true },
  { modelId: 'gpt-5-mini', displayName: 'GPT-5 Mini', intelligenceRank: 6, speedRank: 3, sizeLabel: 'Large', contextWindow: 128000, supportsVision: true },
  { modelId: 'gpt-5.4', displayName: 'GPT-5.4', intelligenceRank: 2, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  { modelId: 'gpt-4o-mini', displayName: 'GPT-4o Mini', intelligenceRank: 15, speedRank: 3, sizeLabel: 'Medium', contextWindow: 128000, supportsVision: true },
  // openai-completion
  { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', intelligenceRank: 9, speedRank: 3, sizeLabel: 'Large', contextWindow: 1047576, supportsVision: true },
  { modelId: 'gpt-5-2025-08-07', displayName: 'GPT-5 (2025-08-07)', intelligenceRank: 4, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 128000, supportsVision: true },
  { modelId: 'gpt-6-luna', displayName: 'GPT-6 Luna', intelligenceRank: 1, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1050000, supportsVision: true },
  // claude
  { modelId: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', intelligenceRank: 10, speedRank: 2, sizeLabel: 'Large', contextWindow: 200000, supportsVision: true },
  { modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', intelligenceRank: 5, speedRank: 5, sizeLabel: 'Frontier', contextWindow: 200000, supportsVision: true },
  { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', intelligenceRank: 4, speedRank: 5, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', intelligenceRank: 2, speedRank: 9, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', intelligenceRank: 1, speedRank: 9, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', intelligenceRank: 2, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  // gemini
  { modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', intelligenceRank: 11, speedRank: 2, sizeLabel: 'Large', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite', intelligenceRank: 17, speedRank: 1, sizeLabel: 'Medium', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', intelligenceRank: 3, speedRank: 7, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', intelligenceRank: 6, speedRank: 2, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  { modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', intelligenceRank: 4, speedRank: 2, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  // gemma
  { modelId: 'gemma-4-31b-it', displayName: 'Gemma 4 31B', intelligenceRank: 19, speedRank: 3, sizeLabel: 'Medium', contextWindow: 262144, supportsVision: true, supportsTools: false },
  // xai
  { modelId: 'grok-4.5', displayName: 'Grok 4.5', intelligenceRank: 5, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 500000, supportsVision: true },
  { modelId: 'grok-4.6', displayName: 'Grok 4.6', intelligenceRank: 3, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 500000, supportsVision: true },
  // deepseek
  { modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', intelligenceRank: 8, speedRank: 4, sizeLabel: 'Large', contextWindow: 1000000, supportsVision: false },
  { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', intelligenceRank: 3, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: false },
  // zai
  { modelId: 'glm-4.7', displayName: 'GLM-4.7', intelligenceRank: 10, speedRank: 5, sizeLabel: 'Large', contextWindow: 200000, supportsVision: false },
  { modelId: 'glm-5.3', displayName: 'GLM-5.3', intelligenceRank: 4, speedRank: 6, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: false },
  { modelId: 'glm-5.3-flash', displayName: 'GLM-5.3 Flash', intelligenceRank: 12, speedRank: 3, sizeLabel: 'Large', contextWindow: 1000000, supportsVision: false },
  // alibaba
  { modelId: 'qwen-flash', displayName: 'Qwen Flash', intelligenceRank: 18, speedRank: 1, sizeLabel: 'Medium', contextWindow: 1000000, supportsVision: false },
  { modelId: 'qwen3.5-plus', displayName: 'Qwen3.5 Plus', intelligenceRank: 8, speedRank: 5, sizeLabel: 'Large', contextWindow: 1000000, supportsVision: true },
  { modelId: 'qwen3.7-max', displayName: 'Qwen3.7 Max', intelligenceRank: 6, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: false },
  { modelId: 'qwen3.8-max', displayName: 'Qwen3.8 Max', intelligenceRank: 5, speedRank: 8, sizeLabel: 'Frontier', contextWindow: 1000000, supportsVision: true },
  { modelId: 'qwen3-coder-plus', displayName: 'Qwen3 Coder Plus', intelligenceRank: 9, speedRank: 5, sizeLabel: 'Large', contextWindow: 1048576, supportsVision: false },
  { modelId: 'qwen3-vl-plus', displayName: 'Qwen3 VL Plus', intelligenceRank: 13, speedRank: 5, sizeLabel: 'Large', contextWindow: 262144, supportsVision: true },
  // moonshotai
  { modelId: 'kimi-k3', displayName: 'Kimi K3', intelligenceRank: 3, speedRank: 6, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  { modelId: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', intelligenceRank: 7, speedRank: 6, sizeLabel: 'Large', contextWindow: 262144, supportsVision: true },
  // minimax
  { modelId: 'minimax-m3', displayName: 'MiniMax M3', intelligenceRank: 7, speedRank: 6, sizeLabel: 'Frontier', contextWindow: 1048576, supportsVision: true },
  { modelId: 'minimax-m2.7', displayName: 'MiniMax M2.7', intelligenceRank: 14, speedRank: 6, sizeLabel: 'Large', contextWindow: 204800, supportsVision: false },
  // mistral
  { modelId: 'mistral-large-2512', displayName: 'Mistral Large (2512)', intelligenceRank: 11, speedRank: 6, sizeLabel: 'Large', contextWindow: 262144, supportsVision: true },
  { modelId: 'codestral-2508', displayName: 'Codestral (2508)', intelligenceRank: 16, speedRank: 4, sizeLabel: 'Medium', contextWindow: 256000, supportsVision: false },
  // byteplus
  { modelId: 'seed-2-0-pro-260328', displayName: 'Seed 2.0 Pro', intelligenceRank: 9, speedRank: 7, sizeLabel: 'Large', contextWindow: 256000, supportsVision: true },
];

export function up(db: Db): void {
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, supports_vision, supports_tools
    ) VALUES ('puter', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1, ?, ?)
  `);

  // Scoped to this platform on purpose. The baseline backfill is unscoped
  // because it seeds the whole catalog; an incremental migration that swept up
  // every orphan would also hand a fallback row to a user's custom model that
  // was deliberately left out of the chain, changing routing as a side effect.
  const findMissingFallbacks = db.prepare(`
    SELECT m.id
      FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
     WHERE m.platform = 'puter' AND f.id IS NULL
     ORDER BY m.intelligence_rank ASC
  `);

  const apply = db.transaction(() => {
    for (const model of PUTER_MODELS) {
      insertModel.run(
        model.modelId,
        model.displayName,
        model.intelligenceRank,
        model.speedRank,
        model.sizeLabel,
        MONTHLY_BUDGET,
        model.contextWindow,
        model.supportsVision ? 1 : 0,
        model.supportsTools === false ? 0 : 1,
      );
    }

    const missing = findMissingFallbacks.all() as { id: number }[];
    if (missing.length === 0) return;
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    const addFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (let i = 0; i < missing.length; i++) addFallback.run(missing[i].id, maxPriority + i + 1);
  });
  apply();

  // Re-arm the roster. down() disables these rows instead of deleting them, so
  // the reverse leg has to put `enabled` back; without this a down/up cycle
  // would leave the whole platform switched off.
  db.prepare(`UPDATE models SET enabled = 1 WHERE platform = 'puter'`).run();

  // The profile-chain backfill (20260714) runs BEFORE this migration, so on a
  // fresh install the seeded puter models never enter a profile chain. On a
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
 * Disable rather than DELETE.
 *
 * `models.id` is AUTOINCREMENT and `fallback_config.model_db_id` references it,
 * so deleting and re-inserting renumbers every row: the up/down/up round-trip
 * test (db/migrate/roundtrip.test.ts) compares the two snapshots row by row and
 * would see brand-new ids. Disabling reverts the platform to unusable while
 * keeping the rows, their fallback priorities and any quota history addressable,
 * and up() flips them back on. The rows are created by this migration, so there
 * is no pre-existing user state to preserve.
 */
export function down(db: Db): void {
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'puter'`).run();
}
