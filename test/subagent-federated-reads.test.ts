/**
 * Subagent read federation + owner-scoped result retrieval.
 *
 * Two gaps this closes (found live on a TBG pod, 2026-06-12):
 *
 * 1. READ FEDERATION. `buildOpContext` hardcoded `sourceId: 'default'` for
 *    every subagent tool call, so a dispatched agent was blind to all other
 *    sources on the brain — on a brain whose content lives in non-default
 *    sources (linear/slack/<client>), brain_search returned zero rows for
 *    everything regardless of the dispatching client's `federated_read`.
 *    Fix: submit_agent stamps `__federated_read` from the client row, the
 *    handler threads it to buildBrainTools, and buildOpContext surfaces it
 *    as the first-class `OperationContext.allowedSources` consumed by
 *    `sourceScopeOpts`.
 *
 * 2. RESULT RETRIEVAL. get_job/get_job_progress are admin-only, and the
 *    `agent` scope is a deliberate sibling (D13) that implies nothing — so
 *    a dispatch-only client could submit jobs it could never read back.
 *    `get_agent_job` (scope: agent) returns a job iff the caller is the
 *    client that submitted it (`__owner_client_id` match), with the same
 *    error for "not found" and "not yours" so job-id existence doesn't
 *    leak across clients.
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
  sourceScopeOpts,
  type OperationContext,
} from '../src/core/operations.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';

const submit_agent = operationsByName['submit_agent'];
const get_agent_job = operationsByName['get_agent_job'];
if (!submit_agent || !get_agent_job) {
  throw new Error('submit_agent / get_agent_job missing from operations registry — test fixture invalid');
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
  // resetPgliteState truncates `config`; MinionQueue.ensureSchema() needs the
  // migrated-version marker (same convention as submit-agent.test.ts).
  await engine.setConfig('version', '85');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-fedread-audit-'));
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Beta secret', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
});

async function seedClient(clientId: string, opts: { federated_read?: string[]; bound_tools?: string[] } = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_max_concurrent, federated_read, created_at, deleted_at)
     VALUES ($1, $1, '', 'agent', ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $2, 5, $3, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       bound_tools = EXCLUDED.bound_tools,
       federated_read = EXCLUDED.federated_read`,
    [clientId, opts.bound_tools ?? ['brain_search'], opts.federated_read ?? []],
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

async function submitAs(clientId: string): Promise<{ id: number }> {
  return await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
    return await submit_agent.handler(authedCtx(clientId), { prompt: 'noop' }) as { id: number };
  });
}

describe('sourceScopeOpts honors first-class ctx.allowedSources', () => {
  test('ctx.allowedSources federates when no auth present (subagent path)', () => {
    expect(sourceScopeOpts(ctxOf({ sourceId: 'default', allowedSources: ['alpha', 'beta'] })))
      .toEqual({ sourceIds: ['alpha', 'beta'] });
  });

  test('auth.allowedSources wins over ctx.allowedSources (authenticated grant is authoritative)', () => {
    const ctx = ctxOf({
      auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['gamma'] } as any,
      allowedSources: ['alpha'],
    });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['gamma'] });
  });

  test('empty ctx.allowedSources MUST NOT widen — falls back to scalar sourceId', () => {
    expect(sourceScopeOpts(ctxOf({ sourceId: 'default', allowedSources: [] })))
      .toEqual({ sourceId: 'default' });
  });
});

describe('submit_agent stamps __federated_read from the client row', () => {
  test('client federation lands in job data', async () => {
    await seedClient('cl_fed', { federated_read: ['alpha', 'beta'] });
    const { id } = await submitAs('cl_fed');
    const rows = await engine.executeRaw(`SELECT data FROM minion_jobs WHERE id = $1`, [id]);
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data.__federated_read).toEqual(['alpha', 'beta']);
    expect(data.__owner_client_id).toBe('cl_fed');
  });

  test('client with empty federation stamps an empty list (scalar fallback downstream)', async () => {
    await seedClient('cl_nofed', { federated_read: [] });
    const { id } = await submitAs('cl_nofed');
    const rows = await engine.executeRaw(`SELECT data FROM minion_jobs WHERE id = $1`, [id]);
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data.__federated_read).toEqual([]);
  });
});

describe('buildBrainTools threads federation into tool reads', () => {
  function registryWith(federatedRead?: string[]) {
    return buildBrainTools({
      subagentId: 1,
      engine: engine as any,
      config: {} as any,
      federatedRead,
    });
  }

  test('federated registry reads a beta-source page', async () => {
    const tools = registryWith(['alpha', 'beta']);
    const getPage = tools.find(t => t.name === 'brain_get_page')!;
    const page: any = await getPage.execute({ slug: 'secret/beta-doc' }, { engine: engine as any, jobId: 1 } as any);
    expect(page.title).toBe('Beta secret');
  });

  test('unfederated registry stays scoped to default (the pre-fix blindness, now opt-in)', async () => {
    const tools = registryWith(undefined);
    const getPage = tools.find(t => t.name === 'brain_get_page')!;
    await expect(
      getPage.execute({ slug: 'secret/beta-doc' }, { engine: engine as any, jobId: 1 } as any),
    ).rejects.toBeInstanceOf(OperationError);
  });
});

describe('get_agent_job — owner-scoped retrieval for dispatch clients', () => {
  test('owner reads its own job back', async () => {
    await seedClient('cl_owner');
    const { id } = await submitAs('cl_owner');
    const job: any = await get_agent_job.handler(authedCtx('cl_owner'), { id });
    expect(job.id).toBe(id);
    expect(job.status).toBe('waiting');
    expect(job.result).toBeNull();
  });

  test("another agent-scope client CANNOT read it (same error as not-found — no id-existence leak)", async () => {
    await seedClient('cl_owner');
    await seedClient('cl_other');
    const { id } = await submitAs('cl_owner');
    await expect(get_agent_job.handler(authedCtx('cl_other'), { id })).rejects.toBeInstanceOf(OperationError);
  });

  test('unauthenticated context is refused', async () => {
    await seedClient('cl_owner');
    const { id } = await submitAs('cl_owner');
    await expect(get_agent_job.handler(ctxOf(), { id })).rejects.toBeInstanceOf(OperationError);
  });

  test('declares scope=agent (dispatch clients can call it without admin)', () => {
    expect(get_agent_job.scope).toBe('agent' as any);
  });
});
