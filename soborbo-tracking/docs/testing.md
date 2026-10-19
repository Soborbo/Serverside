# Testing Checklist

> **THE ONE RULE ABOVE ALL: no live-pixel browser testing.** Never submit a real
> form / fire a real conversion on a production site "to see it in Meta" — two
> production Meta leaks came from exactly that. Synthetic proof goes through the
> **authenticated server ingress with the per-request test code** — that is what
> the daily smoke cron does (section 11), and `server/smoke-test.sh` covers the
> gate behavior without any vendor call. GTM Preview / Tag Assistant on a
> staging/dev URL is fine (browser-leg only, no server dispatch on unknown hosts).

## 1. Consent

- [ ] Banner appears on first visit
- [ ] Reject all → no `sb_` keys in localStorage or sessionStorage
- [ ] No events in GTM Preview before consent
- [ ] Accept analytics → scroll/step events fire, no localStorage writes
- [ ] Accept marketing → `sb_tracking` in localStorage, click beacons sent
- [ ] Consent change without page reload → tracking activates immediately

## 2. Submit — Single Event (browser leg + hidden-field handoff)

- [ ] One click = exactly one `quote_calculator_submitted` in dataLayer
- [ ] No recursion (form submits once, handler runs once)
- [ ] Invalid form → browser validation, NO tracking
- [ ] Valid form → hidden fields populated (incl. `event_id`) → POST to action URL
- [ ] `event_id` is a full UUID format
- [ ] **No `/api/event/conversion` POST on form submit** — form conversions are
      server-ingress-only; a browser POST here is the TRK-1005 wiring bug
- [ ] **No raw PII in the dataLayer** (no `email` / `phone_number` /
      `user_provided_data`) — PII goes to the hidden side-channel
      (`window.__sbUserData` / `#__sb_user_data__`)
- [ ] The BACKEND (API route) dispatches `sendGatewayConversion` with the SAME
      `event_id` from the hidden field, and passes the CRM's id as `lead_id`

## 3. Submit — Multi-Button

- [ ] Two submit buttons with different name/value pairs
- [ ] Click button A → backend receives button A's name/value
- [ ] Click button B → backend receives button B's name/value

## 4. Two Forms on One Page

- [ ] Each form has independent abandon timer
- [ ] Submitting form A ≠ cancel abandon on form B
- [ ] Each fires its own conversion event (no crosstalk)

## 5. View Transitions (Astro)

- [ ] Navigate → tracking re-inits
- [ ] Scroll to 50% = exactly one event (no stacking)
- [ ] Phone links on new page bound correctly
- [ ] Abandon timer from old page cleaned up

## 6. Form Abandonment

- [ ] Focus field → wait 60s → `form_abandoned` with `last_field`
- [ ] Submit before 60s → no abandon event
- [ ] Route change before submit → abandon timer cleaned up

## 7. Clicks — phone / email / whatsapp (both channels) + callback (dataLayer only)

- [ ] Click tel: → `phone_number_clicked` (dataLayer) **and** a
      `/api/event/conversion` POST, same `event_id`
- [ ] Click again same session → no duplicate on EITHER channel (session dedup)
- [ ] Check sessionStorage `sb_click_phone_*`
- [ ] mailto: link → `email_address_clicked` on both channels
- [ ] WhatsApp link (wa.me / *.whatsapp.com) → `whatsapp_button_clicked` on both
- [ ] **Callback CTA → dataLayer `callback_request_submitted` ONLY, NO gateway
      POST** (server-ingress-only; the browser POST would 403 — if the callback is
      a form POST, the backend sends the server leg)
- [ ] Marketing-only consent (analytics denied) → gateway click conversion STILL
      fires, no dataLayer event
- [ ] Analytics-only consent (marketing denied) → dataLayer event fires, NO gateway POST

## 8. Calculator Funnel

- [ ] Start → step → option → complete all fire with session_id
- [ ] Funnel numbers in GA4 make sense (start ≥ complete)

## 9. Attribution

- [ ] Visit with `?gclid=xxx` → accept consent → check `sb_first_touch`
- [ ] Second visit with different UTM → first touch unchanged, last touch updated
- [ ] Conversion event includes both first_* and last_* fields

## 10. Gateway gates (no vendor calls — `server/smoke-test.sh` automates this)

- [ ] `/api/event/health` → 200 `{"status":"ok"}`
- [ ] Browser path, malformed JSON → 204 (silent drop; beacons don't read bodies)
- [ ] Browser path, missing Origin → 403 (fail-closed allow-list)
- [ ] Browser path, gated event (`contact_form_submitted`) → 403 (TRK-400-017)
- [ ] Browser path, allowed click event + allowed Origin → 204 (404 = host not in KV)
- [ ] Server ingress, missing/wrong `X-Admin-Token` → 401 (no browser fallback)
- [ ] Server ingress, valid token → 204, D1 ledger row written
- [ ] Rate limit exceeded → 429

## 11. End-to-end synthetic proof (the smoke chain — replaces live-pixel testing)

- [ ] Site worker vars set: `TRACKING_SITE_ID`, `TRACKING_TEST_LEAD_EMAIL`,
      `TRACKING_TEST_EVENT_CODE`, `TRACKING_GATEWAY_TOKEN`, `SITE_URL`; cron in
      the generated wrangler.json
- [ ] Trigger once (`wrangler dev --test-scheduled` → `/__scheduled`, or wait for
      04:4x UTC) → worker log: `[smoke] daily synthetic lead dispatched`
- [ ] D1 ledger: `SELECT platform,status,http_status FROM deliveries WHERE event_id
      LIKE 'smoke-<site>-%'` → `meta | accepted | 200` (or `skipped` if the site
      has no Meta block). **`accepted` with NULL http_status = bug (TRK-950-004).**
- [ ] Meta Events Manager → Test Events tab: the smoke event appears (Server source)
- [ ] Gateway daily digest lists the site with no smoke alarm (`SMOKE_SITES`)
- [ ] Re-trigger the cron the same day → NO second ledger row (idempotency on the
      deterministic `smoke-<site>-YYYYMMDD` id)

## 12. Bot guard (backend)

- [ ] Honeypot filled → endpoint returns success-shaped response, but NO CRM
      forward, NO gateway dispatch, NO ledger row
- [ ] Sub-human-speed submit (time-check) → same silent drop
- [ ] Real submit → full chain runs

## 13. Edge Cases

- [ ] Safari private mode → no errors, graceful degradation
- [ ] URL params captured before consent, persisted after
- [ ] Phone with spaces/brackets → normalized correctly
- [ ] Multiple tabs → session shared via sessionStorage
- [ ] `?debugTracking=1` → events logged to console

## Debug

**No events**: Console errors? Is dataLayer defined? Consent granted?
**TRK-1005 in the console**: a gated event is wired to the browser path — move the
dispatch to the form's API route (`server/backend/README.md`).
**TRK-1006**: the gateway rejected the browser POST — check the Origin allow-list,
the SITE_CONFIG KV entry for this hostname, and the rate limit.
**Backend dispatch failing**: check `TRACKING_GATEWAY_TOKEN` (401 = hash mismatch
with the KV `crm_token_sha256`), the `[[services]]` binding (a plain fetch to your
own zone silently short-circuits), and the gateway worker logs (`wrangler tail`).
**Double submit**: Check the `isSubmitting` guard. `requestSubmit()` re-fires the
submit event once — the guard makes the second pass a no-op.
**Attribution missing**: Consent given before URL changed? Check `sb_first_touch`.
