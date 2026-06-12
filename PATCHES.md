# TBG carried patches (`tbg-patches`)

This fork is **upstream tip + a short stack of TBG patches**. Policy
(2026-06-12): we do **not** open upstream PRs — all changes land here.
Divergence is kept cheap by discipline instead:

- Patches must be **additive and upstream-shaped** (no schema forks, no
  API breaks, tests in upstream conventions) so rebases stay trivial.
- On a version bump: rebase this branch onto the new upstream tag,
  re-play the stack, and **drop any patch** whose drop condition below is
  met. Never merge upstream into this branch.
- Every patch gets a row here when it lands. A patch without a documented
  drop condition is a review failure.
- Consumers pin a commit, not the branch: bump `GBRAIN_REF` in
  `tbg-brain-workspace/Dockerfile` deliberately after a rebase.

| Patch (first commit) | What / why | Drop when |
|---|---|---|
| `fix(ingest): log ingest event on capture/put_page write-through` (TBG-267) | Capture-based ingestion (slack/linear/meeting → `gbrain capture`) never wrote `ingest_log`, freezing `get_ingest_log` freshness at the last import while daily captures kept landing. | Upstream ships ingest-log writes on the capture/put_page path. |
| `docs(meeting-sync): fix transcript format + facts-extraction gotchas` (TBG-267) | Upstream doc described a transcript format the facts extractor rejects. | Upstream corrects the doc. |
| `feat(minions): subagent read federation + owner-scoped get_agent_job` (fork PR #1, TBG-274 / ADR-0004) | Dispatched subagent tool reads were pinned to source `default` (blind on pods whose content lives in `linear`/`slack`/`<client>` sources); `agent`-scope dispatch clients had no op to retrieve their own job results. Threads the dispatching client's `federated_read` into the tool context (`OperationContext.allowedSources`) and adds owner-checked `get_agent_job`. | Upstream ships minions "Phase 2" multi-tenant dispatch (per its `docs/designs/MINIONS_AGENT_ORCHESTRATION.md`) with equivalent read federation + owner-scoped retrieval. |
