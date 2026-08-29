#!/usr/bin/env node
// @ts-check
/**
 * Asserts that the browser event vocabulary is in sync between the source code,
 * the canonical docs, and the committed GTM container — for soborbo-tracking v5.
 *
 * The runtime truth is the CODE: events.ts (and components) emit dataLayer events
 * via `push({ event: 'X', ... })`. This check anchors on those and verifies:
 *
 *   1. Every emitted browser event is documented in docs/CANONICAL-EVENTS.md.
 *   2. Every emitted browser event has a `CE - X` (CUSTOM_EVENT) trigger in the
 *      GTM container — unless it is declared GTM-free (see --gtm-exempt below).
 *   3. Every such trigger fires at least one non-paused tag.
 *   4. (warning) GTM CUSTOM_EVENT triggers that no code path emits — possible
 *      dead trigger / drift the other way.
 *
 * Gateway `event_name` values (phone_conversion, contact_form_submit, …) are the
 * SERVER vocabulary and are covered by tests/canonical-events.test.ts; this script
 * is about the BROWSER dataLayer ↔ GTM ↔ docs contract.
 *
 * Failures print a short diff to stderr and exit non-zero. Wire into CI — drift
 * here is invisible at runtime and is a common way tracking silently breaks.
 *
 * It ALSO guards the canonical gateway contract:
 *
 *   5. `../../src/events.json` (the canonical event source, shared in-repo with the
 *      event-gateway worker) must be post-Run-6: it must carry `server_ingress_only`
 *      flags. A malformed or pre-Run-6 events.json fails loudly here instead of
 *      silently reopening the browser path for form conversions.
 *
 * (There is no vendored copy any more: since the soborbo-tracking package was
 * consolidated INTO Serverside, `src/events.json` is the single source of truth, so
 * the old `--engine` byte-diff is gone. The worker-side `server/check-event-contract.mjs`
 * validates that file's internal shape; this script validates the browser contract.)
 *
 * Usage (defaults shown):
 *   node server/check-event-contract.mjs \
 *     --src ./lib,./components \
 *     --events ./docs/CANONICAL-EVENTS.md \
 *     --gtm ./gtm/container.json \
 *     --gtm-exempt ./gtm/no-trigger-events.json
 *
 * `--gtm` is optional; when the file is missing, checks (2)–(4) are skipped.
 *
 * DELIBERATELY GTM-FREE EVENTS (--gtm-exempt, optional file)
 * ---------------------------------------------------------
 * Some events are engagement-only by design: they must NOT become a GA4 key event
 * and must NOT be importable into Ads, so they intentionally have no GTM trigger.
 * Without a way to say so, check (2) leaves the whole script unrunnable in CI —
 * which is worse than a narrow exemption, because then NOTHING is guarded.
 *
 * The file is a flat `{ "<event>": "<why it has no trigger>" }` map. The reason is
 * REQUIRED and must be non-empty: an exemption without a justification is how a
 * real drift gets waved through. An exemption only waives check (2); the event must
 * still be documented (check 1).
 *
 * The exemption list is itself guarded, so it cannot rot into a lie:
 *   - exempt event that DOES have a GTM trigger  → error (the claim is stale;
 *     someone must re-decide, not silently keep the note)
 *   - exempt event that no code path emits       → warning (dead config, mirrors
 *     the symmetric warning in check 4)
 * Exemptions are also printed on success, so they stay visible rather than silent.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values: args } = parseArgs({
  options: {
    src: { type: 'string', default: './lib,./components' },
    events: { type: 'string', default: './docs/CANONICAL-EVENTS.md' },
    gtm: { type: 'string', default: './gtm/container.json' },
    'gtm-exempt': { type: 'string', default: './gtm/no-trigger-events.json' },
  },
});

const CANONICAL_EVENTS_PATH = fileURLToPath(new URL('../../src/events.json', import.meta.url));

const SRC_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.astro'];
// Actual dataLayer pushes only: `push({ event: 'X' ... })` / `dataLayer.push({ … })`.
// Anchoring on a bare `event:` property produced false positives for ordinary UI
// data such as `{ year, event: "Milestone" }` — a documentation-only "drift" that
// cannot be fixed without lying in the docs, so it blocked CI adoption outright.
// The span is bounded (500 chars) and crosses newlines, so this must be matched
// against the WHOLE file text, not line by line.
const EVENT_PUSH_RE = /(?:\bpush|(?:\b[A-Za-z_$][\w$]*\.)?dataLayer\.push)\s*\(\s*\{[\s\S]{0,500}?\bevent:\s*['"]([A-Za-z0-9_.]+)['"]/g;
// GTM bootstrap events that are not tracking events.
const IGNORE_EVENTS = new Set(['gtm.js', 'gtm.dom', 'gtm.load', 'gtm.start']);
// Inline-code spans on markdown list items / table rows (the documented names).
const MD_LINE_RE = /^(?:[-*]\s+|\|).*$/gm;
const INLINE_CODE_RE = /`([A-Za-z0-9_]+)`/g;

async function walk(dir, exts) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of await readdir(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    const st = await stat(path);
    if (st.isDirectory()) out.push(...(await walk(path, exts)));
    else if (exts.includes(extname(name))) out.push(path);
  }
  return out;
}

async function eventsInCode(srcDirs) {
  /** @type {Map<string, string[]>} event -> call sites */
  const found = new Map();
  for (const dir of srcDirs) {
    for (const f of await walk(dir, SRC_EXTENSIONS)) {
      const text = await readFile(f, 'utf8');
      EVENT_PUSH_RE.lastIndex = 0;
      let m;
      while ((m = EVENT_PUSH_RE.exec(text))) {
        const e = m[1];
        if (IGNORE_EVENTS.has(e) || e.includes('.')) continue;
        if (!found.has(e)) found.set(e, []);
        const line = text.slice(0, m.index).split('\n').length;
        /** @type {string[]} */ (found.get(e)).push(`${f}:${line}`);
      }
    }
  }
  return found;
}

async function eventsInDoc(eventsMdPath) {
  const text = await readFile(eventsMdPath, 'utf8');
  /** @type {Set<string>} */
  const out = new Set();
  MD_LINE_RE.lastIndex = 0;
  let line;
  while ((line = MD_LINE_RE.exec(text))) {
    INLINE_CODE_RE.lastIndex = 0;
    let m;
    while ((m = INLINE_CODE_RE.exec(line[0]))) out.add(m[1]);
  }
  return out;
}

/**
 * Loads the deliberately-GTM-free declarations. Missing file = no exemptions (the
 * common case). Shape problems are reported as errors rather than thrown, so a
 * malformed file cannot silently degrade into "nothing is exempt".
 *
 * @param {string} exemptPath
 * @returns {Promise<{ exempt: Map<string, string>, errors: string[] }>}
 */
async function loadExemptions(exemptPath) {
  /** @type {Map<string, string>} event -> reason */
  const exempt = new Map();
  /** @type {string[]} */
  const errors = [];
  if (!existsSync(exemptPath)) return { exempt, errors };

  let parsed;
  try {
    parsed = JSON.parse(await readFile(exemptPath, 'utf8'));
  } catch (e) {
    errors.push(`[gtm-exempt]   cannot parse ${exemptPath}: ${e.message}`);
    return { exempt, errors };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`[gtm-exempt]   ${exemptPath} must be a JSON object of { "event": "reason" }`);
    return { exempt, errors };
  }
  for (const [event, reason] of Object.entries(parsed)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`[gtm-exempt]   '${event}' has no reason — an exemption without a justification is how real drift gets waved through`);
      continue;
    }
    exempt.set(event, reason.trim());
  }
  return { exempt, errors };
}

async function gtmAnalysis(gtmPath) {
  const json = JSON.parse(await readFile(gtmPath, 'utf8'));
  const cv = json.containerVersion ?? json;
  const triggers = cv.trigger ?? [];
  const tags = cv.tag ?? [];

  /** @type {Map<string, string>} triggerId -> event name */
  const eventByTrigger = new Map();
  for (const t of triggers) {
    if (t.type !== 'CUSTOM_EVENT') continue;
    for (const f of t.customEventFilter ?? []) {
      const ps = Object.fromEntries((f.parameter ?? []).map((p) => [p.key, p.value]));
      if (ps.arg0 === '{{_event}}' && ps.arg1) eventByTrigger.set(String(t.triggerId), ps.arg1);
    }
  }

  /** @type {Map<string, number>} triggerId -> non-paused tag count */
  const activeTagsByTrigger = new Map();
  for (const tag of tags) {
    if (tag.paused) continue;
    for (const trId of tag.firingTriggerId ?? []) {
      const k = String(trId);
      activeTagsByTrigger.set(k, (activeTagsByTrigger.get(k) ?? 0) + 1);
    }
  }
  return { eventByTrigger, activeTagsByTrigger };
}

async function main() {
  const srcDirs = args.src.split(',').map((s) => s.trim()).filter(Boolean);
  const codeEvents = await eventsInCode(srcDirs);
  const docEvents = await eventsInDoc(args.events);

  const gtmExists = existsSync(args.gtm);
  /** @type {Map<string, {triggerId: string, activeTagCount: number}[]>} */
  const gtmEvents = new Map();
  if (gtmExists) {
    const { eventByTrigger, activeTagsByTrigger } = await gtmAnalysis(args.gtm);
    for (const [trId, name] of eventByTrigger) {
      if (!gtmEvents.has(name)) gtmEvents.set(name, []);
      /** @type {{triggerId: string, activeTagCount: number}[]} */ (gtmEvents.get(name)).push({
        triggerId: trId, activeTagCount: activeTagsByTrigger.get(trId) ?? 0,
      });
    }
  } else {
    console.warn(`! GTM container not found at ${args.gtm} — skipping checks (2)–(4).`);
  }

  const { exempt, errors: exemptErrors } = await loadExemptions(args['gtm-exempt']);

  const errors = [...exemptErrors];
  const warnings = [];

  // The exemption list must not rot into a lie: every declared event has to be
  // one a code path actually emits.
  for (const event of exempt.keys()) {
    if (!codeEvents.has(event)) {
      warnings.push(`[gtm-exempt]   '${event}' is declared GTM-free but no code path emits it (dead exemption?)`);
    }
  }

  // 5. Canonical events.json sanity: must be the post-Run-6 shape.
  try {
    const canonical = JSON.parse(await readFile(CANONICAL_EVENTS_PATH, 'utf8'));
    const ingressOnly = canonical.filter((e) => e.server_ingress_only === true).map((e) => e.name);
    if (ingressOnly.length === 0) {
      errors.push(
        '[events.json]  no event carries server_ingress_only:true — src/events.json predates Run 6.'
      );
    }
  } catch (e) {
    errors.push(`[events.json]  cannot read/parse src/events.json: ${e.message}`);
  }

  // 1. code → docs
  for (const [event, sites] of codeEvents) {
    if (!docEvents.has(event)) {
      const extra = sites.length > 1 ? ` (and ${sites.length - 1} more)` : '';
      errors.push(`[code → docs]  '${event}' emitted from ${sites[0]}${extra} — not in CANONICAL-EVENTS.md`);
    }
  }

  if (gtmExists) {
    // 2. code → GTM trigger (waived for events declared deliberately GTM-free)
    for (const [event, sites] of codeEvents) {
      if (gtmEvents.has(event) || exempt.has(event)) continue;
      errors.push(`[code → gtm]   '${event}' (${sites[0]}) has no CUSTOM_EVENT trigger in the GTM container`);
    }
    // 2b. A stale exemption is worse than none: it documents a decision that
    // reality has already overruled. Fail so someone re-decides.
    for (const event of exempt.keys()) {
      if (gtmEvents.has(event)) {
        errors.push(`[gtm-exempt]   '${event}' is declared GTM-free but a CUSTOM_EVENT trigger exists — the exemption is stale, remove it or remove the trigger`);
      }
    }
    // 3. GTM trigger → at least one active tag
    for (const [event, triggers] of gtmEvents) {
      const totalActive = triggers.reduce((s, t) => s + t.activeTagCount, 0);
      if (totalActive === 0) {
        errors.push(`[gtm orphan]   trigger for '${event}' (id ${triggers.map((t) => t.triggerId).join(',')}) fires no active tags`);
      }
    }
    // 4. GTM trigger with no code emitter (warning only)
    for (const event of gtmEvents.keys()) {
      if (!codeEvents.has(event)) {
        warnings.push(`[gtm → code]   GTM has a '${event}' trigger but no code path emits it (dead trigger?)`);
      }
    }
  }

  for (const w of warnings) console.warn(`  ! ${w}`);

  if (errors.length === 0) {
    const gtmPart = gtmExists ? `, ${gtmEvents.size} GTM triggers` : '';
    console.log(`✓ Event contract OK — ${codeEvents.size} browser events in code, ${docEvents.size} doc names${gtmPart}`);
    // Print exemptions on success too — a waiver nobody ever sees is a waiver
    // nobody ever revisits.
    for (const [event, reason] of exempt) {
      console.log(`  · '${event}' intentionally has no GTM trigger: ${reason}`);
    }
    process.exit(0);
  }
  console.error(`✗ Event contract drift (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('check-event-contract failed:', err);
  process.exit(2);
});
