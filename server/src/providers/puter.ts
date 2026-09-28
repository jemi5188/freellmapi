import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  Platform,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult, type ProviderHttpError } from './base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';
import { providerTimeoutMs, streamStallTimeoutMs } from '../lib/provider-timeout.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';

/**
 * Puter — metered free allowance reached through the `ai-chat` DRIVER, not the
 * OpenAI-compatible endpoint (issue tracked by
 * docs/superpowers/specs/2026-09-28-puter-provider-design.md).
 *
 * Why a dedicated adapter instead of an OpenAICompatProvider:
 *
 *  - `POST /puterai/openai/v1/*` (and the Anthropic one) additionally require a
 *    PAID subscription: a free account gets a flat 402. The metered free
 *    allowance — which `puter.ai.chat()` uses — only exists behind
 *    `POST /drivers/call`, so the whole wire format differs:
 *    `Content-Type: text/plain;actually=json` plus a body carrying the auth
 *    token, NOT an `Authorization` header.
 *  - The driver envelope is `{success, result}` nested one level deeper than
 *    OpenAI's, and `success:false` can arrive on a 200.
 *  - Upstream usage is inconsistent (OpenAI-style or Anthropic-style) and
 *    `total_tokens` cannot be trusted, so it is recomputed here.
 *  - Streaming is NDJSON with its own event vocabulary (`text` / `reasoning` /
 *    `tool_use` / `usage` / `error`) and no finish_reason line, so the terminal
 *    frame has to be synthesized or every healthy stream reads as truncated.
 *
 * Credential model: the account auth token, stored per key with an optional
 * per-key proxy — one account per key, each egressing from its own IP. The
 * token never leaves the request body and is never logged.
 */

// Overridable for a self-hosted relay or a test double; the driver protocol is
// origin-relative.
const API_ORIGIN = process.env.PUTER_API_ORIGIN ?? 'https://api.puter.com';
// Load-bearing: the driver's parser keys off this exact string, and
// `application/json` is rejected. Copied verbatim from @heyputer/puter.js.
const DRIVER_CONTENT_TYPE = 'text/plain;actually=json';
const IFACE = 'puter-chat-completion';
const DRIVER = 'ai-chat';
const METHOD = 'complete';
// Puter fans a finish_reason out of 17 upstream providers; anything outside
// the OpenAI enum (Claude's `end_turn`) means the same thing as `stop`.
const OPENAI_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
// Puter fans out to 17 upstream providers, some slow to prefill, and queues —
// the project-wide 15s default false-flags them. PROVIDER_TIMEOUT_PUTER
// overrides (#547).
const PUTER_TIMEOUT_MS = providerTimeoutMs('puter', 120000);

/** The driver's stream event vocabulary. Everything else is ignored so a new
 *  event type upstream cannot break the adapter. */
type DriverStreamEvent = {
  type?: string;
  text?: unknown;
  reasoning?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  message?: unknown;
  usage?: unknown;
};

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Parse a JSON object, or undefined when the text is not one. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class PuterProvider extends BaseProvider {
  readonly platform: Platform = 'puter';
  readonly name = 'Puter';
  private readonly timeoutMs: number;

  constructor(opts?: { timeoutMs?: number }) {
    super();
    this.timeoutMs = opts?.timeoutMs ?? PUTER_TIMEOUT_MS;
  }

  /** Assemble the driver call body. `auth_token` travels here and only here —
   *  the driver rejects/ignores an Authorization header, and keeping it out of
   *  headers keeps it out of every header-level log line. */
  private buildDriverBody(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {
      messages,
      model: modelId,
      // Without normalize the driver returns each upstream's native shape
      // (Claude replies with Anthropic's content[]/stop_reason), which is not
      // the OpenAI contract this gateway speaks.
      normalize: true,
      stream,
    };
    if (options?.temperature != null) args.temperature = options.temperature;
    const maxTokens = resolveMaxTokens(this.platform, options?.max_tokens, options?.contextBudget);
    if (maxTokens != null) args.max_tokens = maxTokens;
    if (options?.tools?.length) args.tools = options.tools;
    // Deliberately absent: tool_choice / parallel_tool_calls (the official SDK
    // does not pass tool_choice on) and every extended sampling knob — the
    // adapter ships only the fields above, which is what the `puter` policy's
    // all-drop list in sampling-params.ts declares. See §5.1/§10.4 of the
    // design doc: the driver itself tolerates reasoning_effort, but this
    // adapter does not forward it.
    return {
      interface: IFACE,
      driver: DRIVER,
      test_mode: false,
      method: METHOD,
      args,
      auth_token: apiKey,
    };
  }

  /** Upstream's human-readable reason, preferring `message` over `error`:
   *  Puter puts the code in `error` ("insufficient_funds") and the sentence in
   *  `message` ("Insufficient funds"). */
  private upstreamMessage(body: unknown, fallback: string): string {
    const record = (body ?? {}) as Record<string, unknown>;
    return (
      nonEmptyString(record.message)
      ?? nonEmptyString(record.error)
      ?? nonEmptyString(record.detail)
      ?? nonEmptyString(fallback)
      ?? 'unknown error'
    );
  }

  private driverHttpError(res: Response, body: unknown, statusOverride?: number): ProviderHttpError {
    // statusOverride: a `success:false` envelope arrives on HTTP 200, so the
    // status is synthesized (502) — the router's error classifier sorts by
    // status, and a 200 would read as a generic error instead of an upstream one.
    const status = statusOverride ?? res.status;
    const err = providerHttpError(res, `${this.name} API error ${status}: ${this.upstreamMessage(body, res.statusText)}`, body);
    err.status = status;
    return err;
  }

  /** Recompute the totals: upstreams report either prompt_/completion_ or
   *  input_/output_ tokens, and the `total_tokens` some of them send is wrong. */
  private normalizeUsage(usage: unknown): TokenUsage {
    const record = (usage ?? {}) as Record<string, unknown>;
    const promptTokens = numberOr(record.prompt_tokens) ?? numberOr(record.input_tokens) ?? 0;
    const completionTokens = numberOr(record.completion_tokens) ?? numberOr(record.output_tokens) ?? 0;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  /** Read the `{success, result}` envelope, mapping a non-2xx status OR an
   *  explicit `success:false` — which Puter sends with HTTP 200 when every
   *  upstream provider failed — onto a ProviderHttpError. The envelope failure
   *  surfaces as a synthesized 502 (bad gateway): the gateway reached the
   *  driver but got a failure verdict back, and the router's classifier sorts
   *  by status. */
  private async readDriverEnvelope(res: Response): Promise<Record<string, unknown>> {
    const parsed = parseJsonObject(await res.text().catch(() => ''));
    if (!res.ok) throw this.driverHttpError(res, parsed);
    if (parsed?.success === false) throw this.driverHttpError(res, parsed, 502);
    return parsed ?? {};
  }

  private quotaContextFor(quotaContext: QuotaObservationContext | undefined, modelId?: string) {
    return {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'drivers/call',
    };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${API_ORIGIN}/drivers/call`, {
      method: 'POST',
      headers: { 'Content-Type': DRIVER_CONTENT_TYPE },
      body: JSON.stringify(this.buildDriverBody(apiKey, messages, modelId, options, false)),
      // One blocking body read, so the deadline must span it.
    }, options?.timeoutMs ?? this.timeoutMs, { signal: options?.signal, timeoutBounds: 'request' });

    recordQuotaObservationsFromResponse(res, this.quotaContextFor(quotaContext, modelId));

    const result = (await this.readDriverEnvelope(res)).result as Record<string, unknown> | undefined;
    const message = (result?.message ?? { role: 'assistant', content: '' }) as ChatMessage;
    const finishReason = OPENAI_FINISH_REASONS.has(nonEmptyString(result?.finish_reason) ?? '')
      ? (nonEmptyString(result?.finish_reason) as NonNullable<ChatCompletionResponse['choices'][0]['finish_reason']>)
      : 'stop';

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason,
      }],
      usage: this.normalizeUsage(result?.usage),
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  /**
   * Parse the driver's NDJSON stream. BaseProvider.readSseStream only
   * recognises `data:` frames, so this adapter reads the body itself — same
   * trade-off as GoogleProvider — and borrows readWithStallTimeout for the
   * inactivity watchdog and the first-byte grace budget.
   *
   * The terminal frame is synthesized: Puter's stream has no finish_reason
   * line, and readSseStream's contract (mirrored by google.ts:816) is that a
   * stream ending without one is a truncated generation. Without this every
   * healthy Puter stream would be reported as a failure and the route would
   * fail over.
   */
  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${API_ORIGIN}/drivers/call`, {
      method: 'POST',
      headers: { 'Content-Type': DRIVER_CONTENT_TYPE },
      body: JSON.stringify(this.buildDriverBody(apiKey, messages, modelId, options, true)),
      // 'headers' bounds: the stream legitimately outlives the request deadline;
      // the stall watchdog and the client signal own it from here.
    }, options?.timeoutMs ?? this.timeoutMs, { signal: options?.signal });

    recordQuotaObservationsFromResponse(res, this.quotaContextFor(quotaContext, modelId));

    if (!res.ok) {
      const parsed = parseJsonObject(await res.text().catch(() => ''));
      throw this.driverHttpError(res, parsed);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let buffer = '';
    let sawToolCalls = false;
    const toolCallIndex = { value: 0 };
    let usage: TokenUsage | undefined;

    const inactivityTimeoutMs = streamStallTimeoutMs(this.platform);
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.timeoutMs, inactivityTimeoutMs);
    let awaitingFirstByte = true;

    try {
      while (true) {
        const { done, value } = awaitingFirstByte
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), inactivityTimeoutMs);
        awaitingFirstByte = false;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = parseJsonObject(trimmed) as DriverStreamEvent | undefined;
          if (!event) continue;

          if (event.type === 'error') {
            throw new Error(`${this.name} stream error: ${nonEmptyString(event.message) ?? 'upstream error'}`);
          }
          if (event.type === 'usage') {
            usage = this.normalizeUsage(event.usage);
            continue;
          }

          const delta = this.eventToDelta(event, toolCallIndex);
          if (!delta) continue;
          if (delta.tool_calls) sawToolCalls = true;

          yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{ index: 0, delta, finish_reason: null }],
          };
        }
      }
    } finally {
      // Also runs when the consumer abandons the generator mid-stream (a client
      // disconnect breaks the route pump's for-await), which is the only thing
      // that stops the upstream generation from burning quota unread.
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? 'tool_calls' : 'stop' }],
      ...(usage ? { usage } : {}),
    };
  }

  /** Map one driver stream event onto an OpenAI delta; null = ignore the event
   *  (an empty text/reasoning payload or an unknown type, so a new event type
   *  upstream cannot break the stream). `toolCallIndex` is a counter object
   *  because each streamed tool_use must carry an index that increments across
   *  events — state that has to outlive a single call. */
  private eventToDelta(
    event: DriverStreamEvent,
    toolCallIndex: { value: number },
  ): ChatCompletionChunk['choices'][number]['delta'] | null {
    if (event.type === 'text') {
      const text = typeof event.text === 'string' ? event.text : '';
      if (!text) return null;
      return { content: text };
    }
    if (event.type === 'reasoning') {
      const reasoning = typeof event.reasoning === 'string' ? event.reasoning : '';
      if (!reasoning) return null;
      return { reasoning_content: reasoning };
    }
    if (event.type === 'tool_use') {
      // `index` rides along as the OpenAI wire format expects, incrementing
      // with each tool_use event; the shared ChatToolCall type does not model
      // it (upstream OpenAI chunks carry it through untyped), hence the
      // wider local type.
      const call: ChatToolCall & { index: number } = {
        index: toolCallIndex.value++,
        id: nonEmptyString(event.id) ?? this.makeId(),
        type: 'function',
        function: {
          name: nonEmptyString(event.name) ?? '',
          arguments: JSON.stringify(event.input ?? {}),
        },
      };
      return { tool_calls: [call] };
    }
    return null;
  }

  /**
   * Probe `GET /whoami`, which validates the token WITHOUT burning AI quota —
   * health runs every ~5 minutes per key, so a chat-based probe would spend the
   * whole allowance. `test_mode:true` is not an option either: it still
   * produces a real completion.
   *
   * Only a 401/403 is an invalid key; transport errors propagate so health
   * marks the key 'error' rather than auto-disabling a key behind a network
   * blip (same contract as AIHordeProvider).
   */
  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${API_ORIGIN}/whoami`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, this.timeoutMs, { timeoutBounds: 'request' });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'whoami',
    });

    return this.validationResult(res);
  }
}
