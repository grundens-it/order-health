// Unit 8 STALENESS SIMULATION: the headline hardening test (design.md 5A.1 / 5A.3).
//
// This is the QA-seat scenario the flat pipeline view misses: NAV IABC (CU 50007)
// keeps completing on schedule and the watcher heartbeat still logs, so any naive
// "is the cron/job alive" check stays GREEN, yet auto-sync has STALLED because the
// watermark stopped advancing (the last completed walk is older than 2 IABC
// cycles). The monitor reports three INDEPENDENT verdicts and the pipe is RED if
// any one is RED, so the stale watermark alone reds inventory_sync via FRESHNESS
// while liveness and the NAV job-queue verdict stay green.
//
// This proves freshness and liveness genuinely DIVERGE: they are not the same
// signal wearing two labels. It is the test that would have caught the nftables
// outage that only a manual investigation found.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PipelineHealth } from '@order-health/shared';
import { computePipelines } from './writers.js';
import { computeRollup } from './rollup.js';
import { agoIso, makeSeededSources, ONE_CYCLE_S } from './seededBoard.js';

function byPipe(pipes: PipelineHealth[], key: string): PipelineHealth {
  const p = pipes.find((x) => x.pipe === key);
  assert.ok(p, `pipe ${key} present`);
  return p;
}

test('STALENESS SIMULATION: a starved aggregator reds inventory_sync via FRESHNESS while liveness and the NAV job-queue (CU 50007) stay GREEN', async () => {
  const now = Date.now();

  // Seed the divergence deliberately:
  //  - watermark NOT advancing: newest IABC entry is well ahead of the watermark,
  //    and the last completed walk is > 2 IABC cycles old (the freshness-RED band).
  //  - watcher STILL alive: heartbeat logged seconds ago (liveness GREEN).
  //  - NAV job queue STILL completing: CU 50007/50009 verdict GREEN.
  const sources = makeSeededSources({
    now,
    inventory: {
      watermark: {
        navNewestIabcEntryNo: 105_400, // NAV kept producing IABC completions...
        watermarkEntryNo: 104_100, // ...but the watermark is stuck ~1,300 entries behind
        lastWalkAt: agoIso(3.5 * ONE_CYCLE_S, now), // last walk > 3 cycles ago => freshness RED (bands widened to 2/3)
        watcherHeartbeatAt: agoIso(90, now), // watcher heartbeat is fresh => liveness GREEN
      },
    },
    // The NAV job queue reports healthy: CU 50007 is completing on schedule.
    jobQueue: { verdict: 'green', autoReleaseFiredAt: agoIso(240, now), stuckJobCount: 0 },
  });

  const pipes = await computePipelines(sources);
  const inv = byPipe(pipes, 'inventory_sync');
  const jobQueue = byPipe(pipes, 'nav_job_queue');

  // THE DIVERGENCE, asserted explicitly:
  //   freshness RED  (watermark starved)  -> reds the pipe
  //   liveness GREEN (watcher still alive) -> would have stayed "healthy" on a naive check
  //   job queue GREEN (CU 50007 completing) -> the other "is it running" signal is fine
  assert.equal(inv.freshness_verdict, 'red', 'freshness is RED: watermark stalled > 3 IABC cycles');
  assert.equal(inv.liveness_verdict, 'green', 'liveness is GREEN: the watcher heartbeat is fresh');
  assert.equal(jobQueue.pipe_verdict, 'green', 'NAV job-queue (CU 50007) is GREEN: the job still completes');

  // The pipe rolls up RED, and it is FRESHNESS driving it (not liveness, not the
  // amber-capped divergence): worst-of-three with only freshness red.
  assert.equal(inv.pipe_verdict, 'red', 'inventory_sync pipe is RED, driven by freshness');

  // And the divergence proof, stated as a single invariant: the pipe is red while
  // both "aliveness" signals are green.
  assert.ok(
    inv.pipe_verdict === 'red' && inv.liveness_verdict === 'green' && jobQueue.pipe_verdict === 'green',
    'freshness and liveness diverge: RED pipe with GREEN liveness and GREEN job-queue',
  );

  // The leadership headline hardens accordingly: a stale inventory watermark alone
  // pulls the glance layer to stuck and reports inventory_sync as NOT fresh.
  const rollup = computeRollup(pipes, []);
  assert.equal(rollup.headline, 'stuck');
  assert.equal(rollup.headline_verdict, 'red');
  assert.equal(rollup.inventory_freshness, 'red');
});

test('control: with the watermark advancing (fresh last walk), the SAME live signals leave inventory_sync GREEN', async () => {
  // Same liveness + job-queue as the staleness case, but the last walk is recent.
  // This isolates freshness as the ONLY thing that changed, so the red in the
  // scenario above cannot be attributed to liveness or the job queue.
  const now = Date.now();
  const sources = makeSeededSources({
    now,
    inventory: {
      watermark: {
        navNewestIabcEntryNo: 105_400,
        watermarkEntryNo: 105_390, // watermark caught up
        lastWalkAt: agoIso(600, now), // last walk < 1 cycle ago => freshness GREEN
        watcherHeartbeatAt: agoIso(90, now),
      },
    },
    jobQueue: { verdict: 'green', autoReleaseFiredAt: agoIso(240, now), stuckJobCount: 0 },
  });

  const inv = byPipe(await computePipelines(sources), 'inventory_sync');
  assert.equal(inv.freshness_verdict, 'green');
  assert.equal(inv.liveness_verdict, 'green');
  assert.equal(inv.pipe_verdict, 'green');
});
