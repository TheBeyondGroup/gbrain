/**
 * Subagent write-source threading (bound_source_id → put_page).
 *
 * The gap this closes (found live on a TBG pod, 2026-06-12, Stage-1 spike):
 *
 * submit_agent stamps `source_id` job data from the dispatching client's
 * `oauth_clients.bound_source_id` — but `buildOpContext` hardcoded
 * `sourceId: 'default'`, so the stamp was never threaded into the tool
 * context and every agent-driven put_page landed in the 'default' source.
 * That silently defeats source-level isolation of commissioned output: a
 * client bound to write into source 'commissions' (so that other clients'
 * `federated_read` can exclude unreviewed drafts) wrote into 'default',
 * where every reader federates.
 *
 * Fix mirrors the read-federation patch: handler threads `data.source_id`
 * to buildBrainTools, buildOpContext surfaces it as the first-class
 * `OperationContext.sourceId` (write authority), falling back to 'default'
 * when unset. The slug-prefix allow-list enforcement is unchanged and
 * still applies on top.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  operationsByName,
  OperationError,
  type OperationContext,
} from '../src/core/operations.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';

const submit_agent = operationsByName['submit_agent'];
if (!submit_agent) {
  throw new Error('submit_agent missing from operations registry — test fixture invalid');
}

let engine: PGLiteEngine;
let tmpAuditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-writesrc-audit-'));
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('commissions', 'commissions', '/tmp/commissions') ON CONFLICT (id) DO NOTHING`);
});

async function seedClient(clientId: string, opts: { bound_source_id?: string; bound_slug_prefixes?: string[]; bound_tools?: string[] } = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_max_concurrent, federated_read,
        bound_source_id, bound_slug_prefixes, created_at, deleted_at)
     VALUES ($1, $1, '', 'agent', ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $2, 5, ARRAY[]::text[],
             $3, $4, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       bound_tools = EXCLUDED.bound_tools,
       bound_source_id = EXCLUDED.bound_source_id,
       bound_slug_prefixes = EXCLUDED.bound_slug_prefixes`,
    [clientId, opts.bound_tools ?? ['brain_put_page'], opts.bound_source_id ?? null, opts.bound_slug_prefixes ?? []],
  );
}

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

function authedCtx(clientId: string): OperationContext {
  return ctxOf({ auth: { token: 't', clientId, scopes: ['agent'] } as any });
}

describe('submit_agent stamps source_id from the client row', () => {
  test('bound_source_id lands in job data', async () => {
    await seedClient('cl_bound', { bound_source_id: 'commissions' });
    const { id } = await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () =>
      await submit_agent.handler(authedCtx('cl_bound'), { prompt: 'noop' }) as { id: number });
    const rows = await engine.executeRaw(`SELECT data FROM minion_jobs WHERE id = $1`, [id]);
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data.source_id).toBe('commissions');
  });

  test('unbound client stamps nothing (default write authority downstream)', async () => {
    await seedClient('cl_unbound', { bound_source_id: undefined });
    const { id } = await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () =>
      await submit_agent.handler(authedCtx('cl_unbound'), { prompt: 'noop' }) as { id: number });
    const rows = await engine.executeRaw(`SELECT data FROM minion_jobs WHERE id = $1`, [id]);
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data.source_id).toBeUndefined();
  });
});

describe('buildBrainTools threads sourceId into put_page writes', () => {
  function putPageWith(opts: { sourceId?: string; allowedSlugPrefixes?: string[] }) {
    const tools = buildBrainTools({
      subagentId: 1,
      engine: engine as any,
      config: {} as any,
      sourceId: opts.sourceId,
      allowedSlugPrefixes: opts.allowedSlugPrefixes,
    });
    return tools.find(t => t.name === 'brain_put_page')!;
  }

  test('bound write lands in the bound source, not default', async () => {
    const putPage = putPageWith({ sourceId: 'commissions', allowedSlugPrefixes: ['commissions/*'] });
    await putPage.execute(
      { slug: 'commissions/digest/test', title: 'Test draft', content: 'draft body' },
      { engine: engine as any, jobId: 1 } as any,
    );
    const rows = await engine.executeRaw(`SELECT source_id FROM pages WHERE slug = 'commissions/digest/test'`);
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('commissions');
  });

  test('unbound write keeps the legacy default source (pre-fix behavior, now opt-in)', async () => {
    const putPage = putPageWith({ allowedSlugPrefixes: ['commissions/*'] });
    await putPage.execute(
      { slug: 'commissions/digest/test-default', title: 'Test draft', content: 'draft body' },
      { engine: engine as any, jobId: 1 } as any,
    );
    const rows = await engine.executeRaw(`SELECT source_id FROM pages WHERE slug = 'commissions/digest/test-default'`);
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('slug-prefix enforcement still applies on top of the bound source', async () => {
    const putPage = putPageWith({ sourceId: 'commissions', allowedSlugPrefixes: ['commissions/*'] });
    await expect(
      putPage.execute(
        { slug: 'reports/escape-attempt', title: 'Escape', content: 'nope' },
        { engine: engine as any, jobId: 1 } as any,
      ),
    ).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw(`SELECT source_id FROM pages WHERE slug = 'reports/escape-attempt'`);
    expect(rows.length).toBe(0);
  });
});
