/**
 * TBG-281 Phase A — withBackendSpendTracking control-flow.
 *
 * The risky logic is the no-clobber guard: if a budget owner (CLI --max-cost,
 * or a self-wrapping phase) is already in scope, the wrapper must NOT install
 * its own tracker (which would replace the active one per AsyncLocalStorage
 * semantics and silently break that caller's cap). When no owner is present,
 * it installs an observation tracker for the scope.
 *
 * The cents>0 → recordSpend persistence path is a thin call to the already-
 * tested recordSpend(); not re-exercised here (would need a DB fixture).
 */
import { describe, test, expect } from 'bun:test';
import { withBackendSpendTracking } from '../src/core/budget/backend-spend.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { withBudgetTracker, getCurrentBudgetTracker } from '../src/core/ai/gateway.ts';

// Spend is 0 in these tests (no gateway calls), so recordSpend is never
// invoked (cents>0 guard) and the engine is never touched.
const noMeta = { clientId: '@service:dream', operation: 'dream:cycle' };

describe('withBackendSpendTracking', () => {
  test('installs an observation tracker when none is in scope', async () => {
    const h: { cap: number | undefined; present: boolean } = { cap: 0, present: false };
    await withBackendSpendTracking(null, noMeta, async () => {
      const t = getCurrentBudgetTracker();
      h.present = t !== null;
      h.cap = t?.cap;
    });
    expect(h.present).toBe(true);
    expect(h.cap).toBeUndefined(); // uncapped = observation only
  });

  test('does NOT clobber an existing budget owner (e.g. CLI --max-cost)', async () => {
    const parent = new BudgetTracker({ maxCostUsd: 5, label: 'test-parent' });
    const h: { same: boolean; cap: number | undefined } = { same: false, cap: undefined };
    await withBudgetTracker(parent, async () => {
      await withBackendSpendTracking(null, noMeta, async () => {
        const t = getCurrentBudgetTracker();
        h.same = t === parent;
        h.cap = t?.cap;
      });
    });
    expect(h.same).toBe(true); // parent survived — not replaced
    expect(h.cap).toBe(5);
  });

  test('returns the wrapped fn’s value through', async () => {
    const out = await withBackendSpendTracking(null, { clientId: '@service:autopilot', operation: 'autopilot-cycle' }, async () => 42);
    expect(out).toBe(42);
  });

  test('tracker scope ends after the wrapper resolves', async () => {
    await withBackendSpendTracking(null, noMeta, async () => {});
    expect(getCurrentBudgetTracker()).toBeNull();
  });
});
