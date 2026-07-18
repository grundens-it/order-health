# ADR-0010: Add an operator-triggered executable-remediation path (actor mode) via existing middleware endpoints and a controlled script-runner, never by direct writes

## Status

Accepted (2026-07-13, Steve). Drafted by the Architect seat, Session A.

## Context

Order health has been a strictly read-only observability service (ADR-0001): it reads NAV, the middleware, and Shopify read-only, computes a snapshot, and serves a UI. Its "remediation" today is stubbed: pressing Resolve returns a `would_trigger` result and names either an existing middleware endpoint or a manual ops runbook, and makes no live call. For the endpoint-less conditions (the biggest being `fs_floor_at_zero`, whose only current lever is the ADR-0003 FS re-floor that Symmetry has not shipped yet) the "runbook" is just text telling a human what to do.

Steve wants the Resolve buttons to actually execute the fix, not name a manual step, and has accepted running scripts on the middleware VM if that is what it takes. That flips order health from an observer into an actor that mutates production, which requires a decision because it touches three locked-in choices:

- ADR-0001: standalone read-only service that "adds nothing to the Symmetry middleware."
- ADR-0009: the Shopify Admin API client is read-only, least-privilege, no write scopes.
- The design-wide hard line that this service never writes NAV.

Verification at draft time: highest existing ADR on the integration line is 0009, so this is 0010. Locked-in-decision conflict check found direct conflicts with ADR-0001 (read-only charter) and ADR-0009 (read-only Shopify), and a boundary interaction with ADR-0005 (deploy target and secrets). Those conflicts are the substance of this ADR, not an oversight.

## Decision

Add an OPERATOR-TRIGGERED executable-remediation path, tiered by what already exists, and keep the observability path read-only. Tools that already map to the middleware's existing authenticated action endpoints execute by calling those endpoints (unstub the live call, provision the auth token). Tools with no endpoint (the `fs_refloor` family) execute through a controlled, audited script-runner deployed on the middleware VM that order health triggers over one authenticated call and that runs only allow-listed, version-pinned scripts. Order health never writes NAV or Shopify directly and never runs arbitrary code. This amends ADR-0001 to carve out a gated, disarmed-by-default write path for operator remediation only; the aggregator and all observability stay read-only.

## Alternatives considered

### Alternative A: Symmetry exposes authenticated action endpoints; order health only calls them

- The middleware (which already owns the write path to NAV and Shopify) exposes an HTTP action endpoint per remediation, including a real FS re-floor per ADR-0003. Order health calls them, authenticated; it writes nothing itself.
- Pros: cleanest boundary and smallest blast radius. The actor stays the middleware, which already holds the write logic and creds. Order health remains a thin trigger, consistent with ADR-0001's spirit that it "adds nothing" that mutates. Every tool already modelled as `middleware_endpoint` fits with no new mechanism.
- Cons: the endpoint-less tools (`fs_refloor`, `clear_cu50007_job`, `unblock_and_repromote`, `atomic_watcher_restart`, `allocator_reallocate`) depend on Symmetry building endpoints, a third-party timeline. `fs_refloor` specifically waits on ADR-0003. The operator wants execution now.

### Alternative B: Order health writes directly (Shopify write scope, NAV write)

- Grant order health `write_inventory` on Shopify (re-floor the FS itself) and NAV write access, and perform remediations in this service.
- Pros: no Symmetry dependency; immediate.
- Cons: the dangerous option. It puts a SECOND writer on the exact FS-location inventory the middleware owns, which is precisely the contention that produces the floor-at-zero bug; two writers racing the FS floor is a worse bug, not a fix. It breaks ADR-0001 and ADR-0009 and the no-NAV-writes line, and it puts prod write creds for Shopify and NAV inside the observability service (a large new attack surface). Rejected.

### Alternative C: A controlled script-runner on the middleware VM that order health triggers

- A small, audited runner on the middleware VM holds an allow-list of vetted, version-pinned remediation scripts (FS re-floor, CU 50007 clear, staging unblock). Order health calls one authenticated `execute(scriptId, params)` endpoint; the runner validates the scriptId against the allow-list, runs the local script where it already has NAV/middleware/Shopify access, appends to an audit log, and returns a typed result. Order health holds no prod write creds; the runner does, scoped to the allow-listed scripts only.
- Pros: matches "drop scripts on the server"; independent of Symmetry building per-feature endpoints (add a vetted script when a new fix is needed); one controlled, audited execution surface rather than write creds spread into the app. Order health stays credential-light and only triggers.
- Cons: a new sensitive component with prod write access on Symmetry's VM; needs Symmetry/ops buy-in to host and grant it; a script-runner is a powerful surface that is dangerous if it ever accepts anything but a fixed allow-list; it partly overlaps what the middleware could expose natively.

## Recommendation and decision record

A tiered hybrid: Alternative A where an endpoint already exists, Alternative C for the endpoint-less tools, never Alternative B.

- Tier 1 (A, now, low effort): the tools already modelled as `middleware_endpoint` (`submit_fulfillment_request`, `back_sync_run_now`, `back_sync_rescan_from`, `close_unfulfilled_fos`, `recovery_sweep`, `stuck_staging_dedupe`) execute by firing the middleware's existing authenticated endpoint. This is unstubbing the live call in `remediationClient` and provisioning `MIDDLEWARE_AUTH_TOKEN`, not new infrastructure. These are the middleware's own write actions.
- Tier 2 (C, near term): the endpoint-less tools, `fs_refloor` first, execute through the VM script-runner. Each script is vetted, version-pinned, idempotent, and on a fixed allow-list.
- Tier 3 (A, over time): ask Symmetry to expose native endpoints for the Tier 2 actions; when the ADR-0003 FS re-floor endpoint ships, `fs_refloor` moves from the script-runner to that endpoint and the script is retired.

Reject B outright: a second writer on the FS inventory is the failure mode we are diagnosing, not a remedy.

Cross-cutting safety model (applies to every tier, non-negotiable):

- Disarmed by default. A single `REMEDIATION_LIVE_ENABLED` gate; when off, every trigger returns `would_trigger` with the exact call, exactly as today. Arming is a deliberate, documented posture, not a UI toggle a stray click can flip.
- Per-action operator confirmation in the UI, showing precisely what will run and against what (order, SKU, endpoint or scriptId, params) before it fires.
- Append-only audit log of every execution: who, when, tool/scriptId, params, target subject, and the returned result. This is the accountability artifact.
- Idempotency required of every action and every script; re-running is a safe no-op.
- Destructive or irreversible actions (the staging-row delete in `stuck_staging_dedupe`) require explicit per-order sign-off, are never part of a bulk apply, and are never auto-fired. Some may be held out of the executable path entirely pending a rollback story.
- Allow-list only for the runner: it executes a fixed set of pinned scripts by id, never caller-supplied code or paths.
- A global kill switch that disarms all execution immediately.
- No autonomous execution: nothing fires a production mutation without an explicit human action in the UI. Cowork and Claude never trigger a live remediation on the operator's behalf.

## Consequences

What changes after acceptance:

- ADR-0001 is amended: order health keeps a read-only observability path (aggregator, NAV, Shopify, middleware reads) and gains a SEPARATE, gated, disarmed-by-default, operator-triggered remediation path that may mutate production via the middleware's endpoints or the VM script-runner. The read-only default holds; remediation is opt-in and audited.
- `remediationClient` gains a real live path behind `REMEDIATION_LIVE_ENABLED`: Tier 1 fires the authenticated middleware endpoint; Tier 2 calls the runner's `execute` endpoint. The stub result stays the disarmed behavior.
- Shared types and the registry gain the runner binding (scriptId, allow-list membership) alongside the existing endpoint/runbook shapes; `fs_refloor` moves from pure ops_runbook to a runner-backed executable tool.

Work handed to other seats:

- DevOps seat: build and deploy the VM script-runner (auth, the pinned-script allow-list, the append-only audit log, the kill switch), provision `MIDDLEWARE_AUTH_TOKEN` and the runner credentials per ADR-0005, and define the runner's least-privilege access on the middleware VM. This is the critical-path infra and needs Symmetry/ops coordination to host on their box.
- QA seat: a safety test plan, the disarmed-returns-would_trigger invariant, per-action confirm, idempotency (run twice, second is a no-op), the destructive-action sign-off gate, allow-list rejection of any non-listed scriptId, audit-log completeness, and the kill switch.
- PM seat: scope the executable-remediation round; sequence Tier 1 (contained) ahead of Tier 2 (runner); file the Symmetry endpoint asks (Tier 3) including the ADR-0003 FS re-floor endpoint.
- Security review before arming against production: the runner is a new prod-write surface and must be reviewed (allow-list integrity, auth, audit, blast radius) before `REMEDIATION_LIVE_ENABLED` is ever set true in prod.

Operational note: this ADR does not itself arm anything. It defines the mechanism and the guardrails. Arming against production is a separate, gated, human decision made only after DevOps builds the audited path and QA/security clear it.

## References

- ADR-0001 (standalone read-only service, amended here for the remediation path), ADR-0002 (read-model), ADR-0005 (deploy target and secrets, where the runner and creds live), ADR-0009 (read-only Shopify client, the reason Alternative B is rejected).
- The FS floor-at-zero bug and Symmetry's ADR-0003 event-driven re-floor (memory `fs-floor-at-zero-negative-stock-bug`; prior chat "Grundens inventory sync bug investigation").
- `backend/src/remediation/remediationClient.ts` (the stub to be given a live path) and `backend/src/remediation/registry.ts` (the tool/runbook/endpoint registry).
