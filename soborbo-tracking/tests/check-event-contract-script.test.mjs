import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Harness for server/check-event-contract.mjs — the BROWSER contract guard
 * (code ↔ docs ↔ GTM). It had no test of its own, which is how both defects this
 * file pins down survived: a regex that flagged ordinary UI data as a tracking
 * event, and the absence of any way to declare an event deliberately GTM-free.
 *
 * These run the real script as a subprocess, so argument parsing and exit codes
 * are covered too — the parts CI actually depends on.
 *
 * WHY .mjs AND NOT .ts: the package's tsconfig deliberately ships no node types
 * (`types: ["vitest/globals"]`) — lib/ is BROWSER code, and making `process` and
 * node builtins ambient there would weaken exactly that boundary. Node-side
 * tooling in this package is .mjs already (server/*.mjs, tests/e2e/serve.mjs);
 * a harness for an .mjs script belongs on the same side of that line.
 */

// The jsdom environment does not give import.meta a file: URL, so anchor on the
// vitest root (the package directory) instead.
const SCRIPT = resolve(process.cwd(), 'server/check-event-contract.mjs');

/** @type {string} */
let root;

/**
 * Writes one fixture repo and runs the checker against it.
 * @param {{ src?: Record<string,string>, docs?: string, gtm?: unknown, exempt?: string }} files
 */
function run(files) {
  const dir = mkdtempSync(join(root, 'fx-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  for (const [name, body] of Object.entries(files.src ?? {})) {
    writeFileSync(join(dir, 'lib', name), body, 'utf8');
  }
  writeFileSync(join(dir, 'events.md'), files.docs ?? '', 'utf8');

  const args = [SCRIPT, '--src', './lib', '--events', './events.md'];
  if (files.gtm !== undefined) {
    writeFileSync(join(dir, 'gtm.json'), JSON.stringify(files.gtm), 'utf8');
    args.push('--gtm', './gtm.json');
  } else {
    args.push('--gtm', './missing.json');
  }
  if (files.exempt !== undefined) {
    writeFileSync(join(dir, 'exempt.json'), files.exempt, 'utf8');
    args.push('--gtm-exempt', './exempt.json');
  } else {
    args.push('--gtm-exempt', './missing-exempt.json');
  }

  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * A GTM container exposing one CUSTOM_EVENT trigger firing one live tag per name.
 * @param {string[]} eventNames
 */
function container(eventNames) {
  return {
    containerVersion: {
      trigger: eventNames.map((name, i) => ({
        triggerId: String(100 + i),
        type: 'CUSTOM_EVENT',
        customEventFilter: [{ parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: name }] }],
      })),
      tag: eventNames.map((_, i) => ({ paused: false, firingTriggerId: [String(100 + i)] })),
    },
  };
}

/** @param {...string} names */
const docFor = (...names) => names.map((n) => `- \`${n}\` — documented.`).join('\n');

beforeAll(() => {
  // Fail with the reason, not with a confusing exit code from a missing script.
  expect(existsSync(SCRIPT), `checker script not found at ${SCRIPT}`).toBe(true);
  root = mkdtempSync(join(tmpdir(), 'evt-contract-'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('only real dataLayer pushes count as emitted events', () => {
  it('does NOT treat an ordinary `event:` property as a tracking event', () => {
    // The false-positive class that blocked CI adoption on a fleet site: this is
    // UI data, not a push, so it must not demand a doc entry or a GTM trigger.
    const { code, out } = run({
      src: { 'ui.ts': 'export const items = [{ year: 2024, event: "Milestone" }];\n' },
      docs: docFor(),
      gtm: container([]),
    });
    expect(out).not.toContain('Milestone');
    expect(code).toBe(0);
  });

  it('still catches a genuine push that is undocumented', () => {
    const { code, out } = run({
      src: { 'e.ts': "dataLayer.push({ event: 'foo_happened', v: 1 });\n" },
      docs: docFor(),
      gtm: container(['foo_happened']),
    });
    expect(out).toContain('foo_happened');
    expect(out).toContain('code → docs');
    expect(code).not.toBe(0);
  });

  it('finds a push whose event key sits on a later line', () => {
    // The bounded span crosses newlines, so the scan must run on whole files.
    const { code, out } = run({
      src: { 'e.ts': "window.dataLayer.push({\n  timestamp: Date.now(),\n  event: 'multi_line_event',\n});\n" },
      docs: docFor(),
      gtm: container(['multi_line_event']),
    });
    expect(out).toContain('multi_line_event');
    expect(code).not.toBe(0);
  });

  it('accepts a bare push() helper call', () => {
    const { code } = run({
      src: { 'e.ts': "push({ event: 'bare_push_event' });\n" },
      docs: docFor('bare_push_event'),
      gtm: container(['bare_push_event']),
    });
    expect(code).toBe(0);
  });
});

describe('deliberately GTM-free events', () => {
  const engagementOnly = { 'e.ts': "dataLayer.push({ event: 'cta_click' });\n" };

  it('fails without an exemption (the state that made the check unrunnable)', () => {
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor('cta_click'),
      gtm: container([]),
    });
    expect(out).toContain('has no CUSTOM_EVENT trigger');
    expect(code).not.toBe(0);
  });

  it('passes when declared GTM-free with a reason, and prints the waiver', () => {
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor('cta_click'),
      gtm: container([]),
      exempt: JSON.stringify({ cta_click: 'Engagement-only; must not become a GA4 key event.' }),
    });
    expect(code).toBe(0);
    expect(out).toContain('intentionally has no GTM trigger');
    expect(out).toContain('must not become a GA4 key event');
  });

  it('rejects an exemption with no justification', () => {
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor('cta_click'),
      gtm: container([]),
      exempt: JSON.stringify({ cta_click: '   ' }),
    });
    expect(out).toContain('has no reason');
    expect(code).not.toBe(0);
  });

  it('does NOT waive the documentation requirement', () => {
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor(),
      gtm: container([]),
      exempt: JSON.stringify({ cta_click: 'Engagement-only.' }),
    });
    expect(out).toContain('code → docs');
    expect(code).not.toBe(0);
  });

  it('fails when the exemption is stale — a trigger exists after all', () => {
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor('cta_click'),
      gtm: container(['cta_click']),
      exempt: JSON.stringify({ cta_click: 'Engagement-only.' }),
    });
    expect(out).toContain('the exemption is stale');
    expect(code).not.toBe(0);
  });

  it('warns about a dead exemption but does not fail the build', () => {
    const { code, out } = run({
      src: { 'e.ts': 'export const nothing = 1;\n' },
      docs: docFor(),
      gtm: container([]),
      exempt: JSON.stringify({ gone_event: 'Removed from the UI last quarter.' }),
    });
    expect(out).toContain('dead exemption');
    expect(code).toBe(0);
  });

  it('fails loudly on a malformed exemption file instead of exempting nothing', () => {
    // Silent degradation here would re-open check (2) without anyone noticing.
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor('cta_click'),
      gtm: container([]),
      exempt: '{ this is not json',
    });
    expect(out).toContain('cannot parse');
    expect(code).not.toBe(0);
  });

  it('rejects a JSON array — the shape must be an event→reason map', () => {
    const { code, out } = run({
      src: engagementOnly,
      docs: docFor('cta_click'),
      gtm: container([]),
      exempt: JSON.stringify(['cta_click']),
    });
    expect(out).toContain('must be a JSON object');
    expect(code).not.toBe(0);
  });

  it('treats a missing exemption file as "no exemptions", not an error', () => {
    const { code } = run({
      src: { 'e.ts': "dataLayer.push({ event: 'ok_event' });\n" },
      docs: docFor('ok_event'),
      gtm: container(['ok_event']),
    });
    expect(code).toBe(0);
  });
});
