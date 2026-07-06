#!/usr/bin/env node
// visual-status: the LOCAL equivalent of the external /grundens:visual-status
// slash command.
//
// The `/grundens:visual-status` slash command is EXTERNAL Grundens tooling and is
// not part of this repo. This script is the repo-side support it consumes: it
// reads docs/rounds/order-health.round.json (the single source of truth for the
// build plan) and prints the plan tree the slash command visualizes: units with
// their status and PRs, the gates, and the phase legend. Run it with:
//
//   node scripts/visual-status.mjs            # human-readable tree
//   node scripts/visual-status.mjs --json     # the raw round doc
//   npm run visual-status
//
// It is pure read-only: it opens no network, touches no source, and only reads
// the round JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROUND_PATH = fileURLToPath(new URL('../docs/rounds/order-health.round.json', import.meta.url));

// Status -> a short ASCII marker + label (no em dashes, ASCII-only per house rule).
const STATUS = {
  done: { mark: '[x]', label: 'done' },
  active: { mark: '[~]', label: 'active' },
  drafting_adr: { mark: '[.]', label: 'drafting ADR' },
  blocked: { mark: '[!]', label: 'blocked' },
};

function statusFor(s) {
  return STATUS[s] ?? { mark: '[ ]', label: s ?? 'unknown' };
}

function loadRound() {
  try {
    return JSON.parse(readFileSync(ROUND_PATH, 'utf8'));
  } catch (err) {
    process.stderr.write(`visual-status: cannot read ${ROUND_PATH}: ${err.message}\n`);
    process.exit(1);
  }
}

function unitLine(u) {
  const st = statusFor(u.status);
  const pr = u.pr ? `PR #${u.pr}${u.merged ? ' merged' : ''}` : u.status === 'active' ? 'PR pending' : 'no PR';
  const note = u.note ? `\n         note: ${u.note}` : '';
  const num = String(u.unit).padStart(2, ' ');
  return `  ${st.mark} Unit ${num} [${u.phase}] ${u.name}\n         ${st.label} - issue #${u.issue} - ${pr}${note}`;
}

function print(round) {
  const out = [];
  out.push(`Order Health round: ${round.round}`);
  out.push(`repo ${round.repo}  |  umbrella #${round.umbrella_issue}  |  updated ${round.updated}`);
  out.push('');

  out.push('Stack');
  out.push(`  ${round.stack.decision} (${round.stack.adr}, ${round.stack.status})`);
  out.push(`  signed off by ${round.stack.signed_off_by} on ${round.stack.signed_off_on}`);
  out.push('');

  out.push('Gates');
  for (const [name, value] of Object.entries(round.gates)) {
    const done = /^done|signed off/i.test(value);
    out.push(`  ${done ? '[x]' : '[ ]'} ${name}: ${value}`);
  }
  out.push('');

  out.push('Phases');
  for (const [key, desc] of Object.entries(round.phases)) {
    out.push(`  ${key}: ${desc}`);
  }
  out.push('');

  out.push('Units');
  const byPhase = new Map();
  for (const u of round.units) {
    if (!byPhase.has(u.phase)) byPhase.set(u.phase, []);
    byPhase.get(u.phase).push(u);
  }
  for (const [phase, units] of byPhase) {
    out.push(`  Phase ${phase}:`);
    for (const u of units) out.push(unitLine(u));
  }
  out.push('');

  const total = round.units.length;
  const done = round.units.filter((u) => u.status === 'done').length;
  const active = round.units.filter((u) => u.status === 'active').length;
  out.push(`Progress: ${done}/${total} units done, ${active} active.`);

  process.stdout.write(out.join('\n') + '\n');
}

const round = loadRound();
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(round, null, 2) + '\n');
} else {
  print(round);
}
