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
