// Unit 8 ACCESSIBILITY audit: verdict-by-SHAPE, not color alone (design.md UX
// seat, "accessibility of the RED/AMBER/GREEN encoding (never color alone)").
//
// The UI must be legible with color removed, so EVERY verdict indicator encodes
// its verdict by shape as well as color. All panels (six pipes, the order table,
// the leadership headline, and the remediation-triggering strip) render the shared
// VerdictChip, so auditing the chip's shape map covers the whole board; the
// leadership freshness pill is the one bespoke indicator and is audited too.
//
// This is a static audit of the shipped frontend assets (it needs no DOM), run in
// the existing node:test runner so `npm test` guards the shape encoding against
// regressions. It asserts (a) VerdictChip maps each verdict to a distinct class,
// and (b) styles.css gives each of those classes a DISTINCT icon shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const chipTsx = readFileSync(`${repoRoot}frontend/src/components/VerdictChip.tsx`, 'utf8');
const css = readFileSync(`${repoRoot}frontend/src/styles.css`, 'utf8');

// Pull the body of the first CSS rule whose selector exactly matches `selector`.
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : null;
}

test('a11y: VerdictChip maps every verdict to a DISTINCT, non-empty shape class', () => {
  // Each verdict key must have its own class token; none may be empty (an empty
  // class would fall through to the base circle, colliding with green's shape).
  for (const verdict of ['green', 'amber', 'red', 'unknown']) {
    const re = new RegExp(`${verdict}:\\s*'([a-z]+)'`);
    const m = chipTsx.match(re);
    assert.ok(m, `VerdictChip CLASS has an entry for ${verdict}`);
    assert.ok(m![1]!.length > 0, `${verdict} maps to a non-empty class (no shape fall-through)`);
  }
  const classes = ['green', 'amber', 'red', 'unknown'].map(
    (v) => chipTsx.match(new RegExp(`${v}:\\s*'([a-z]+)'`))![1],
  );
  assert.equal(new Set(classes).size, 4, 'the four verdict classes are pairwise distinct');
});

test('a11y: each verdict chip renders a DISTINCT icon shape in styles.css', () => {
  const bodies = {
    green: ruleBody('.chip.g .ic'),
    amber: ruleBody('.chip.a .ic'),
    red: ruleBody('.chip.r .ic'),
    unknown: ruleBody('.chip.u .ic'),
  };
  for (const [verdict, body] of Object.entries(bodies)) {
    assert.ok(body, `.chip.${verdict} .ic has an explicit shape rule`);
  }
  // Shape geometry must differ between all four (circle / rounded square / diamond
  // / dash), so the encoding survives color removal.
  const set = new Set(Object.values(bodies));
  assert.equal(set.size, 4, 'all four chip shapes are geometrically distinct');
  // Spot-check the intended shapes so a future edit cannot silently flatten them.
  assert.match(bodies.green!, /border-radius:\s*50%/, 'green is a circle');
  assert.match(bodies.amber!, /border-radius:\s*2px/, 'amber is a rounded square');
  assert.match(bodies.red!, /rotate\(45deg\)/, 'red is a rotated diamond');
  assert.match(bodies.unknown!, /height:\s*3px/, 'unknown is a dash');
});

test('a11y: the leadership freshness pill is also shape-distinct (fresh / stale / unknown)', () => {
  const g = ruleBody('.lead-pill.g .lead-dot');
  const r = ruleBody('.lead-pill.r .lead-dot');
  const u = ruleBody('.lead-pill.u .lead-dot');
  assert.ok(g && r && u, 'the fresh/stale/unknown pill each have a shape rule');
  assert.equal(new Set([g, r, u]).size, 3, 'the three pill shapes are distinct');
  assert.match(r!, /rotate\(45deg\)/, 'stale pill is a diamond');
  assert.match(u!, /height:\s*3px/, 'unknown pill is a dash');
});

test('a11y: focus stays visible and reduced motion is respected', () => {
  // Interactive controls that were missing a visible focus ring now have one.
  assert.match(css, /\.seg button:focus-visible\s*\{[^}]*outline/, 'channel filter has a focus ring');
  assert.match(css, /\.chip-btn:focus-visible\s*\{[^}]*outline/, 'the clickable verdict chip has a focus ring');
  assert.match(css, /\.rm-btn:focus-visible\s*\{[^}]*outline/, 'remediation buttons have a focus ring');
  // The OS reduce-motion setting is honored.
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'reduced-motion media query present');
});

test('a11y: no em dashes in the audited frontend assets (house rule)', () => {
  const emDash = String.fromCharCode(0x2014); // U+2014, built by code so this file holds no literal em dash
  assert.ok(!chipTsx.includes(emDash), 'VerdictChip has no em dash');
  assert.ok(!css.includes(emDash), 'styles.css has no em dash');
});
