# visual-status

`/grundens:visual-status` is an **external** Grundens slash command. It is part of
Grundens' own tooling and is **not** shipped in this repo. It reads a round's plan
file and renders the plan tree (units, status, PRs, gates) for a round.

This repo provides the **repo-side support** that command consumes: the round file
`docs/rounds/order-health.round.json` and a small local script that renders the
same tree without the external tooling.

## Local equivalent

```
npm run visual-status          # human-readable plan tree
node scripts/visual-status.mjs # same thing, run directly
node scripts/visual-status.mjs --json   # the raw round document
```

The script (`scripts/visual-status.mjs`) is pure read-only: it reads only
`docs/rounds/order-health.round.json`, opens no network connection, and touches no
source. It prints:

- the round header (repo, umbrella issue, last-updated),
- the stack decision and sign-off,
- the gates with a done / open marker,
- the phase legend (F / W / C / D),
- every unit grouped by phase with its status marker, issue, PR (and whether it
  merged), and any note,
- a one-line progress summary.

Keep `docs/rounds/order-health.round.json` current as units land; both the external
slash command and this local script render straight from it, so it is the single
source of truth for round status.
