# Puter Key Usage Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Puter key's remaining monthly allowance as a badge on its Keys-page row, refreshed automatically (60 s client cache) and manually, without ever exposing tokens to the browser.

**Architecture:** `PuterProvider.getUsage()` reads `GET /metering/usage` (free, flat payload) through the existing per-key proxy plumbing. A versioned migration adds three nullable cache columns to `api_keys`; a new `POST /api/keys/usage/refresh` route fetches every enabled Puter key in parallel via `withKeyProxy` and writes the snapshot; the Keys page renders a colored badge from the cached columns via TanStack Query.

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import suffixes), better-sqlite3, Express, Vitest, React 19 + TanStack Query, i18next (60-locale gate).

**Spec:** `docs/superpowers/specs/2026-10-01-puter-usage-badge-design.md`

---

## Verified upstream contract (probed live 2026-10-01)

`GET https://api.puter.com/metering/usage` with `Authorization: Bearer <token>`:

```json
{ "remaining": 972.055823119917, "monthUsageAllowance": 1000, "addons": {}, "unit": "credits" }
```

Flat payload (no `allowanceInfo` wrapper), does NOT consume the metered AI allowance.

## Key file facts (anchors verified 2026-10-01)

- `server/src/lib/proxy.ts:17` — `withKeyProxy<T>(proxyUrl: string | undefined, fn: () => T): T` sets the AsyncLocalStorage that `proxyFetch` reads; **without it a direct provider call bypasses the per-key proxy**.
- `server/src/lib/key-proxy.ts` — `decryptProxyUrl(row)` reads `proxy_encrypted`/`proxy_iv`/`proxy_auth_tag` off the row and returns `''` when unset.
- `server/src/routes/keys.ts:302` — `GET /` maps `SELECT * FROM api_keys`; new columns ride along automatically.
- `server/src/routes/keys.ts` — routes hang off `export const keysRouter = Router()`; auth is a gated-path middleware upstream (`isGatedApiPath` in tests).
- `server/src/providers/puter.ts:404` — `validateKey` is the last method; `getUsage` goes after it. Helpers `numberOr`/`nonEmptyString` (L70-76) and constant `API_ORIGIN` (L42) already exist.
- `server/src/__tests__/providers/puter.test.ts` — helpers `mockFetch(response)` (returns `captured {url, init, body}`), `jsonResponse(json, status?)` already exist.
- `server/src/__tests__/routes/keys-cooldowns.test.ts:10-33` — route-test scaffolding: `createApp`, `initDb(':memory:')`, `mintDashboardToken()`, `request(app, method, path, body)`, `createKey(app, platform, key)`. Copy this scaffolding into the new test file.
- `server/src/__tests__/db/migrate/roundtrip.test.ts:134` — hardcoded filename array; every new migration filename must be appended there.
- `client/src/components/keys/provider-list.tsx:569-577` — the modelScope `<Badge>` block inside the key row; the usage badge mounts right after it, before `<div className="flex-1" />` (L578).
- `client/src/i18n/locales/en.json:597` — the `keys.*` block where new keys go.

---

### Task 1: Migration — three usage cache columns

**Files:**
- Create: `server/src/db/migrations/20261001_000002_key_usage_columns.ts`
- Modify: `server/src/db/migrate/defaults.ts` (import + registry row + filename export)
- Modify: `server/src/__tests__/db/migrate/roundtrip.test.ts` (hardcoded array)
- Test: `server/src/__tests__/db/migrate/key-usage-columns.test.ts`

- [ ] **Step 1: Wire the Red state**

In `server/src/__tests__/db/migrate/roundtrip.test.ts`, next to the existing `PUTER_EXPANSION_FILENAME` constant add:

```typescript
const KEY_USAGE_FILENAME = '20261001_000002_key_usage_columns.ts';
```

and append `KEY_USAGE_FILENAME,` to the hardcoded array that already contains `PUTER_MODELS_FILENAME, PUTER_EXPANSION_FILENAME,`.

Create `server/src/__tests__/db/migrate/key-usage-columns.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify Red**

Run: `npx vitest run server/src/__tests__/db/migrate/key-usage-columns.test.ts server/src/__tests__/db/migrate/roundtrip.test.ts`
Expected: FAIL — module `20261001_000002_key_usage_columns.js` cannot be resolved; roundtrip fails with `expected 40 to equal 41`.

- [ ] **Step 3: Write the migration**

Create `server/src/db/migrations/20261001_000002_key_usage_columns.ts`:

```typescript
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
```

- [ ] **Step 4: Register the migration**

In `server/src/db/migrate/defaults.ts` add the import next to `puterExpansion`:

```typescript
import * as keyUsageColumns from '../migrations/20261001_000002_key_usage_columns.js';
```

add the filename export next to `PUTER_EXPANSION_FILENAME`:

```typescript
export const KEY_USAGE_FILENAME = '20261001_000002_key_usage_columns.ts';
```

and the registry row after the puter-expansion entry:

```typescript
  { filename: KEY_USAGE_FILENAME, module: keyUsageColumns },
```

- [ ] **Step 5: Run tests to verify Green**

Run: `npx vitest run server/src/__tests__/db/migrate/`
Expected: PASS (all migration suites including roundtrip + registry-drift).

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations/20261001_000002_key_usage_columns.ts server/src/db/migrate/defaults.ts server/src/__tests__/db/migrate/key-usage-columns.test.ts server/src/__tests__/db/migrate/roundtrip.test.ts
git commit -m "feat(keys): api_keys usage cache columns for the dashboard badge"
```

---

### Task 2: `PuterProvider.getUsage()`

**Files:**
- Modify: `server/src/providers/base.ts` (new exported `KeyUsage` interface near `KeyValidationResult`)
- Modify: `server/src/providers/puter.ts` (constant + method after `validateKey`)
- Test: `server/src/__tests__/providers/puter.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `server/src/__tests__/providers/puter.test.ts` (inside the top-level `describe('PuterProvider', ...)`):

```typescript
  // §4.1 of the usage-badge spec — metering read, flat payload, free of charge.
  describe('getUsage', () => {
    it('reads the flat metering payload', async () => {
      mockFetch(jsonResponse({ remaining: 972.05, monthUsageAllowance: 1000, addons: {}, unit: 'credits' }));
      const usage = await new PuterProvider().getUsage(TOKEN);
      expect(usage).toEqual({ remaining: 972.05, monthlyAllowance: 1000, unit: 'credits' });
    });

    it('GETs /metering/usage with only the Bearer header and no body', async () => {
      const captured = mockFetch(jsonResponse({ remaining: 1, monthUsageAllowance: 2, unit: 'credits' }));
      await new PuterProvider().getUsage(TOKEN);
      expect(captured.url).toBe(`${ORIGIN}/metering/usage`);
      expect(captured.init.method).toBe('GET');
      expect((captured.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
      expect(captured.body).toBeNull();
    });

    it('rejects with a clear error when the payload shape is unexpected', async () => {
      mockFetch(jsonResponse({ error: 'weird' }));
      await expect(new PuterProvider().getUsage(TOKEN)).rejects.toThrow(/unexpected shape/);
    });

    it('maps an upstream 401 to a thrown provider error', async () => {
      mockFetch(jsonResponse({ error: 'invalid token' }, 401));
      await expect(new PuterProvider().getUsage(TOKEN)).rejects.toThrow();
    });
  });
```

- [ ] **Step 2: Run tests to verify Red**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts`
Expected: FAIL — `getUsage is not a function` (4 failures).

- [ ] **Step 3: Add the `KeyUsage` interface to base.ts**

In `server/src/providers/base.ts`, directly after the `KeyValidationResult` interface definition, add:

```typescript
/** Snapshot of a provider account's remaining metered allowance, for the
 *  dashboard usage badge (docs/superpowers/specs/2026-10-01-puter-usage-badge-design.md).
 *  Providers without a metering read simply do not implement fetchUsage. */
export interface KeyUsage {
  remaining: number;
  monthlyAllowance: number;
  unit: string;
}
```

- [ ] **Step 4: Implement `getUsage` in puter.ts**

In `server/src/providers/puter.ts`:

Import the type — extend the existing `./base.js` import at L9:

```typescript
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyUsage, type KeyValidationResult, type ProviderHttpError } from './base.js';
```

Add the timeout constant next to `PUTER_TIMEOUT_MS` (L55):

```typescript
// The metering read is a single cheap GET; it never needs the 120s chat budget.
const USAGE_TIMEOUT_MS = 30_000;
```

Add the method after `validateKey` (end of the class, before the closing brace):

```typescript
  /**
   * Read the account's monthly allowance WITHOUT spending any of it — a
   * metering read, not an AI call; this is the same endpoint the puter.com
   * dashboard's usage tab polls (`puter.auth.getMonthlyUsage()`). The payload
   * is flat (`remaining` / `monthUsageAllowance` / `unit`), probed live
   * 2026-10-01. Rides the per-key proxy like every other upstream call.
   */
  async getUsage(apiKey: string): Promise<KeyUsage> {
    const res = await this.fetchWithTimeout(`${API_ORIGIN}/metering/usage`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, USAGE_TIMEOUT_MS, { timeoutBounds: 'request' });
    if (!res.ok) throw await this.upstreamError(res);

    const body = await res.json() as { remaining?: unknown; monthUsageAllowance?: unknown; unit?: unknown };
    const remaining = numberOr(body.remaining);
    const monthlyAllowance = numberOr(body.monthUsageAllowance);
    if (remaining === undefined || monthlyAllowance === undefined) {
      throw providerHttpError(res, `${this.name}: metering/usage returned an unexpected shape`, body);
    }
    return { remaining, monthlyAllowance, unit: nonEmptyString(body.unit) ?? 'credits' };
  }
```

- [ ] **Step 5: Run tests to verify Green**

Run: `npx vitest run server/src/__tests__/providers/puter.test.ts` and `npx tsc -p server --noEmit`
Expected: PASS (all, including the 4 new ones); tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/base.ts server/src/providers/puter.ts server/src/__tests__/providers/puter.test.ts
git commit -m "feat(puter): getUsage reads the free /metering/usage snapshot"
```

---

### Task 3: Keys routes — payload field + refresh endpoint

**Files:**
- Modify: `server/src/routes/keys.ts` (GET `/` payload + new `POST /usage/refresh`)
- Test: `server/src/__tests__/routes/keys-usage.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `server/src/__tests__/routes/keys-usage.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { resolveProvider } from '../../providers/index.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function createKey(app: Express, platform: string, key: string) {
  const { body } = await request(app, 'POST', '/api/keys', { platform, key, label: `${platform} key` });
  return body.id as number;
}

/** Fake the puter provider's getUsage for the route under test. */
function stubGetUsage(impl: (apiKey: string) => Promise<{ remaining: number; monthlyAllowance: number; unit: string }>) {
  const provider = resolveProvider('puter') as any;
  return vi.spyOn(provider, 'getUsage').mockImplementation(impl);
}

describe('Key usage refresh', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    vi.restoreAllMocks();
  });

  it('starts with usage: null and shows nothing after a refresh when no puter keys exist', async () => {
    await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    const list = await request(app, 'GET', '/api/keys');
    expect(list.status).toBe(200);
    expect(list.body[0].usage).toBeNull();

    const refresh = await request(app, 'POST', '/api/keys/usage/refresh');
    expect(refresh.status).toBe(200);
    expect(refresh.body.results).toEqual([]);
  });

  it('fetches every enabled puter key in parallel and caches the snapshot', async () => {
    const id1 = await createKey(app, 'puter', 'puter-token-one');
    const id2 = await createKey(app, 'puter', 'puter-token-two');
    const seen: string[] = [];
    stubGetUsage(async (apiKey) => {
      seen.push(apiKey);
      return apiKey === 'puter-token-one'
        ? { remaining: 972.06, monthlyAllowance: 1000, unit: 'credits' }
        : { remaining: 988.19, monthlyAllowance: 1000, unit: 'credits' };
    });

    const { status, body } = await request(app, 'POST', '/api/keys/usage/refresh');
    expect(status).toBe(200);
    expect(seen.sort()).toEqual(['puter-token-one', 'puter-token-two']);
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(r.ok).toBe(true);
      expect(typeof r.updatedAt).toBe('number');
    }

    const db = getDb();
    const row1 = db.prepare('SELECT usage_remaining, usage_allowance, usage_updated_at FROM api_keys WHERE id = ?').get(id1) as any;
    expect(row1.usage_remaining).toBeCloseTo(972.06);
    expect(row1.usage_allowance).toBe(1000);
    expect(row1.usage_updated_at).toBeGreaterThan(0);

    const list = await request(app, 'GET', '/api/keys');
    const usage1 = list.body.find((k: any) => k.id === id1).usage;
    expect(usage1).toEqual({ remaining: 972.06, allowance: 1000, unit: 'credits', updatedAt: row1.usage_updated_at });
    expect(list.body.find((k: any) => k.id === id2).usage.remaining).toBeCloseTo(988.19);
  });

  it('isolates a failing key and reports its error without touching the others', async () => {
    const id1 = await createKey(app, 'puter', 'puter-token-good');
    const id2 = await createKey(app, 'puter', 'puter-token-bad');
    stubGetUsage(async (apiKey) => {
      if (apiKey === 'puter-token-bad') throw new Error('Puter API error 401: invalid token');
      return { remaining: 500, monthlyAllowance: 1000, unit: 'credits' };
    });

    const { status, body } = await request(app, 'POST', '/api/keys/usage/refresh');
    expect(status).toBe(200);
    const byId = new Map(body.results.map((r: any) => [r.keyId, r]));
    expect(byId.get(id1).ok).toBe(true);
    expect(byId.get(id2).ok).toBe(false);
    expect(byId.get(id2).error).toMatch(/401/);

    const db = getDb();
    const bad = db.prepare('SELECT usage_updated_at FROM api_keys WHERE id = ?').get(id2) as any;
    expect(bad.usage_updated_at).toBeNull();
  });

  it('skips disabled puter keys and non-puter keys entirely', async () => {
    const enabled = await createKey(app, 'puter', 'puter-token-live');
    const disabled = await createKey(app, 'puter', 'puter-token-off');
    getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(disabled);
    await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    const spy = stubGetUsage(async () => ({ remaining: 1, monthlyAllowance: 1000, unit: 'credits' }));

    const { body } = await request(app, 'POST', '/api/keys/usage/refresh');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].keyId).toBe(enabled);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify Red**

Run: `npx vitest run server/src/__tests__/routes/keys-usage.test.ts`
Expected: FAIL — refresh returns 404 (`POST /api/keys/usage/refresh` missing) and `usage` is `undefined` rather than `null`.

- [ ] **Step 3: Implement the route and the payload field**

In `server/src/routes/keys.ts`:

Extend the L9 base.js provider import already present in the file — the file imports from `../providers/base.js` already for types; add `KeyUsage` to that import list (or add the import if absent):

```typescript
import type { KeyUsage } from '../providers/base.js';
```

In `GET /` (the map at ~L370), add after `maskedProxyUrl`:

```typescript
      // Cached metering snapshot for the dashboard badge (puter only).
      // null = never fetched — the dashboard hides the badge.
      usage:
        row.platform === 'puter' && row.usage_updated_at != null
          ? {
              remaining: row.usage_remaining,
              allowance: row.usage_allowance,
              unit: 'credits',
              updatedAt: row.usage_updated_at,
            }
          : null,
```

Add the refresh route after the `GET /` handler (before `DELETE /:id/cooldowns`), plus the needed imports at the top of the file (`withKeyProxy` from `../lib/proxy.js`, `decryptProxyUrl` is already imported):

```typescript
// Refresh the metering-usage snapshot for every enabled puter key. The read
// is free (a metering read, not an AI call) and each fetch rides that key's
// own proxy. One key failing (dead token, dead proxy) must not block the
// others, so every result lands in its own slot; a failure comes back as a
// string on that key's slot and the cached columns stay untouched.
keysRouter.post('/usage/refresh', async (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, encrypted_key, iv, auth_tag, proxy_encrypted, proxy_iv, proxy_auth_tag FROM api_keys WHERE platform = 'puter' AND enabled = 1",
  ).all() as Array<{ id: number; encrypted_key: string; iv: string; auth_tag: string; proxy_encrypted: string | null; proxy_iv: string | null; proxy_auth_tag: string | null }>;

  const provider = resolveProvider('puter');
  if (!provider || typeof provider.getUsage !== 'function') {
    res.status(503).json({ error: 'Puter provider unavailable' });
    return;
  }

  const results = await Promise.all(rows.map(async (row) => {
    try {
      const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      const usage: KeyUsage = await withKeyProxy(decryptProxyUrl(row), () => provider.getUsage(apiKey));
      const updatedAt = Date.now();
      db.prepare('UPDATE api_keys SET usage_remaining = ?, usage_allowance = ?, usage_updated_at = ? WHERE id = ?')
        .run(usage.remaining, usage.monthlyAllowance, updatedAt, row.id);
      return { keyId: row.id, ok: true as const, remaining: usage.remaining, allowance: usage.monthlyAllowance, unit: usage.unit, updatedAt };
    } catch (error) {
      return { keyId: row.id, ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  res.json({ results });
});
```

Type note: if `resolveProvider` returns the broad `BaseProvider` without `getUsage` in its type, narrow with `provider as BaseProvider & { getUsage?: (apiKey: string) => Promise<KeyUsage> }` and guard `typeof …getUsage !== 'function'` as shown — adjust the guard to the narrowed variable.

- [ ] **Step 4: Run tests to verify Green**

Run: `npx vitest run server/src/__tests__/routes/keys-usage.test.ts server/src/__tests__/routes/keys.test.ts` and `npx tsc -p server --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/keys.ts server/src/__tests__/routes/keys-usage.test.ts
git commit -m "feat(keys): POST /usage/refresh caches per-key Puter allowance"
```

---

### Task 4: Shared type + dashboard badge + i18n

**Files:**
- Modify: `shared/types.ts` (`ApiKey` interface, ~L316-338)
- Create: `client/src/components/keys/usage-badge.tsx`
- Modify: `client/src/components/keys/provider-list.tsx` (query + refresh button + badge mount)
- Modify: `client/src/i18n/locales/en.json` + all 59 other locale files
- Test: `client/src/components/keys/usage-badge.test.tsx`

- [ ] **Step 1: Extend the shared type**

In `shared/types.ts`, inside `interface ApiKey` after `maskedProxyUrl?: string;` (L335), add:

```typescript
  /** Cached metering snapshot (puter keys only); null = never fetched. */
  usage?: { remaining: number; allowance: number; unit: string; updatedAt: number } | null;
```

- [ ] **Step 2: Write the failing badge test**

Create `client/src/components/keys/usage-badge.test.tsx` (follow the render/assert style of `unified-key-section.test.tsx`; testing-library is already a devDependency):

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageBadge } from './usage-badge';

describe('UsageBadge', () => {
  it('renders remaining over allowance with the unit', () => {
    render(<UsageBadge usage={{ remaining: 972.06, allowance: 1000, unit: 'credits', updatedAt: Date.now() }} fetchFailed={false} />);
    expect(screen.getByText(/972\.1.*1000.*credits/s)).toBeTruthy();
  });

  it('turns red under 20 percent and green above 50 percent', () => {
    const { rerender } = render(
      <UsageBadge usage={{ remaining: 100, allowance: 1000, unit: 'credits', updatedAt: Date.now() }} fetchFailed={false} />,
    );
    expect(document.querySelector('[data-testid="usage-badge"]')?.className).toMatch(/red-|destructive|text-red/);

    rerender(<UsageBadge usage={{ remaining: 900, allowance: 1000, unit: 'credits', updatedAt: Date.now() }} fetchFailed={false} />);
    expect(document.querySelector('[data-testid="usage-badge"]')?.className).toMatch(/green-|emerald-/);
  });

  it('shows the warning icon when the last fetch failed', () => {
    render(<UsageBadge usage={{ remaining: 900, allowance: 1000, unit: 'credits', updatedAt: Date.now() }} fetchFailed={true} />);
    expect(screen.getByTestId('usage-fetch-warning')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run tests to verify Red**

Run: `npx vitest run client/src/components/keys/usage-badge.test.tsx`
Expected: FAIL — cannot resolve `./usage-badge`.

- [ ] **Step 4: Implement the badge component**

Create `client/src/components/keys/usage-badge.tsx`:

```tsx
import { AlertTriangle } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'
import { Tooltip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

type Usage = NonNullable<ApiKey['usage']>

const ratioTone = (ratio: number) =>
  ratio <= 0.2
    ? { text: 'text-red-600 dark:text-red-400', bar: 'bg-red-500' }
    : ratio <= 0.5
      ? { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' }
      : { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' }

/** Per-key allowance badge (puter keys only; spec §4.2). Display-only —
 *  routing behavior never changes based on it. */
export function UsageBadge({ usage, fetchFailed }: { usage: Usage; fetchFailed: boolean }) {
  const { t } = useI18n()
  const ratio = usage.allowance > 0 ? usage.remaining / usage.allowance : 0
  const tone = ratioTone(ratio)
  const remaining = usage.remaining >= 10 ? Math.round(usage.remaining) : Math.round(usage.remaining * 10) / 10
  return (
    <Tooltip
      text={
        fetchFailed
          ? t('keys.usageStale')
          : t('keys.usageUpdated', { time: new Date(usage.updatedAt).toLocaleString() })
      }
    >
      <span
        data-testid="usage-badge"
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-mono tabular-nums ${tone.text}`}
        title={t('keys.usageBadge')}
      >
        {fetchFailed && <AlertTriangle data-testid="usage-fetch-warning" className="size-3" />}
        <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
          <span className={`block h-full ${tone.bar}`} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
        </span>
        <span>
          {remaining} / {usage.allowance} {usage.unit}
        </span>
      </span>
    </Tooltip>
  )
}
```

If the project has no `@/components/ui/tooltip` with that exact API, check how `provider-list.tsx` imports Tooltip (it uses `<Tooltip text={...}>` with children at L595) and mirror that exact usage.

- [ ] **Step 5: Run tests to verify Green**

Run: `npx vitest run client/src/components/keys/usage-badge.test.tsx`
Expected: PASS.

- [ ] **Step 6: Wire it into ProviderList**

In `client/src/components/keys/provider-list.tsx`:

Add imports:

```tsx
import { RefreshCw } from 'lucide-react'   // extend the existing lucide-react import instead if one exists
import { UsageBadge } from './usage-badge'
```

Add the usage query + refresh mutation next to the existing queries (~L94):

```tsx
  // Metering snapshot for puter keys; the server fans out one free
  // /metering/usage read per enabled key through its own proxy (spec §4.1).
  const { data: usageData, refetch: refetchUsage, isFetching: usageFetching } = useQuery<{
    results: Array<{ keyId: number; ok: boolean; remaining?: number; allowance?: number; unit?: string; updatedAt?: number; error?: string }>
  }>({
    queryKey: ['keys', 'usage'],
    queryFn: () => apiFetch('/api/keys/usage/refresh', { method: 'POST' }),
    staleTime: 60_000,
  })
  const usageByKey = new Map<number, { remaining: number; allowance: number; unit: string; updatedAt: number; fetchFailed: boolean }>()
  for (const r of usageData?.results ?? []) {
    usageByKey.set(r.keyId, {
      remaining: r.remaining ?? 0,
      allowance: r.allowance ?? 0,
      unit: r.unit ?? 'credits',
      updatedAt: r.updatedAt ?? 0,
      fetchFailed: !r.ok,
    })
  }
  const refreshUsage = useMutation({
    mutationFn: () => apiFetch('/api/keys/usage/refresh', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys', 'usage'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
```

In the key row, right after the modelScope `<Badge>` block (L577) and before `<div className="flex-1" />` (L578), mount:

```tsx
                            {k.platform === 'puter' && usageByKey.get(k.id) && (
                              <UsageBadge usage={usageByKey.get(k.id)!} fetchFailed={usageByKey.get(k.id)!.fetchFailed} />
                            )}
```

And add the manual refresh button next to the "Check all" button in `KeysPage.tsx` header actions — in `client/src/pages/KeysPage.tsx`, inside the `actions` fragment after the `checkAll` button:

```tsx
            {(tab === 'providers') && keys.some(k => k.platform === 'puter') && (
              <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ['keys', 'usage'] })}>
                <RefreshCw className="size-3.5" />
                {t('keys.usageRefresh')}
              </Button>
            )}
```

with `RefreshCw` added to the L8 lucide import.

- [ ] **Step 7: Add the i18n keys to all 60 locales**

Add to the `keys` object of `client/src/i18n/locales/en.json` (near `modelScopeBadgeOther`, ~L598):

```json
    "usageBadge": "Remaining monthly allowance",
    "usageRefresh": "Refresh usage",
    "usageUpdated": "Updated {time}",
    "usageStale": "Last update failed — showing the last known values",
```

Then propagate the same four keys to the other 59 locale files so `check:i18n` stays green — non-English locales take the English text as a placeholder for now. One-shot helper (run from repo root, deletes nothing):

```bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'client/src/i18n/locales';
const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
const additions = {
  usageBadge: 'Remaining monthly allowance',
  usageRefresh: 'Refresh usage',
  usageUpdated: 'Updated {time}',
  usageStale: 'Last update failed — showing the last known values',
};
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.json') || file === 'en.json') continue;
  const full = path.join(dir, file);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!json.keys) continue;
  for (const [k, v] of Object.entries(additions)) {
    if (json.keys[k] === undefined) json.keys[k] = v;
  }
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
}
console.log('done');
"
```

Then verify en.json was not reformatted unexpectedly (the script rewrites all locale files with 2-space indent — confirm `git diff` shows only the four added lines per file; if the JSON formatting differs, restore and add the four keys by hand per file instead).

- [ ] **Step 8: Verify the i18n gate and client typecheck**

Run: `npx tsc -b client` and `npm run check:i18n -w client`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add shared/types.ts client/src/components/keys/usage-badge.tsx client/src/components/keys/usage-badge.test.tsx client/src/components/keys/provider-list.tsx client/src/pages/KeysPage.tsx client/src/i18n/locales
git commit -m "feat(keys): show per-key Puter allowance badge on the Keys page"
```

---

### Task 5: Full verification

- [ ] **Step 1: Server typecheck + client build + unit tests**

Run from repo root:
```bash
npx tsc -p server --noEmit
npx tsc -b client
npx vitest run server/src/__tests__/db/migrate/ server/src/__tests__/providers/puter.test.ts server/src/__tests__/routes/keys-usage.test.ts
npm run check:i18n -w client
```
Expected: all exit 0 / PASS.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: no NEW failures vs the known pre-existing baseline (4 pre-existing non-puter failures were observed on 2026-10-01; anything beyond those must be investigated).

- [ ] **Step 3: Commit any leftover stragglers**

`git status` must be clean before proceeding to deployment.

---

### Task 6: Deploy to VPS + end-to-end verify

**Files:** none (deployment only). VPS: `ssh freellmapi`, bare-metal node + systemd `freellmapi.service`, repo at `/opt/freellmapi`.

- [ ] **Step 1: Push and deploy**

```bash
git push origin main
ssh freellmapi "cd /opt/freellmapi && git pull && npm install --no-audit --no-fund && npm run build && systemctl restart freellmapi && systemctl is-active freellmapi"
```

If the workstation→GitHub connection is down (known intermittent issue — see project memory), fall back to the patch channel: `git format-patch -1 HEAD -o D:\tmp`, scp the patch, `git am` on the VPS, and reconcile hashes later.

- [ ] **Step 2: Verify the migration ran on the live DB**

Avoid nested shell quoting entirely (known PowerShell/ssh trap — see project memory): base64-encode each Node script locally and decode it on the VPS.

Migration check script:

```javascript
const db = require('better-sqlite3')('server/data/freeapi.db', { readonly: true });
const cols = db.prepare('PRAGMA table_info(api_keys)').all().filter(c => c.name.startsWith('usage_')).map(c => c.name);
console.log(cols.join(','));
```

Send it as `$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))` then:

```bash
ssh freellmapi "cd /opt/freellmapi && echo $b64 | base64 -d | node -"
```

Expected output: `usage_remaining,usage_allowance,usage_updated_at`.

- [ ] **Step 3: End-to-end refresh + badge payload**

Script (reads the unified key from settings, refreshes, prints each puter key's cached usage):

```javascript
const db = require('better-sqlite3')('server/data/freeapi.db', { readonly: true });
const key = db.prepare("SELECT value FROM settings WHERE key='unified_api_key'").get().value;
const refresh = await fetch('http://127.0.0.1:3001/api/keys/usage/refresh', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key },
});
console.log('refresh status:', refresh.status);
console.log(JSON.stringify(await refresh.json()));
const list = await (await fetch('http://127.0.0.1:3001/api/keys', { headers: { Authorization: 'Bearer ' + key } })).json();
for (const k of list.filter(k => k.platform === 'puter')) console.log(k.label, JSON.stringify(k.usage));
```

Same base64 transport as Step 2 (the script is ESM-flavored top-level await, so pipe it through `node --input-type=module -` instead of plain `node -`).

Expected: `refresh status: 200` with one `ok:true` result per enabled puter key, `remaining` near the probed values (PC_local ≈ 972, PC_01 ≈ 988, PC_02 ≈ 999.6, PC_03 ≈ 999.9 — they drift as the accounts are used), and each puter key in `/api/keys` carrying a non-null `usage` object.

- [ ] **Step 4: Commit nothing — report**

Report the live balances to the user; recommend a hard refresh (Ctrl+Shift+R) of `/keys` to see the badges.
