/**
 * Backend (SERVICE-identity) LLM-spend observability — TBG-281 Phase A.
 *
 * The autopilot cycle and the nightly dream crons run with NO OAuth client, so
 * their model spend never reached `mcp_spend_log` and the per-brain daily
 * backend cost was invisible. That blind spot is how `propose_takes` re-scanning
 * the 50 most-recent pages every 5 min ran up ~$700/day undetected for a weekend.
 *
 * `withBackendSpendTracking` installs an UNCAPPED `BudgetTracker` for the scope
 * (observation only — it never throws) and, after the scope completes, records
 * the cumulative spend to `mcp_spend_log` under a `@service:*` client_id so the
 * backend cost is queryable:
 *
 *   SELECT sum(spend_cents)/100.0 AS usd
 *     FROM mcp_spend_log
 *    WHERE client_id LIKE '@service:%'
 *      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC');
 *
 * Nesting: if a tracker is already installed (e.g. a CLI `--max-cost` run, or a
 * phase that manages its own tracker), we do NOT clobber it — that caller owns
 * budgeting, and we skip persistence to avoid double-counting. Phases that
 * self-install a tracker (conversation_facts_backfill, enrich_thin,
 * extract-conversation-facts) are therefore NOT captured here; they compute
 * their own `spent_usd` and persist separately. This wrapper targets the
 * dream-cycle phases (synthesize/patterns/propose_takes/grade_takes/
 * calibration_profile) and the autopilot maintenance cycle, which do not.
 *
 * Observation only in Phase A: no cap is enforced. Phase B adds a per-brain
 * daily cap (`backend.daily_budget_usd`) checked against this signal.
 */
import type { BrainEngine } from '../engine.ts';
import { BudgetTracker } from './budget-tracker.ts';
import { withBudgetTracker, getCurrentBudgetTracker } from '../ai/gateway.ts';
import { recordSpend } from '../spend-log.ts';

export async function withBackendSpendTracking<T>(
  engine: BrainEngine | null | undefined,
  meta: { clientId: string; operation: string; model?: string; provider?: string },
  fn: () => Promise<T>,
): Promise<T> {
  // A budget owner is already in scope (CLI --max-cost, or a self-wrapping
  // phase). Don't clobber it; that caller is responsible for its own spend.
  if (getCurrentBudgetTracker()) return fn();

  const tracker = new BudgetTracker({ maxCostUsd: undefined, label: meta.operation });
  try {
    return await withBudgetTracker(tracker, fn);
  } finally {
    // NUMERIC(12,4) cents; round to 4 dp. Skip zero-spend scopes (cheap
    // maintenance-only cycles) to keep the log signal-dense.
    const cents = Math.round(tracker.totalSpent * 100 * 1e4) / 1e4;
    if (cents > 0 && engine) {
      // recordSpend is itself best-effort (swallows DB errors); the extra
      // catch guards against an unexpected throw breaking the cycle.
      await recordSpend(engine, {
        clientId: meta.clientId,
        operation: meta.operation,
        spendCents: cents,
        model: meta.model,
        provider: meta.provider,
      }).catch(() => {});
    }
  }
}
