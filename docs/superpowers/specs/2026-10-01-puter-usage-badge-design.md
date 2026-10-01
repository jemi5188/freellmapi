# Puter Key Usage Badge — Design Spec

**Date:** 2026-10-01
**Status:** Approved (user confirmed design 2026-10-01)
**Depends on:** Puter platform support (`2026-09-28-puter-provider-design.md`)

## 1. Problem

Puter free accounts carry a monthly metered allowance (1000 credits by
default). Today the only way to see how much an account has left is to open
`puter.com/dashboard#usage` in a browser and sign into that account. With
several Puter keys configured in FreeLLMapi — each backed by a different
account, often behind its own proxy — checking balances one by one is
tedious.

**Goal:** show each Puter key's remaining allowance directly on its row in
the Keys page, so the operator can see all account balances at a glance.

## 2. Verified upstream facts (probed 2026-10-01, live)

- Endpoint: `GET https://api.puter.com/metering/usage`, `Authorization:
  Bearer <auth_token>`. This is the exact call behind
  `puter.auth.getMonthlyUsage()` (confirmed in the open-source SDK:
  `src/puter-js/src/modules/Auth.js`) and the dashboard's usage tab.
- Response (200, flat — no `allowanceInfo` wrapper in practice):

  ```json
  {
    "remaining": 972.055823119917,
    "monthUsageAllowance": 1000,
    "addons": {},
    "unit": "credits"
  }
  ```

- The call does **not** consume the metered AI allowance (it is a metering
  read, not an AI call).
- Probed against all 4 live keys: PC_local 972/1000, PC_01 988/1000,
  PC_02 999.6/1000, PC_03 999.9/1000.
- The docs' "scoped to the calling app" caveat applies to the per-app
  breakdown (`appTotals`/`usage`), **not** to the allowance totals.

## 3. Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Refresh strategy | Auto on Keys-page load (60 s client cache) + manual refresh button |
| Behavior at 0 credits | Warning display only — routing behavior unchanged |
| Display | Badge per Puter key row: mini progress bar + `972 / 1000 credits` |

## 4. Architecture

### 4.1 Backend

**`PuterProvider.getUsage(apiKey): Promise<KeyUsage>`** (new method)

- `GET {baseUrl}/metering/usage`, Bearer header, via `fetchWithTimeout` so
  the per-key proxy plumbing applies unchanged (`timeoutBounds:
  'request'`).
- 30 s timeout (`providerTimeoutMs('puter', 30_000)` is overkill for a
  read; use a fixed 30 s).
- Returns `{ remaining, monthlyAllowance, unit }` (numbers + string).
- Errors propagate as `providerHttpError` (401/403 → invalid-key signal,
  others retryable) — same classification the rest of the adapter uses.

**`api_keys` table — 3 new columns** (versioned migration; generic names so
other platforms can adopt the same columns later):

```sql
usage_remaining REAL NULL,
usage_allowance REAL NULL,
usage_updated_at INTEGER NULL   -- unix ms
```

NULL means "never fetched" → badge hidden. `down()` drops the columns;
round-trip must converge.

**Keys routes — one new endpoint:**

- `POST /api/keys/usage/refresh` — resolves all **enabled** `puter` keys,
  fetches usage for each **in parallel** (`Promise.allSettled`), writes
  `usage_remaining` / `usage_allowance` / `usage_updated_at` per key. One
  key's failure must not affect the others: the response is
  `{ results: [{ keyId, ok: true, remaining, allowance, updatedAt } |
                { keyId, ok: false, error }] }`.
- Non-puter keys are skipped silently (not an error).
- `GET /api/keys` (existing) naturally carries the three cached columns in
  the key payload.

### 4.2 Frontend (Keys page)

- Badge next to the key label, rendered only when
  `usage_allowance != null`:
  - Mini progress bar (width = remaining/allowance) + text
    `972 / 1000 credits`.
  - Color by remaining ratio: > 50 % green, 20–50 % amber, < 20 % red
    (0 credits → red `0 / 1000`). Display-only warning; routing unchanged.
- Data via TanStack Query: `['keys','usage']`, `staleTime: 60_000`;
  refetch on window focus per TanStack defaults. Manual refresh button
  beside the badge group invalidates the query.
- Badge tooltip: "updated X min ago" (from `usage_updated_at`); a key whose
  last refresh failed shows its last successful values plus an amber warning
  icon.
- Never-fetched keys show nothing (no placeholder noise).
- i18n: new keys added to `en.json` + all 59 locales via the existing
  `check:i18n` gate.

### 4.3 Security

Tokens never leave the server: the browser only ever sees numbers from the
FreeLLMapi API. Upstream calls ride the same per-key proxy path as chat
traffic.

## 5. Testing

- **Adapter (`puter.test.ts` additions):** `getUsage` contract — parses flat
  response; 401 → invalid-key error; timeout; missing
  `monthUsageAllowance` field → rejects with a clear error.
- **Routes (`keys` route tests):** refresh endpoint — parallel fetch with
  one failing key (isolation), non-puter keys skipped, DB columns written,
  auth required.
- **Migration:** columns exist, default NULL, `down()` removes them,
  round-trip converges.

## 6. Out of scope

- Auto-disabling exhausted keys (user chose warning-only).
- Scheduled background polling.
- Other platforms' quotas (columns are generic, adoption is future work).
- Addon allowances (`addons` object ignored for now — all probed accounts
  show `{}`).
