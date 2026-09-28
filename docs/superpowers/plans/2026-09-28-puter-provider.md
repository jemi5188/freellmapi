# Puter Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `puter` as a built-in platform that calls Puter's free `ai-chat` driver (`POST /drivers/call`, body-carried `auth_token`) with per-key proxies, so each Puter account's metered free allowance is consumed independently.

**Architecture:** A dedicated `PuterProvider extends BaseProvider` translates OpenAI chat requests to Puter's driver protocol and back (NDJSON streams → `chat.completion.chunk`), reusing `fetchWithTimeout` so the existing per-key proxy plumbing works unchanged. The quota is account-wide (`puter::account` shared pool), the 39-model roster ships as a versioned migration exempt from hosted-catalog cleanup, and the client gets a per-key proxy input plus a platform entry.

**Tech Stack:** TypeScript (Node 20+, ESM, `.js` import suffixes), better-sqlite3, Vitest, React 19 + TanStack Query + i18next (60-locale gate).

**Spec:** `docs/superpowers/specs/2026-09-28-puter-provider-design.md`

---

## Current state (already done, uncommitted — the TDD Red phase)

The previous session completed the Red phase. Verify, then commit as Task 1:

- `shared/types.ts` — `'puter'` added to the `Platform` union (with the quota-facts comment).
- `server/src/routes/keys.ts` — `PLATFORMS` is now `export const` and includes `'puter'`.
- `server/src/__tests__/providers/puter.test.ts` — the full failing suite (new file, untracked).
- The §8.3 smoke gate **already ran** against the live API: `gpt-5-pro` failed and is excluded from the roster (the test `excludes the model that failed the §8.3 smoke gate` pins this). Do not re-add it.

`server/src/providers/puter.ts` and the migration do **not** exist yet — the test file cannot even load, which is the expected Red state.

Verification commands (run from repo root `freellmapi-src/`):

```bash
npx vitest run server/src/__tests__/providers/puter.test.ts   # Red: fails to resolve modules
npx tsc --noEmit                                              # must stay green for the REST of the repo
npm run check:i18n                                            # 60-locale key gate
```

---

### Task 1: Commit the Red phase

**Files:**
- Commit: `shared/types.ts`, `server/src/routes/keys.ts`, `server/src/__tests__/providers/puter.test.ts`

- [ ] **Step 1: Verify the Red state is real**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts`
Expected: FAIL — `Cannot resolve ... providers/puter.js` (module-not-found, i.e. missing functionality, not a syntax error).

Run: `npx tsc --noEmit`
Expected: PASS (the test file is excluded from `tsc --noEmit` via the test tsconfig, or vitest-only; either way the repo must stay green).

- [ ] **Step 2: Commit**

```bash
git add shared/types.ts server/src/routes/keys.ts server/src/__tests__/providers/puter.test.ts
git commit -m "test(puter): pin the driver-protocol adapter contract (red)"
```

---

### Task 2: `PuterProvider` adapter + registration

**Files:**
- Create: `server/src/providers/puter.ts`
- Modify: `server/src/providers/index.ts` (import near the other provider imports at the top; `register(...)` after the AIHorde block, before the `custom` placeholder)

- [ ] **Step 1: Write `server/src/providers/puter.ts`**

```typescript
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import {
  BaseProvider,
  providerHttpError,
  type CompletionOptions,
  type KeyValidationResult,
  type ProviderHttpError,
} from './base.js';
import { extendedBodyParams, resolveMaxTokens } from '../lib/sampling-params.js';
import { streamStallTimeoutMs } from '../lib/provider-timeout.js';

// Puter is NOT an OpenAI-compatible endpoint. The /puterai/openai/v1/* routes
// require a paid subscription and answer 402 to free accounts; the metered
// free allowance is only reachable through the ai-chat driver, whose quirks
// are pinned by the spec and by __tests__/providers/puter.test.ts:
//   - auth rides the BODY as `auth_token` (no Authorization header on chat)
//   - Content-Type is `text/plain;actually=json`, verbatim
//   - `normalize: true` is required or non-OpenAI upstreams return native shapes
//   - NDJSON stream has no finish_reason line — the adapter synthesizes it
// See docs/superpowers/specs/2026-09-28-puter-provider-design.md.

const DRIVER_CONTENT_TYPE = 'text/plain;actually=json';
const IFACE = 'puter-chat-completion';
const DRIVER = 'ai-chat';
const METHOD = 'complete';

// Puter fans a finish_reason out of 17 upstream providers; anything outside
// the OpenAI enum (Claude's `end_turn`) means the same thing as `stop`.
const OPENAI_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);

interface PuterErrorBody {
  error?: string;
  message?: string;
  code?: string;
  success?: boolean;
}

interface PuterUsage {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
}

interface PuterCompleteResult {
  id?: string;
  created?: number;
  message?: {
    role?: string;
    content?: unknown;
    tool_calls?: ChatCompletionResponse['choices'][0]['message']['tool_calls'];
  };
  finish_reason?: string;
  usage?: PuterUsage;
}

interface PuterStreamEvent {
  type?: string;
  text?: string;
  reasoning?: string;
  id?: string;
  name?: string;
  input?: unknown;
  usage?: PuterUsage;
  message?: string;
}

export class PuterProvider extends BaseProvider {
  readonly platform: Platform = 'puter';
  readonly name = 'Puter';

  // PUTER_API_ORIGIN exists for self-host proxies and test injection; it is
  // not part of the operator surface (not in .env.example — see spec §11.3).
  private readonly baseUrl = process.env.PUTER_API_ORIGIN ?? 'https://api.puter.com';
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    super();
    // Puter fans out to 17 upstream providers; slow models queue well past the
    // historical 15s default. 120s, env-overridable via PROVIDER_TIMEOUT_PUTER.
    this.timeoutMs = opts.timeoutMs ?? providerTimeoutMs('puter', 120_000);
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions = {},
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/drivers/call`,
      {
        method: 'POST',
        headers: { 'Content-Type': DRIVER_CONTENT_TYPE },
        body: JSON.stringify(this.buildDriverBody(apiKey, this.buildArgs(messages, modelId, options, false))),
      },
      this.timeoutMs,
      { signal: options.signal, timeoutBounds: 'request' },
    );
    if (!res.ok) throw await this.upstreamError(res);

    const payload = await res.json() as { success?: boolean; result?: PuterCompleteResult } & PuterErrorBody;
    if (payload.success === false) {
      // HTTP 200 with success:false — Puter's driver-level failure envelope.
      throw providerHttpError(res, `${this.name}: ${payload.error ?? payload.message ?? 'upstream error'}`, payload);
    }

    const result = payload.result ?? {};
    const finishReason = OPENAI_FINISH_REASONS.has(result.finish_reason ?? '')
      ? (result.finish_reason as NonNullable<ChatCompletionResponse['choices'][0]['finish_reason']>)
      : 'stop';
    const message: ChatCompletionResponse['choices'][0]['message'] = {
      role: 'assistant',
      content: (result.message?.content ?? null) as ChatCompletionResponse['choices'][0]['message']['content'],
    };
    if (result.message?.tool_calls?.length) message.tool_calls = result.message.tool_calls;

    return {
      id: result.id ?? this.makeId(),
      object: 'chat.completion',
      created: result.created ?? Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: this.normalizeUsage(result.usage),
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions = {},
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/drivers/call`,
      {
        method: 'POST',
        headers: { 'Content-Type': DRIVER_CONTENT_TYPE },
        body: JSON.stringify(this.buildDriverBody(apiKey, this.buildArgs(messages, modelId, options, true))),
      },
      this.timeoutMs,
      { signal: options.signal, timeoutBounds: 'headers' },
    );
    if (!res.ok) throw await this.upstreamError(res);

    // readSseStream only recognizes `data:`-prefixed frames; Puter streams
    // bare NDJSON lines, so parse them here with the same stall semantics
    // (same precedent: GoogleProvider).
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${this.name}: empty stream body`);

    const stallMs = streamStallTimeoutMs(this.platform);
    const firstByteMs = this.firstByteBudgetMs(this.timeoutMs, stallMs);
    const decoder = new TextDecoder();
    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let buffer = '';
    let usage: ChatCompletionChunk['usage'];
    let sawToolCall = false;
    let toolIndex = 0;
    let firstRead = true;

    const frame = (delta: ChatCompletionChunk['choices'][0]['delta'], finish: ChatCompletionChunk['choices'][0]['finish_reason']): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    try {
      while (true) {
        const { done, value } = await this.readWithStallTimeout(
          () => reader.read(),
          firstRead ? firstByteMs : stallMs,
          firstRead ? this.firstByteTimeoutMessage(firstByteMs) : undefined,
        );
        firstRead = false;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt: PuterStreamEvent;
          try {
            evt = JSON.parse(trimmed) as PuterStreamEvent;
          } catch {
            continue; // skip malformed lines, matching readSseStream
          }
          switch (evt.type) {
            case 'text':
              if (evt.text) yield frame({ content: evt.text }, null);
              break;
            case 'reasoning':
              if (evt.reasoning) yield frame({ reasoning_content: evt.reasoning }, null);
              break;
            case 'tool_use':
              sawToolCall = true;
              yield frame({
                tool_calls: [{
                  index: toolIndex++,
                  id: evt.id,
                  type: 'function',
                  function: { name: evt.name, arguments: JSON.stringify(evt.input ?? {}) },
                }],
              }, null);
              break;
            case 'usage':
              usage = this.normalizeUsage(evt.usage);
              break;
            case 'error':
              throw new Error(`${this.name}: ${evt.message ?? 'stream error'}`);
            default:
              break; // unknown line types are ignored (spec §5.2)
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    // The usage line is always the last line of the stream (spec §3), so the
    // synthetic finish frame can carry it. readSseStream would call a stream
    // without a finish_reason "truncated" — synthesizing avoids that false
    // positive on every healthy stream (spec §5.2).
    const final = frame({}, sawToolCall ? 'tool_calls' : 'stop');
    if (usage) final.usage = usage;
    yield final;
  }

  /** GET /whoami with the bearer header: answers 200/401 without consuming
   *  AI quota (health probes every ~5 min per key — a chat probe would burn
   *  the free allowance; `test_mode` does NOT skip real completions, spec §3). */
  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/whoami`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      this.timeoutMs,
    );
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) {
      let body: PuterErrorBody = {};
      try {
        body = await res.json() as PuterErrorBody;
      } catch {
        // status + provider name still make a useful reason
      }
      return {
        valid: false,
        error: `${this.name} key validation failed (HTTP ${res.status}): ${body.message ?? body.error ?? 'unauthorized'}`,
      };
    }
    throw providerHttpError(res, `${this.name} key validation failed (HTTP ${res.status})`);
  }

  /** The driver envelope: auth_token rides the body, never a header, and
   *  must never reach a log or an error message. */
  private buildDriverBody(authToken: string, args: Record<string, unknown>): Record<string, unknown> {
    return {
      interface: IFACE,
      driver: DRIVER,
      method: METHOD,
      // A real completion either way (test_mode still bills the allowance,
      // spec §3) — pinned explicitly so a future default flip is a diff.
      test_mode: false,
      args,
      auth_token: authToken,
    };
  }

  /** OpenAI-shaped args for the driver call. `modelId` (the routed id) is the
   *  wire `model` — not `options.model`. tool_choice and
   *  parallel_tool_calls are deliberately NOT forwarded — Puter's SDK does
   *  not pass them (spec §5.1) — and the extended sampling knobs are all
   *  dropped by the `puter` policy in lib/sampling-params.ts, so
   *  extendedBodyParams contributes nothing today but stays wired for the
   *  day Puter forwards a knob. JSON.stringify drops `undefined` values, so
   *  absent knobs never reach the wire. */
  private buildArgs(messages: ChatMessage[], modelId: string, options: CompletionOptions, stream: boolean): Record<string, unknown> {
    const maxTokens = resolveMaxTokens(this.platform, options.max_tokens, options.contextBudget);
    return {
      model: modelId,
      messages,
      temperature: options.temperature,
      top_p: options.top_p,
      stop: options.stop,
      max_tokens: maxTokens,
      tools: options.tools?.length ? options.tools : undefined,
      stream,
      normalize: true,
      ...extendedBodyParams(this.platform, options),
    };
  }

  private normalizeUsage(usage: PuterUsage | undefined): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    // Upstreams disagree on field names (gpt/gemini: prompt_/completion_,
    // Claude: input_/output_); recompute total instead of trusting it.
    const prompt = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const completion = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }

  private async upstreamError(res: Response): Promise<ProviderHttpError> {
    let body: PuterErrorBody = {};
    try {
      body = await res.json() as PuterErrorBody;
    } catch {
      // non-JSON (HTML challenge page, empty body) — status still tells the story
    }
    const detail = body.message ?? body.error ?? res.statusText ?? 'request failed';
    return providerHttpError(res, `${this.name} chat failed (HTTP ${res.status}): ${detail}`, body);
  }
}
```

- [ ] **Step 2: Register in `server/src/providers/index.ts`**

Add to the imports (alphabetical block near the top):

```typescript
import { PuterProvider } from './puter.js';
```

Add after the AIHorde `register(new AIHordeProvider());` block (line ~554), before the `custom` placeholder:

```typescript
// Puter — the ai-chat driver (POST /drivers/call, body-carried auth_token).
// The OpenAI-compatible /puterai endpoint needs a paid subscription and 402s
// free accounts; the driver route consumes each account's metered free
// allowance, which is shared across ALL models of the account (pooled as
// `puter::account`, see services/provider-quota.ts). 120s: Puter fans out to
// 17 upstream providers and slow models queue (spec §4.2).
register(new PuterProvider());
```

(`new PuterProvider()` uses the 120s default; no explicit timeout needed.)

- [ ] **Step 3: Verify the adapter tests**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts`
Expected: FAIL — `Cannot resolve ... 20260928_000001_puter_models.js` (the migration import still blocks the file; that is Task 3). Do not "fix" by stubbing the migration.

Run: `npx tsc --noEmit`
Expected: PASS — the new file must type-check.

- [ ] **Step 4: Commit**

```bash
git add server/src/providers/puter.ts server/src/providers/index.ts
git commit -m "feat(puter): PuterProvider speaking the ai-chat driver protocol"
```

---

### Task 3: Model roster migration + registry wiring

**Files:**
- Create: `server/src/db/migrations/20260928_000001_puter_models.ts`
- Modify: `server/src/db/migrate/defaults.ts` (import, filename constant, DEFAULT_MIGRATIONS entry)
- Modify: `server/src/__tests__/db/migrate/roundtrip.test.ts` (filename constant + expected-names array)

- [ ] **Step 1: Write the migration**

`backfillFallback` in `20260101_000000_legacy_baseline.ts` is module-private, so this migration carries its own copy (same SQL, same semantics).

```typescript
import type { Db } from '../types.js';

// V-puter (2026-09-28): the Puter roster — 39 model rows, INSERT OR IGNORE +
// fallback backfill, safe to re-run.
//
// Sourcing (spec §8): ids/limits taken from the live directory
// (GET /puterai/chat/models/details, 2026-09-28), filtered to tool_call=true,
// text-capable models across the 17 upstream providers. Puter publishes no
// numeric free quota — the allowance is usage-metered, resets monthly, and is
// shared across every model of the account (pooled as `puter::account`) — so
// rpm/rpd/tpm/tpd stay null and the budget label claims no number.
//
// Smoke gate (spec §8.3): every id below answered a minimal live completion
// (max_tokens floor, single "OK" turn) on 2026-09-28, EXCEPT `gpt-5-pro`
// (azure-openai), which failed the probe and is deliberately absent — the
// provider test pins its exclusion. Recorded here so a future re-probe knows
// why the row is missing.
//
// Rows are platform-local: PUTER models must never leak into other platforms'
// fallback chains; this migration only ever inserts platform='puter'.

const PUTER_MODELS: Array<[string, string, number, number, string, number, number, number, number]> = [
  // 39 tuples — the authoritative list is in the "Populate PUTER_MODELS" block
  // immediately below; copy it verbatim (gpt-5-pro excluded per the smoke gate).
];

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'free · metered', ?, ?, ?, ?)
  `);

  const apply = db.transaction(() => {
    for (const m of PUTER_MODELS) insert.run('puter', ...m);
    backfillFallback(db);
  });
  apply();
}

export function down(db: Db): void {
  const apply = db.transaction(() => {
    db.prepare(`DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'puter')`).run();
    db.prepare(`DELETE FROM models WHERE platform = 'puter'`).run();
  });
  apply();
}

/** Local copy of the legacy-baseline backfill (it is module-private there):
 *  append any model row that has no fallback entry yet, lowest priority,
 *  ordered by intelligence_rank. */
function backfillFallback(db: Db) {
  const missing = db.prepare(`
    SELECT m.id FROM models m
    LEFT JOIN fallback_config f ON m.id = f.model_db_id
    WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
  `).all() as { id: number }[];
  if (missing.length > 0) {
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
    const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
  }
}
```

**Populate `PUTER_MODELS`** with exactly these 39 tuples `(model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, supports_vision, supports_tools, enabled)` — `gpt-5-pro` excluded per the smoke gate. Ranks are ordering judgment (lower = smarter/faster), consistent with the V17–V24 bands in the legacy baseline:

```typescript
const PUTER_MODELS: Array<[string, string, number, number, string, number, number, number, number]> = [
  ['gpt-5.4',                      'GPT-5.4 (Puter)',                     1, 8, 'Frontier', 1050000, 1, 1, 1],
  ['gpt-6-luna',                   'GPT-6 Luna (Puter)',                  2, 7, 'Frontier', 1050000, 1, 1, 1],
  ['claude-opus-5-5',              'Claude Opus 5.5 (Puter)',             3, 9, 'Frontier', 1000000, 1, 1, 1],
  ['claude-fable-5-1',             'Claude Fable 5.1 (Puter)',            4, 9, 'Frontier', 1000000, 1, 1, 1],
  ['gemini-3.8-flash',             'Gemini 3.8 Flash (Puter)',            5, 4, 'Frontier', 1048576, 1, 1, 1],
  ['grok-4.6',                     'Grok 4.6 (Puter)',                    6, 7, 'Frontier',  500000, 1, 1, 1],
  ['claude-opus-4-8',              'Claude Opus 4.8 (Puter)',             7, 9, 'Frontier', 1000000, 1, 1, 1],
  ['minimax-m3',                   'MiniMax M3 (Puter)',                  8, 6, 'Frontier', 1048576, 1, 1, 1],
  ['kimi-k3',                      'Kimi K3 (Puter)',                     9, 6, 'Frontier', 1048576, 1, 1, 1],
  ['glm-5.3',                      'GLM-5.3 (Puter)',                    10, 6, 'Frontier', 1000000, 0, 1, 1],
  ['claude-sonnet-4-6',            'Claude Sonnet 4.6 (Puter)',          11, 5, 'Frontier', 1000000, 1, 1, 1],
  ['gemini-3.5-flash',             'Gemini 3.5 Flash (Puter)',           12, 2, 'Frontier', 1048576, 1, 1, 1],
  ['gemini-3.1-pro-preview',       'Gemini 3.1 Pro Preview (Puter)',     13, 8, 'Large',    1048576, 1, 1, 1],
  ['grok-4.5',                     'Grok 4.5 (Puter)',                   14, 7, 'Frontier',  500000, 1, 1, 1],
  ['qwen3.8-max',                  'Qwen3.8 Max (Puter)',                15, 7, 'Large',    1000000, 1, 1, 1],
  ['deepseek-v4-pro',              'DeepSeek V4 Pro (Puter)',            16, 7, 'Frontier', 1000000, 0, 1, 1],
  ['gpt-5-2025-08-07',             'GPT-5 2025-08-07 (Puter)',           17, 6, 'Large',     128000, 1, 1, 1],
  ['claude-sonnet-4-5-20250929',   'Claude Sonnet 4.5 (Puter)',          18, 5, 'Large',     200000, 1, 1, 1],
  ['minimax-m2.7',                 'MiniMax M2.7 (Puter)',               19, 7, 'Large',      204800, 0, 1, 1],
  ['kimi-k2.7-code',               'Kimi K2.7 Code (Puter)',             20, 5, 'Large',     262144, 1, 1, 1],
  ['qwen3.7-max',                  'Qwen3.7 Max (Puter)',                21, 8, 'Large',    1000000, 0, 1, 1],
  ['glm-5.3-flash',                'GLM-5.3 Flash (Puter)',              22, 2, 'Large',    1000000, 0, 1, 1],
  ['claude-haiku-4-5-20251001',    'Claude Haiku 4.5 (Puter)',           23, 3, 'Medium',    200000, 1, 1, 1],
  ['qwen3.5-plus',                 'Qwen3.5 Plus (Puter)',               24, 4, 'Large',    1000000, 1, 1, 1],
  ['gpt-5-mini',                   'GPT-5 Mini (Puter)',                 25, 3, 'Medium',    128000, 1, 1, 1],
  ['deepseek-v4-flash',            'DeepSeek V4 Flash (Puter)',          26, 3, 'Large',    1000000, 0, 1, 1],
  ['mistral-large-2512',           'Mistral Large 2512 (Puter)',         27, 5, 'Large',     262144, 1, 1, 1],
  ['gemini-2.5-flash',             'Gemini 2.5 Flash (Puter)',           28, 3, 'Large',    1048576, 1, 1, 1],
  ['qwen3-coder-plus',             'Qwen3 Coder Plus (Puter)',           29, 5, 'Large',    1048576, 0, 1, 1],
  ['glm-4.7',                      'GLM-4.7 (Puter)',                    30, 5, 'Medium',    200000, 0, 1, 1],
  ['seed-2-0-pro-260328',          'Seed 2.0 Pro (Puter)',               31, 5, 'Large',     256000, 1, 1, 1],
  ['gpt-4.1-mini',                 'GPT-4.1 Mini (Puter)',               32, 4, 'Medium',   1047576, 1, 1, 1],
  ['gemini-2.5-flash-lite',        'Gemini 2.5 Flash Lite (Puter)',      33, 1, 'Medium',   1048576, 1, 1, 1],
  ['qwen3-vl-plus',                'Qwen3 VL Plus (Puter)',              34, 5, 'Medium',    262144, 1, 1, 1],
  ['gpt-5-nano',                   'GPT-5 Nano (Puter)',                 35, 2, 'Small',     128000, 1, 1, 1],
  ['codestral-2508',               'Codestral 2508 (Puter)',             36, 4, 'Large',     256000, 0, 1, 1],
  ['gpt-4o-mini',                  'GPT-4o Mini (Puter)',                37, 4, 'Small',     128000, 1, 1, 1],
  ['qwen-flash',                   'Qwen Flash (Puter)',                 38, 1, 'Medium',   1000000, 0, 1, 1],
  ['gemma-4-31b-it',               'Gemma 4 31B IT (Puter)',             39, 4, 'Large',     262144, 1, 1, 1],
];
```

(All 39 rows: `supports_tools = 1`, `enabled = 1`; `supports_vision` per the spec §8.2 table. `rpm/rpd/tpm/tpd` are `NULL` via the statement SQL.)

- [ ] **Step 2: Register in `server/src/db/migrate/defaults.ts`**

Add the import after the last one (line ~39):

```typescript
import * as puterModels from '../migrations/20260928_000001_puter_models.js';
```

Add the filename constant after `QUOTA_SNAPSHOT_FRESHNESS_FILENAME` (line ~88):

```typescript
export const PUTER_MODELS_FILENAME = '20260928_000001_puter_models.ts';
```

Append the entry at the END of `DEFAULT_MIGRATIONS` (after the `QUOTA_SNAPSHOT_FRESHNESS_FILENAME` entry):

```typescript
  { filename: PUTER_MODELS_FILENAME, module: puterModels },
```

`20260928_000001` sorts after `20260915_000001`, so `registry-drift.test.ts`'s ordering assertion stays satisfied.

- [ ] **Step 3: Update `server/src/__tests__/db/migrate/roundtrip.test.ts`**

Add after `const QUOTA_SNAPSHOT_FRESHNESS_FILENAME = ...` (line ~44):

```typescript
const PUTER_MODELS_FILENAME = '20260928_000001_puter_models.ts';
```

Add `PUTER_MODELS_FILENAME,` as the last element of the `expect(getAppliedMigrationNames(db)).toEqual([...])` array (after `QUOTA_SNAPSHOT_FRESHNESS_FILENAME,`, line ~132).

- [ ] **Step 4: Verify migration + registry tests**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts server/src/__tests__/db/migrate/registry-drift.test.ts server/src/__tests__/db/migrate/roundtrip.test.ts`
Expected: registry + roundtrip + the two migration `describe` blocks PASS. The `puter quota pool` and `catalog-sync exemption` blocks still FAIL (Tasks 4 and 5). All `PuterProvider` and `error mapping` blocks PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/migrations/20260928_000001_puter_models.ts server/src/db/migrate/defaults.ts server/src/__tests__/db/migrate/roundtrip.test.ts
git commit -m "feat(puter): seed the smoke-tested 39-model roster as a versioned migration"
```

---

### Task 4: Account-wide quota pool

**Files:**
- Modify: `server/src/services/provider-quota.ts:112-178` (`inferPoolForPlatform`) and `:180-185` (`isSharedPool`)

- [ ] **Step 1: Add the pool branch in `inferPoolForPlatform`**

Inside `inferPoolForPlatform`, with the other explicit branches (after the `modelscope` line, before the `return normalizedModelId ? ...` default):

```typescript
  // One Puter account = one metered free allowance, shared across every model
  // it serves. The default per-model split would let a 402 on one model leave
  // the same drained account routable on every other model (spec §6.1).
  if (platform === 'puter') return 'puter::account';
```

- [ ] **Step 2: Register the shared pool in `isSharedPool`**

Append `'puter'` to the platform array in the final `return [...].includes(platform)` line (line ~184), keeping alphabetical-ish placement at the end:

```typescript
  return ['openrouter', 'google', 'groq', 'cerebras', 'sail', 'bai', 'radeon', 'sambanova', 'nvidia', 'mistral', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty', 'navy', 'nara', 'sealion', 'orcarouter', 'unorouter', 'xkiro', 'anyapi', 'modelscope', 'aihorde', 'puter'].includes(platform);
```

- [ ] **Step 3: Verify**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts -t "puter quota pool"`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/provider-quota.ts
git commit -m "feat(puter): pool the platform's quota per account, not per model"
```

---

### Task 5: Catalog-sync cleanup exemption

**Files:**
- Modify: `server/src/services/catalog-sync.ts` (file-level constant near the top; one guard line in the cleanup loop at ~line 574)

- [ ] **Step 1: Add the constant**

Near the top of the file (after imports), with a comment explaining the trap it prevents:

```typescript
// Platforms whose model rows are seeded by a local versioned migration instead
// of the hosted catalog. The hosted catalog will never list them, so the
// cleanup loop below must skip them or every 12-hourly sync would delete the
// rows AND their fallback_config entries — a silent outage that only shows up
// after the first sync cycle (spec §8.5).
const LOCALLY_SEEDED_PLATFORMS = new Set<Platform>(['puter']);
```

(`Platform` is already imported in this file — the cleanup loop already casts to it.)

- [ ] **Step 2: Guard the cleanup loop**

In the model-cleanup loop (after `if (!hasProvider(c.platform as Platform)) continue;`, line ~575), add:

```typescript
      if (LOCALLY_SEEDED_PLATFORMS.has(c.platform as Platform)) continue;
```

Do NOT touch the embedding cleanup loop — Puter seeds no embedding rows.

- [ ] **Step 3: Verify the full provider suite**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts`
Expected: PASS — all blocks, including `catalog-sync exemption for locally seeded platforms`.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/catalog-sync.ts
git commit -m "fix(catalog-sync): exempt locally seeded platforms from catalog cleanup"
```

---

### Task 6: Sampling-param policy

**Files:**
- Modify: `server/src/lib/sampling-params.ts` (`PLATFORM_PARAM_POLICIES`, after the `reka` entry, line ~320)

- [ ] **Step 1: Add the policy**

```typescript
  // Puter's driver forwards only its own PARAMS_TO_PASS allowlist; none of the
  // extended knobs (and per the official SDK, not even tool_choice) survive.
  // Drop the whole extended set rather than risk a 400 from a strict upstream
  // behind the driver (spec §4.1).
  puter: { drop: [...EXTENDED_SAMPLING_KEYS] },
```

This also keeps `response_format` out of Puter's advertised `supported_parameters`, so structured-output routing skips the platform.

- [ ] **Step 2: Verify nothing regressed**

Run: `npx vitest run server/src/__tests__/providers`
Expected: PASS — every provider test file.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/sampling-params.ts
git commit -m "feat(puter): drop extended sampling params behind the driver allowlist"
```

---

### Task 7: Client — platform entry, color, shared proxy validator

**Files:**
- Modify: `client/src/components/keys/shared.tsx` (PLATFORMS array, line ~28; new exported helper)
- Modify: `client/src/lib/routing.ts:401-453` (`platformColors`)

- [ ] **Step 1: Add the platform entry to `PLATFORMS` in `shared.tsx`**

Append after the last entry of the array (before the closing `];`):

```tsx
  // Puter's token is an un-prefixed random string, so the .env importer cannot
  // auto-detect the platform — add keys from this dropdown, one account per
  // key, each with its own proxy if the accounts should egress separately.
  { value: 'puter', label: 'Puter (metered free allowance; token from puter.com)', url: 'https://puter.com/settings' },
```

- [ ] **Step 2: Add the client-side proxy validator to `shared.tsx`**

Below the `PLATFORMS` export:

```tsx
// Mirrors server/src/lib/key-proxy.ts `isValidKeyProxyUrl` so an invalid value
// is caught client-side instead of as a 400 after submit (spec §7).
export function isValidClientProxyUrl(value: string): boolean {
  return /^(?:https?|socks4a?|socks5h?):\/\/\S+$/i.test(value.trim());
}
```

- [ ] **Step 3: Add the platform color in `routing.ts`**

Inside `platformColors` (before the closing brace, after `xfyun`):

```typescript
  puter:       '#f43f5e',
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run check:i18n`
Expected: PASS (no locale keys were added).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/keys/shared.tsx client/src/lib/routing.ts
git commit -m "feat(puter): list the platform on the Keys page with a shared proxy validator"
```

---

### Task 8: Client — proxy input in the add-key form

**Files:**
- Modify: `client/src/components/keys/add-key-form.tsx`

The per-key proxy is a generic backend capability (`api_keys.proxy_url`, POST /api/keys already accepts `proxyUrl`); this input surfaces it for every platform, Puter included. It applies to the single-key path only (the paste-several importer has no proxy column).

- [ ] **Step 1: Add state and validation**

In `AddKeyForm`, after `const [several, setSeveral] = useState(false)` (line ~48):

```tsx
  // Optional per-key egress proxy (spec §7): one Puter account behind one
  // fixed proxy → one exit IP → one allowance consumed independently.
  const [proxyUrl, setProxyUrl] = useState('')
```

In the validation block (after `accountIdError`, line ~155):

```tsx
  const proxyUrlError = proxyUrl.trim() && !isValidClientProxyUrl(proxyUrl)
    ? 'http://, https://, socks4(a):// or socks5(h):// URL required'
    : null
```

Extend the submit guard (line ~160):

```tsx
    if (platformError || keyError || accountIdError || proxyUrlError) {
```

Import the helper (extend the existing `./shared` import, line ~15):

```tsx
import { GetKeyLink, PLATFORMS, isValidClientProxyUrl } from './shared'
```

- [ ] **Step 2: Send `proxyUrl` on the single-key path**

Change the `addKey` `mutationFn` body type (line ~105):

```tsx
    mutationFn: (body: { platform: string; key: string; label?: string; proxyUrl?: string }) =>
```

In `handleSubmit`, replace the final mutate call (line ~173):

```tsx
    addKey.mutate({ platform, key, label: label || undefined, proxyUrl: proxyUrl.trim() || undefined })
```

- [ ] **Step 3: Add the input**

Between the key-field `<div>` (ends line ~265) and the label `<div>` (line ~266):

```tsx
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.proxyUrl')}</Label>
          <Input
            value={proxyUrl}
            onChange={e => setProxyUrl(e.target.value)}
            placeholder="socks5://127.0.0.1:1080"
            className="w-[200px] font-mono text-xs"
            aria-invalid={addAttempted && !!proxyUrlError}
          />
          {addAttempted && <FieldError error={proxyUrlError} />}
        </div>
```

(`keys.proxyUrl` already exists in all 60 locales — `en.json:456` "Proxy URL"; the placeholder is a literal, matching the precedent in `proxy-settings-section.tsx`. The error string is a literal too: adding a new i18n key would require syncing 60 files for one message, which the spec explicitly avoids.)

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run check:i18n`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/keys/add-key-form.tsx
git commit -m "feat(keys): optional per-key proxy input on the add-key form"
```

---

### Task 9: Client — proxy editing in the edit-key dialog

> **DEVIATION (accepted by user, 2026-09-28):** The implemented behavior model is the
> opposite of the plan below and was explicitly approved: the input starts with the
> masked proxy value, submits only when changed, and an emptied field sends
> `proxyUrl: ''` to CLEAR the stored proxy (backend PATCH already treats `''` as
> clear). This is strictly more capable than the plan's "empty = no change" model
> (clearing does not require re-saving the key). The steps below are kept for
> history but superseded by the implementation.

**Files:**
- Modify: `client/src/components/keys/edit-key-dialog.tsx`

- [ ] **Step 1: Add state, body field, and validation**

Extend the `UpdateBody` type (line ~14):

```tsx
type UpdateBody = {
  label?: string
  key?: string
  proxyUrl?: string
}
```

Add state after `const [attempted, setAttempted] = useState(false)` (line ~34). The input starts EMPTY and shows the stored (masked) proxy as a placeholder — the API never sends the plaintext proxy back, so an untouched field must never submit the masked string as a new value:

```tsx
  const [proxyUrl, setProxyUrl] = useState('')
```

Add validation after `credentialError` (line ~48):

```tsx
  const proxyUrlError = proxyUrl.trim() && !isValidClientProxyUrl(proxyUrl)
    ? 'http://, https://, socks4(a):// or socks5(h):// URL required'
    : null
```

Extend `hasChanges` (line ~49):

```tsx
  const hasChanges = label !== apiKey.label || Boolean(credential) || Boolean(proxyUrl.trim())
```

Extend the import (line ~12):

```tsx
import { PLATFORMS, isValidClientProxyUrl } from './shared'
```

- [ ] **Step 2: Submit and guard**

In `submit` (line ~60), extend the guard and body:

```tsx
    if (credentialError || proxyUrlError) {
```

```tsx
    if (proxyUrl.trim()) body.proxyUrl = proxyUrl.trim()
```

(Note: clearing an existing proxy is not offered here — empty means "no change". Operators who need to clear can re-save the key. Backend semantics: `proxyUrl: ''` = no override, but the dialog never sends it.)

- [ ] **Step 3: Add the UI block**

After the credential section's closing `</div>` (line ~146), before the `updateKey.isError` block:

```tsx
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="edit-key-proxy">{t('keys.proxyUrl')}</Label>
              {apiKey.maskedProxyUrl && (
                <code className="font-mono text-[11px] text-muted-foreground">{apiKey.maskedProxyUrl}</code>
              )}
            </div>
            <Input
              id="edit-key-proxy"
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
              placeholder={apiKey.maskedProxyUrl || 'socks5://127.0.0.1:1080'}
              className="font-mono text-xs"
              aria-invalid={attempted && Boolean(proxyUrlError)}
            />
            {attempted && proxyUrlError && <FieldError error={proxyUrlError} />}
            <p className="text-[11px] text-muted-foreground">
              Leave empty to keep the stored proxy; type a new URL to replace it.
            </p>
          </div>
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run check:i18n`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/keys/edit-key-dialog.tsx
git commit -m "feat(keys): per-key proxy editing in the edit-key dialog"
```

---

### Task 10: Docs — platform tables

**Files:**
- Modify: `docs/en/providers/01-supported-platforms.md`
- Modify: `docs/zh-cn/providers/01-supported-platforms.md`

- [ ] **Step 1: Append a row to the EN table** (match the existing column layout — see the `modelscope` row at line 55):

```markdown
| `puter` | Puter | Keyed | Native (`PuterProvider`) | Metered free allowance per account, resets monthly, shared across every model of the account (pooled as `puter::account`). Calls the `ai-chat` driver (`POST /drivers/call`, token in the body) — the OpenAI-compatible `/puterai/openai/v1` endpoint requires a paid subscription and 402s free accounts. The token is an un-prefixed string: pick Puter explicitly in the dropdown (the `.env` importer cannot auto-detect it). Per-key proxy supported so each account can egress from its own IP. |
```

- [ ] **Step 2: Append the matching row to the ZH-CN table** (translate, same columns):

```markdown
| `puter` | Puter | 需密钥 | 原生（`PuterProvider`） | 按账号计量的免费额度，按月重置，账号下所有模型共享（配额池 `puter::account`）。走 `ai-chat` 驱动（`POST /drivers/call`，token 放在请求体）——OpenAI 兼容端点 `/puterai/openai/v1` 需要付费订阅，免费账号返回 402。token 是无前缀随机串：导入 `.env` 无法自动识别平台，需在下拉中手动选择 Puter。支持按密钥配置代理，让不同账号走不同出口 IP。 |
```

- [ ] **Step 3: Commit**

```bash
git add docs/en/providers/01-supported-platforms.md docs/zh-cn/providers/01-supported-platforms.md
git commit -m "docs(providers): document the Puter platform"
```

---

### Task 11: Full verification (verification-before-completion)

- [ ] **Step 1: Entire test suite**

Run: `npm test`
Expected: PASS — zero failures, including `roundtrip`, `registry-drift`, `idempotency` (every enabled platform must have a registered provider — puter now is), `keys-proxy`, and the provider suite.

- [ ] **Step 2: Types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: i18n gate**

Run: `npm run check:i18n`
Expected: PASS.

- [ ] **Step 4: Manual smoke (requires a live token)**

Start the server locally, add a Puter key (optionally with a proxy) in the Keys page, then from Trae or curl via `http://localhost:3001/v1/chat/completions`:

1. Non-streaming `gpt-5-nano` ("say OK") → 200, sane usage.
2. Streaming `claude-sonnet-4-6` → chunks arrive, stream ends cleanly (no truncation error).
3. Keys page: the new key's health turns green within one probe cycle (~5 min) — confirms `/whoami` validation.
4. Two Puter keys with different proxies → each consumes its own allowance (watch `provider_quota_state` pool key `puter::account` per `key_id`).

If (2) shows a truncation error, the usage line is NOT last — return to spec §5.2 and adjust before shipping.

- [ ] **Step 5: Final commit if verification required fixes**

```bash
git add -A
git commit -m "fix(puter): address issues found during end-to-end verification"
```

---

### Task 12: Cleanup (spec §12)

- [ ] **Step 1: Remove temporary credentials and probe scripts**

Delete `.puter-token` and `.probe/` from the working copy root (they are gitignored/untracked — verify `git status --short` shows nothing related before deleting). Do NOT delete them before Task 11's manual smoke if it still needs a live token.

- [ ] **Step 2: Confirm nothing sensitive was committed**

Run: `git log --oneline main..HEAD` and skim each diff — `auth_token` must appear only as a variable name, never a literal.

---

## Self-review notes (already applied)

- **Spec coverage:** §2 goals → Tasks 2/3/7/8/9; §4.1 file table → Tasks 2–10 (i18n locales deliberately untouched per §4.1); §4.2 adapter → Task 2; §5 data flow → Task 2; §6 errors → Task 2 (`providerHttpError` carries status + Retry-After); §6.1 pool → Task 4; §7 proxy → Tasks 7–9; §8 catalog/migration → Tasks 3+5; §9 tests → the pre-written suite + per-task verification steps; §11 docs/deploy → Task 10 (deployment is the repo's normal rebuild; no code).
- **Type consistency:** `PuterProvider` constructor is optionless-compatible (`new PuterProvider()` in index.ts and tests); migration exports `up(db)/down(db)` matching `MigrationModule`; `up` is called with a raw better-sqlite3 handle by the provider test — same handle type `Db` accepts. `buildArgs(messages, modelId, options, stream)` signatures match both call sites; the wire `model` is the routed `modelId`, never `options.model`.
