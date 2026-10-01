import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { PuterProvider } from '../../providers/puter.js';
import { getProvider, hasProvider } from '../../providers/index.js';
import { inferPoolForPlatform, isSharedPool } from '../../services/provider-quota.js';
import { up as puterModelsUp } from '../../db/migrations/20260928_000001_puter_models.js';
import { PLATFORMS as KEY_PLATFORMS } from '../../routes/keys.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { getDb, initDb } from '../../db/index.js';

// Puter is not an OpenAI-compatible endpoint. Free accounts get 402 on
// /puterai/openai/v1/*; the metered free allowance is only reachable through
// the ai-chat driver (POST /drivers/call, body-carried auth_token). These tests
// pin the whole adapter contract from the design doc:
// docs/superpowers/specs/2026-09-28-puter-provider-design.md

const ORIGIN = 'https://api.puter.com';
const TOKEN = 'puter-secret-token-abc123';
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const TOOL = {
  type: 'function' as const,
  function: { name: 'get_city', parameters: { type: 'object', properties: {} } },
};

interface Captured {
  url: string;
  init: RequestInit;
  body: any;
}

/** Mock one upstream response and capture the outgoing request. */
function mockFetch(response: Response | Record<string, unknown>): Captured {
  const captured: Captured = { url: '', init: null as any, body: null };
  vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
    captured.url = String(url);
    captured.init = init as RequestInit;
    // GET /whoami carries no body — only the driver calls are JSON.
    const body = (init as RequestInit | undefined)?.body;
    captured.body = typeof body === 'string' ? JSON.parse(body) : null;
    return response as Response;
  });
  return captured;
}

/** A non-streaming upstream payload with the fields the adapter reads. */
function jsonResponse(json: unknown, status = 200, headers: Record<string, string> = {}): Record<string, unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

/** A streaming NDJSON upstream response. */
function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PuterProvider', () => {
  it('identifies itself as the puter platform', () => {
    const provider = new PuterProvider();
    expect(provider.platform).toBe('puter');
    expect(provider.name).toBe('Puter');
    expect(provider.keyless).toBe(false);
  });

  // §9.1 — request shape
  describe('driver request shape', () => {
    it('POSTs /drivers/call with the Puter content type and body-carried auth', async () => {
      const captured = mockFetch(jsonResponse({
        success: true,
        result: { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      }));

      await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano', {
        temperature: 0.2,
        max_tokens: 64,
        tools: [TOOL],
      });

      expect(captured.url).toBe(`${ORIGIN}/drivers/call`);
      expect(captured.init.method).toBe('POST');
      expect((captured.init.headers as Record<string, string>)['Content-Type']).toBe('text/plain;actually=json');
      expect(captured.body.interface).toBe('puter-chat-completion');
      expect(captured.body.driver).toBe('ai-chat');
      expect(captured.body.method).toBe('complete');
      expect(captured.body.test_mode).toBe(false);
      expect(captured.body.auth_token).toBe(TOKEN);
      expect(captured.body.args.model).toBe('gpt-5-nano');
      expect(captured.body.args.messages).toEqual(MESSAGES);
      expect(captured.body.args.normalize).toBe(true);
      expect(captured.body.args.temperature).toBe(0.2);
      expect(captured.body.args.max_tokens).toBe(64);
      expect(captured.body.args.tools).toEqual([TOOL]);
      expect(captured.body.args.stream).toBe(false);
    });

    it('never sends tool_choice or parallel_tool_calls (the SDK does not pass them)', async () => {
      const captured = mockFetch(jsonResponse({
        success: true,
        result: { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      }));

      await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano', {
        tools: [TOOL],
        tool_choice: 'required',
        parallel_tool_calls: true,
      });

      expect(captured.body.args.tool_choice).toBeUndefined();
      expect(captured.body.args.parallel_tool_calls).toBeUndefined();
    });

    // Live 2026-09-30, gpt-6-luna: Puter's upstreams 400 "Function tools with
    // reasoning_effort are not supported … set reasoning_effort to 'none'".
    // When the client omits the knob the driver-side default IS a non-none
    // effort, so reasoning models 400 on every tools request without the
    // client ever sending one. Pinning 'none' when tools are in play is the
    // upstream's own remedy and the driver accepts the field (§10.4 probe).
    it('pins reasoning_effort to none when tools are present', async () => {
      const captured = mockFetch(jsonResponse({
        success: true,
        result: { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      }));

      await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-6-luna', { tools: [TOOL] });

      expect(captured.body.args.tools).toEqual([TOOL]);
      expect(captured.body.args.reasoning_effort).toBe('none');
    });

    it('leaves reasoning_effort unset without tools (the driver default preserves reasoning)', async () => {
      const captured = mockFetch(jsonResponse({
        success: true,
        result: { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      }));

      await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-6-luna');

      expect(captured.body.args.reasoning_effort).toBeUndefined();
    });

    it('sends stream:true on the streaming path', async () => {
      const captured = mockFetch(ndjsonResponse([{ type: 'text', text: 'hi' }]));
      await collect(new PuterProvider().streamChatCompletion(TOKEN, MESSAGES, 'gpt-5-nano'));
      expect(captured.body.args.stream).toBe(true);
    });
  });

  // §9.2 — the token must never surface
  describe('auth token containment', () => {
    it('keeps the token out of error messages', async () => {
      mockFetch(jsonResponse({ error: 'Model not found: nope', message: 'Model not found: nope', code: 'bad_request' }, 400));
      const err = await new PuterProvider()
        .chatCompletion(TOKEN, MESSAGES, 'nope')
        .catch((e: Error) => e);
      expect(err.message).not.toContain(TOKEN);
    });

    it('keeps the token out of console output on failure', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch(jsonResponse({ error: 'boom', code: 'bad_request' }, 500));

      await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano').catch(() => {});

      const logged = [...error.mock.calls, ...warn.mock.calls].flat().map(String).join(' ');
      expect(logged).not.toContain(TOKEN);
    });
  });

  // §9.3 — non-streaming normalization
  describe('non-streaming normalization', () => {
    it('fills the OpenAI envelope and normalizes OpenAI-style usage', async () => {
      mockFetch(jsonResponse({
        success: true,
        result: {
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
          // total_tokens deliberately wrong: the adapter recomputes it.
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 999 },
        },
      }));

      const res = await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano');

      expect(res.object).toBe('chat.completion');
      expect(res.id).toMatch(/^chatcmpl-/);
      expect(res.created).toBeGreaterThan(0);
      expect(res.model).toBe('gpt-5-nano');
      expect(res.choices[0].index).toBe(0);
      expect(res.choices[0].message.content).toBe('hello');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
      expect(res._routed_via).toEqual({ platform: 'puter', model: 'gpt-5-nano' });
    });

    it('normalizes Anthropic-style usage (input_tokens/output_tokens)', async () => {
      mockFetch(jsonResponse({
        success: true,
        result: {
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'end_turn',
          usage: { input_tokens: 9, output_tokens: 3 },
        },
      }));

      const res = await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'claude-sonnet-4-6');
      expect(res.usage).toEqual({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
    });

    it('maps non-OpenAI finish_reason to stop', async () => {
      mockFetch(jsonResponse({
        success: true,
        result: {
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'end_turn',
          usage: {},
        },
      }));

      const mapped = await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'claude-sonnet-4-6');
      expect(mapped.choices[0].finish_reason).toBe('stop');

      mockFetch(jsonResponse({
        success: true,
        result: {
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'length',
          usage: {},
        },
      }));

      const passthrough = await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano');
      expect(passthrough.choices[0].finish_reason).toBe('length');
    });

    it('passes tool_calls through', async () => {
      const toolCalls = [{
        id: 'toolu_1',
        type: 'function',
        function: { name: 'get_city', arguments: '{"city":"Paris"}' },
      }];
      mockFetch(jsonResponse({
        success: true,
        result: { message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls', usage: {} },
      }));

      const res = await new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'claude-sonnet-4-6');
      expect(res.choices[0].message.tool_calls).toEqual(toolCalls);
      expect(res.choices[0].finish_reason).toBe('tool_calls');
    });

    it('treats an explicit success:false as an upstream error', async () => {
      mockFetch(jsonResponse({ success: false, error: 'All AI providers failed' }, 200));
      await expect(
        new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano'),
      ).rejects.toThrow('All AI providers failed');
    });
  });

  // §9.4 — streaming NDJSON → chunk sequence
  describe('streaming conversion', () => {
    it('maps text/reasoning/tool_use/usage lines and synthesizes the finish frame', async () => {
      mockFetch(ndjsonResponse([
        { type: 'text', text: 'Hel' },
        { type: 'reasoning', reasoning: 'thinking' },
        { type: 'text', text: 'lo' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_city', input: { city: 'Paris' }, text: '' },
        { type: 'usage', usage: { prompt_tokens: 4, completion_tokens: 6 } },
      ]));

      const chunks = await collect(new PuterProvider().streamChatCompletion(TOKEN, MESSAGES, 'claude-sonnet-4-6'));

      const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
      expect(text).toBe('Hello');
      expect(chunks.map(c => c.choices[0].delta.reasoning_content).filter(Boolean)).toEqual(['thinking']);

      const toolCall = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? [])[0];
      expect(toolCall.id).toBe('toolu_1');
      expect(toolCall.type).toBe('function');
      expect(toolCall.function.name).toBe('get_city');
      expect(toolCall.function.arguments).toBe('{"city":"Paris"}');

      const finish = chunks.at(-1);
      expect(finish.choices[0].finish_reason).toBe('tool_calls');
      expect(finish.usage).toEqual({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });

      for (const chunk of chunks) {
        expect(chunk.object).toBe('chat.completion.chunk');
        expect(chunk.model).toBe('claude-sonnet-4-6');
      }
    });

    it('increments tool_call index across streamed tool_use events', async () => {
      mockFetch(ndjsonResponse([
        { type: 'tool_use', id: 'toolu_1', name: 'get_city', input: { city: 'Paris' } },
        { type: 'tool_use', id: 'toolu_2', name: 'get_country', input: { country: 'France' } },
      ]));

      const chunks = await collect(new PuterProvider().streamChatCompletion(TOKEN, MESSAGES, 'claude-sonnet-4-6'));

      const toolCalls = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].index).toBe(0);
      expect(toolCalls[1].index).toBe(1);
    });

    it('reports finish_reason stop for a text-only stream', async () => {
      mockFetch(ndjsonResponse([
        { type: 'text', text: 'ok' },
        { type: 'usage', usage: { input_tokens: 2, output_tokens: 1 } },
      ]));

      const chunks = await collect(new PuterProvider().streamChatCompletion(TOKEN, MESSAGES, 'gpt-5-nano'));
      const finish = chunks.at(-1);
      expect(finish.choices[0].finish_reason).toBe('stop');
      expect(finish.usage).toEqual({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
    });

    it('ignores unknown line types', async () => {
      mockFetch(ndjsonResponse([
        { type: 'text', text: 'a' },
        { type: 'something_new', value: 1 },
        { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]));

      const chunks = await collect(new PuterProvider().streamChatCompletion(TOKEN, MESSAGES, 'gpt-5-nano'));
      expect(chunks.map(c => c.choices[0].delta.content ?? '').join('')).toBe('a');
    });

    it('throws on an in-stream error line', async () => {
      mockFetch(ndjsonResponse([
        { type: 'text', text: 'partial' },
        { type: 'error', message: 'upstream exploded' },
      ]));

      await expect(
        collect(new PuterProvider().streamChatCompletion(TOKEN, MESSAGES, 'gpt-5-nano')),
      ).rejects.toThrow('upstream exploded');
    });
  });

  // §9.5 — error mapping
  describe('error mapping', () => {
    it('maps 401 token_auth_failed to an invalid-key error carrying the status', async () => {
      mockFetch(jsonResponse(
        { error: 'Authentication failed', message: 'Authentication failed', code: 'token_auth_failed' },
        401,
      ));

      const err = await new PuterProvider()
        .chatCompletion('bad-token', MESSAGES, 'gpt-5-nano')
        .catch((e: any) => e);
      expect(err.status).toBe(401);
      expect(err.message).toContain('Authentication failed');
    });

    it('preserves status 402 so the router can fail over or cool down', async () => {
      mockFetch(jsonResponse(
        { error: 'insufficient_funds', message: 'Insufficient funds', code: 'insufficient_funds' },
        402,
      ));

      const err = await new PuterProvider()
        .chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano')
        .catch((e: any) => e);
      expect(err.status).toBe(402);
      expect(err.message).toContain('Insufficient funds');
    });

    it('surfaces the upstream message for a 400 bad_request', async () => {
      mockFetch(jsonResponse(
        { error: 'Model not found: nope', message: 'Model not found: nope', code: 'bad_request' },
        400,
      ));

      await expect(
        new PuterProvider().chatCompletion(TOKEN, MESSAGES, 'nope'),
      ).rejects.toThrow('Model not found: nope');
    });

    it('maps a 200 success-false envelope to a 502 upstream error', async () => {
      mockFetch(jsonResponse({ success: false, error: 'insufficient_funds', message: 'Insufficient funds' }));

      const err = await new PuterProvider()
        .chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano')
        .catch((e: any) => e);
      expect(err.status).toBe(502);
      expect(err.message).toContain('Insufficient funds');
    });

    it('honours a Retry-After header on 429', async () => {
      mockFetch(jsonResponse(
        { error: 'rate limited', code: 'rate_limited' },
        429,
        { 'retry-after': '7' },
      ));

      const err = await new PuterProvider()
        .chatCompletion(TOKEN, MESSAGES, 'gpt-5-nano')
        .catch((e: any) => e);
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(7000);
    });
  });

  // §9.6 — validateKey probes /whoami (free, no AI quota burned)
  describe('validateKey', () => {
    it('probes /whoami with a bearer header and accepts a 200', async () => {
      const captured = mockFetch(jsonResponse({ username: 'alice', uuid: 'u1' }));
      const result = await new PuterProvider().validateKey(TOKEN);

      expect(result).toBe(true);
      expect(captured.url).toBe(`${ORIGIN}/whoami`);
      expect(captured.init.method).toBe('GET');
      expect((captured.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('reports the upstream message on a 401', async () => {
      mockFetch(jsonResponse(
        { error: 'Authentication failed', message: 'Authentication failed', code: 'token_auth_failed' },
        401,
      ));

      const result = await new PuterProvider().validateKey('bad');
      expect(result).toMatchObject({ valid: false });
      expect((result as { error: string }).error).toContain('Authentication failed');
    });

    it('propagates transport errors so health marks the key as erroring, not invalid', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(new PuterProvider().validateKey(TOKEN)).rejects.toThrow('ECONNREFUSED');
    });
  });

  // §9.8 — the platform is wired into every allowlist that gates traffic
  describe('platform registration', () => {
    it('is registered as a provider', () => {
      expect(hasProvider('puter')).toBe(true);
      expect(getProvider('puter')?.platform).toBe('puter');
    });

    it('is accepted by the keys API platform allowlist', () => {
      expect(KEY_PLATFORMS).toContain('puter');
    });
  });
});

// §9.9 — one account is one free allowance, shared across every model
describe('puter quota pool', () => {
  it('pools every model of the platform into one account pool', () => {
    expect(inferPoolForPlatform('puter', 'gpt-5-nano')).toBe('puter::account');
    expect(inferPoolForPlatform('puter', 'claude-sonnet-4-6')).toBe('puter::account');
    expect(inferPoolForPlatform('puter')).toBe('puter::account');
  });

  it('is registered as a shared pool', () => {
    expect(isSharedPool('puter')).toBe(true);
  });
});

// §9.7 — the bundled roster migration is idempotent
describe('20260928_000001_puter_models migration', () => {
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        intelligence_rank INTEGER NOT NULL DEFAULT 10,
        speed_rank INTEGER NOT NULL DEFAULT 5,
        size_label TEXT NOT NULL DEFAULT 'Medium',
        rpm_limit INTEGER,
        rpd_limit INTEGER,
        tpm_limit INTEGER,
        tpd_limit INTEGER,
        monthly_token_budget TEXT,
        context_window INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        supports_vision INTEGER NOT NULL DEFAULT 0,
        supports_tools INTEGER NOT NULL DEFAULT 0,
        UNIQUE(platform, model_id)
      );
      CREATE TABLE fallback_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_db_id INTEGER NOT NULL,
          priority INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        -- The baseline schema has this table, and the migration's up() clears
        -- puter rows out of it; without it the DELETE has nothing to target.
        CREATE TABLE profile_models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL,
          model_db_id INTEGER NOT NULL,
          priority INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          UNIQUE(profile_id, model_db_id)
        );
    `);
    return db;
  }

  function count(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'puter'").get() as { n: number }).n;
  }

  it('seeds the smoke-tested roster and backfills fallback entries', () => {
    const db = makeDb();
    dbs.push(db);

    puterModelsUp(db);

    expect(count(db)).toBeGreaterThan(0);
    const orphaned = (db.prepare(`
      SELECT COUNT(*) AS n FROM models m
       LEFT JOIN fallback_config f ON f.model_db_id = m.id
       WHERE m.platform = 'puter' AND f.id IS NULL
    `).get() as { n: number }).n;
    expect(orphaned).toBe(0);
  });

  it('is idempotent — a second up() adds no duplicate rows', () => {
    const db = makeDb();
    dbs.push(db);

    puterModelsUp(db);
    const once = count(db);
    puterModelsUp(db);

    expect(count(db)).toBe(once);
  });

  it('excludes the model that failed the §8.3 smoke gate', () => {
    const db = makeDb();
    dbs.push(db);
    puterModelsUp(db);

    const row = db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'puter' AND model_id = 'gpt-5-pro'").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('leaves tool-hostile families unflagged (gemma emits tool calls as text)', () => {
    const db = makeDb();
    dbs.push(db);
    puterModelsUp(db);

    // Pinned by routes/proxy-tools-routing.test.ts: the gemma line must NOT ride
    // the gemini tool rule, or requireTools traffic routes to a model that
    // answers tool calls with prose.
    const flagged = (db.prepare(`
      SELECT COUNT(*) AS n FROM models
       WHERE platform = 'puter' AND model_id LIKE 'gemma-%' AND supports_tools = 1
    `).get() as { n: number }).n;
    expect(flagged).toBe(0);
  });
});

// §9.10 / §8.5 — the hosted catalog never lists puter, so sync must exempt it
describe('catalog-sync exemption for locally seeded platforms', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function catalogRow(over: Record<string, unknown>): Record<string, unknown> {
    return {
      platform: 'groq',
      modelId: 'x',
      displayName: 'X',
      intelligenceRank: 10,
      speedRank: 5,
      sizeLabel: 'Medium',
      limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
      monthlyTokenBudget: '~1M',
      contextWindow: 8192,
      enabled: true,
      supportsVision: false,
      supportsTools: true,
      ...over,
    };
  }

  it('keeps puter rows and their fallback entries when the catalog omits them', () => {
    const rows = getDb()
      .prepare(
        `SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
                enabled, supports_vision, supports_tools
           FROM models WHERE source = 'catalog' AND platform != 'puter'`,
      )
      .all() as Array<Record<string, unknown>>;

    const target = getDb()
      .prepare("SELECT id, model_id FROM models WHERE platform = 'puter' ORDER BY id LIMIT 1")
      .get() as { id: number; model_id: string };

    applyCatalog(getDb(), {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live',
      models: rows.map(r => catalogRow({
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        intelligenceRank: r.intelligence_rank,
        speedRank: r.speed_rank,
        sizeLabel: r.size_label,
        limits: { rpm: r.rpm_limit, rpd: r.rpd_limit, tpm: r.tpm_limit, tpd: r.tpd_limit },
        monthlyTokenBudget: r.monthly_token_budget,
        contextWindow: r.context_window,
        enabled: r.enabled === 1,
        supportsVision: r.supports_vision === 1,
        supportsTools: r.supports_tools === 1,
      })),
      quirks: [],
    } as any);

    const survived = getDb()
      .prepare("SELECT COUNT(*) AS n FROM models WHERE id = ?")
      .get(target.id) as { n: number };
    expect(survived.n).toBe(1);

    const fallback = getDb()
      .prepare('SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?')
      .get(target.id) as { n: number };
    expect(fallback.n).toBe(1);
  });
});
