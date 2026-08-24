# Site inputs — pre-filled generator inputs

Ready-to-fill inputs for the canonical generator (`../../scripts/generate-site.mjs`,
repo root: `scripts/generate-site.mjs`), with the **non-secret IDs already gathered**.

> **⚠️ LIVE SITES ARE NOT HERE, ON PURPOSE.** `painless`, `beautyflow`, and
> `lomtalan` are wired and in production, and their configs carry secrets.
>
> Regenerating a live site's config is now SAFE with respect to the token —
> feed the live `crm_token_sha256` back in and it is passed through verbatim, so
> nothing is rotated and no deploy secret has to change (see "Regenerating a live
> site" below). Without it the generator still mints a NEW token and refuses to
> run unless you pass `--new-site` / `--rotate-token`; uploading THAT config
> breaks the site's backend dispatch and CRM loop until every deploy secret is
> rotated to match. Always `wrangler kv key get` + diff the live entry first.

## Regenerating a live site (the round-trip contract)

Since 2026-08-24 the generator is **lossless**: the input shape IS the KV
`SiteConfig` shape plus `hostnames`, and every field the schema knows
(`soborbo-tracking/server/site-config.schema.json`) is passed through. Before that
fix, `consent`, `consent_strict`, `recon` and `monitoring` were **silently
dropped** — regenerating an sbo consent-pilot site would have flipped it back to
CookieYes with no error and no alert.

```bash
# 1. Pull the live config (it IS the generator input, minus `hostnames`)
wrangler kv key get --namespace-id $NS "example.com" > /tmp/live.json

# 2. Add hostnames, edit what you actually want to change, keep crm_token_sha256
# 3. Regenerate — no --new-site, no --rotate-token, no token rotation
node scripts/generate-site.mjs --input /tmp/live.json --out /tmp/out

# Fleet-wide check that no field would be lost (NEVER redirect the dump to a file —
# it contains plaintext access tokens):
node scripts/fetch-kv-configs.mjs $NS | node scripts/roundtrip-check.mjs
```

The contract is enforced in CI by `tests/generator-roundtrip.test.ts`:
`parse(live) → generate → parse(generated) → semantic_equal(live)`.

**Adding a new `SiteConfig` field?** Add it to `site-config.schema.json` in the
same change. The generator takes its pass-through list from there — a field that
is missing from the schema is a field that vanishes from KV on the next
regeneration, and the schema-drift test will fail.

> `_comment*` keys are carried through into the KV config (the schema permits them
> at every level, and round-trip losslessness requires it). Keep them meaningful —
> whatever you write in an input file ends up in the live KV value.

## How to use (for a NEW / unwired site)

1. Copy the input, fill the `REPLACE_ME_*` fields **outside git**:
   - `meta.access_token` — Meta Events Manager → Conversions API → System User token.
2. Run the canonical generator from the Serverside repo root:
   ```bash
   node scripts/generate-site.mjs --input /tmp/trapezlemezes.json --out /tmp/trapez-out --new-site
   ```
   It validates and emits `site-config.json`, `routes.toml`, `kv-put.sh`,
   `crm-secret.env` (SAVE THE TOKEN — the KV stores only its hash), and
   `INTEGRATION.md` for **all hostnames** (apex + www). See `../SETUP-SERVER.md`.
3. **Do NOT commit the filled-in secrets.**

## Rules the generator enforces (do not fight them)

- **No `test_event_code` in the input.** The KV config is edge-cached; a test code
  in it has twice routed real production conversions into Meta's Test stream. The
  sanctioned test mechanism is the PER-REQUEST code keyed on
  `TRACKING_TEST_LEAD_EMAIL` (see `../backend/`). The `--allow-test-event-code`
  opt-in still exists for a deliberate throwaway test config, but it no longer
  produces a production-usable output: the KV script is written as
  `kv-put.TEST-EVENT-CODE.sh` and **exits 1 when run** unless
  `SBO_ALLOW_TEST_EVENT_CODE_KV_WRITE=1` is set by hand.
- **`conversion_actions` keys are canonical event names only** — and under
  Model 2 they should be the OFFLINE CRM events (`lead_qualified`,
  `booking_confirmed`, `revenue_confirmed`, …). The legacy on-site action IDs
  (phone_conversion & co.) are browser-owned (AWCT) and don't belong in the
  gateway config. Create the offline actions in Google Ads first.
- **No `ga4` block for new sites** — the gateway sends no GA4 at all.
- **`require_consent: true` on consent-required markets** (`GB`, `HU`, `EU`, `DE`,
  `FR`, `IT`, `ES`) when marketing tracking is on. This is a HARD ERROR for a new
  site (`--new-site`), a loud warning when regenerating an existing one. `GB` is in
  that set: the UK is not in the EEA, but PECR + UK GDPR still require prior
  consent for cookie-based marketing tracking.
- **Unknown input fields are a hard error.** A typo like `expected_platform`
  (singular) used to vanish without a trace.
