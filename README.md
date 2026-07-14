# Soborbo Tracking Worker — event-gateway

**Project**: Multi-tenant Cloudflare Worker server-side conversion tracking a Soborbo lead-gen site-okra (élő: **painless, beautyflow, lomtalan**).

**Ez a dokumentum a JELENLEGI, deployolt modellt írja le.** A repót AI-runok fejlesztik: ha ennél a fájlnál régebbi architektúra-leírást találsz (Turnstile-kapu, on-site szerver GA4, on-site szerver Google Ads, quote-state Durable Object), az TÖRÖLT funkció — ne építsd újra. A sprint-fájlok (`0*-sprint-*.md`) történeti tervdokumentumok, nem az aktuális állapot.

## A jelenlegi modell (2026-07, Run 6 után)

```
Site backend (painless / beautyflow / lomtalan Astro worker)
  └─ lead-endpoint → sendGatewayConversion()
       ↓ SERVICE BINDING (env.GATEWAY / env.EVENT_GATEWAY)
       ↓ POST /api/event/conversion-server  +  X-Admin-Token (per-site token)
Böngésző (kliens)
  ├─ Meta Pixel + GA4 + Google Ads tag: KÖZVETLENÜL a vendorhoz (GTM), nem rajtunk át
  └─ sendToWorker() CSAK low-risk klikk-eventekre
       ↓ POST /api/event/conversion  (tokenless, Origin-gate + IP rate limit)
event-gateway Worker (multi-tenant)
  ├─ Hostname → site config (KV: SITE_CONFIG)
  ├─ Hash + normalize user_data (SHA-256, CLAUDE.md #1)
  ├─ Idempotencia + D1 ledger (events_raw / deliveries / consent_receipts)
  └─ Fan-out (Promise.allSettled):
       ├─ Meta CAPI (Graph API, event_id dedup a Pixel-lel)
       └─ click-ID forwarderek (TikTok / LinkedIn / MsAds — csak ha van click ID + config)
  ├─ Hiba → Cloudflare Queue → R2 DLQ fallback → cron retry
  └─ Metrics → Analytics Engine; alerting → email/SMS; napi reconciliation a ledger fölött

CRM offline-loop
  └─ POST /api/event/lead-status (per-site token)
       └─ Google Ads Enhanced Conversions for Leads → Data Manager API (events:ingest)
```

### A két ingress-út és ami rajtuk mehet

| Útvonal | Auth | Mi mehet rajta |
|---|---|---|
| `/api/event/conversion` (böngésző) | nincs token; Origin allow-list + IP rate limit | CSAK low-risk klikk-eventek: `phone_number_clicked`, `email_address_clicked`, `whatsapp_button_clicked`, `video_play`, engagement events |
| `/api/event/conversion-server` (szerver) | per-site token (`X-Admin-Token` ↔ KV `crm_token_sha256`) | a high-value konverziók: `quote_calculator_submitted`, `callback_request_submitted`, `contact_form_submitted`, `order_request_submitted`, `purchase` |
| `/api/event/lead-status` (CRM) | per-site token | offline lead-státuszok (`lead_qualified`, `booking_confirmed`, `revenue_confirmed`, …) |

A high-value eventek a böngésző-úton **403**-at kapnak (`TRK-400-017`): az Origin curl-ből hamisítható, és a Workers rate-limit binding bizonyítottan nem throttle-olt — e nélkül bárki hamis lead-konverziót lőhetne tetszőleges hash-elt email/telefonnal. A böngésző-Pixel ugyanazzal az `event_id`-vel tüzel tovább → a Pixel/CAPI dedup ép. A lista az `events.json` `server_ingress_only` flagjéből származik.

### Kritikus, tapasztalatból fizetett szabályok

1. **Service binding, NEM same-zone route fetch.** A site worker a gateway-t service bindingon hívja (`env.GATEWAY.fetch(...)`). Same-zone HTTPS fetch a saját zóna route-jára a Cloudflare loop-védelme miatt rövidre zárul — csendben.
2. **Test event code KIZÁRÓLAG per-request.** A szintetikus proof-event a body `test_event_code` mezőjével megy (csak hitelesített szerver-hívótól fogadjuk el). SOHA nem a KV site-configba írva: a config edge-cache-elt (300s), és a cache-ablakban valódi leadek mennének a Meta Test streambe (két production Meta-leak történt így).
3. **A ledger nem hazudhat.** A `deliveries` státusz három-állapotú: `accepted` (vendor HTTP-státusszal — enélkül SOHA), `skipped` (szándékos kihagyás: nincs config / consent-tiltás), `rejected`. Skip-út mindig `{ success: true, skipped: true }`-t ad vissza. Az invariánst a `normalizeDelivery` kényszeríti (`TRK-950-004`).
4. **Hármas kiesés ≠ dispatched.** Ha a platform-hívás ÉS a Queue ÉS az R2 is elbukik, az event `dispatched=0` marad (`TRK-900-007` critical alert) — így egy kliens-retry még újrakézbesíthet.
5. **204 csak a böngésző-beaconnek.** A szerver-szerver útvonalak (conversion-server, lead-status, admin, OAuth) hibánál 500-at adnak, hogy a hívó retry-olhasson.
6. **Nincs on-site szerver GA4 és nincs on-site szerver Google Ads.** A GA4-et és a Google Ads on-site konverziót a böngésző birtokolja (GTM). A szerver Google Ads-lába KIZÁRÓLAG offline (lead-status → Data Manager API). Az offline GA4-leg kikapcsolva (client_id nélkül minden esemény új szintetikus GA4-clientbe esett volna).
7. **Nincs Turnstile a gateway-ben.** Kikerült (a secret a Cloudflare teszt-kulcsa volt → nulla védelem, miközben valódi konverziókat nyelt el). A böngésző-ág kapuja az Origin allow-list + rate limit + a high-value gate; a szerver-ágé a per-site token.
8. **Nincs quote-state Durable Object.** Törölve (wrangler migráció v2): az alarm némán ejthetett state-et, és egy event jelentését írta át utólag. A `quote_calculator_submitted` azonnal fan-outol.

### Szintetikus tesztelés

Kizárólag a hitelesített szerver-ingressen, per-request `test_event_code`-dal — SOHA nem böngésző-úton, SOHA nem KV-be írt test-koddal. A proof: D1 ledger-sor + Meta Test Events találat + üres DLQ.

## Mappa-struktúra (aktuális)

```
├── README.md                  # Ez a fájl — a JELENLEGI modell
├── CLAUDE.md                  # Kritikus implementációs szabályok (hash, formátumok, tilalmak)
├── src/
│   ├── worker.ts              # Routing + queue consumer + cron
│   ├── events.json            # Kanonikus event-kontraktus (single source of truth)
│   ├── routes/                # conversion, lead-status, admin, health, oauth
│   ├── lib/                   # meta, datamanager, hash, ledger, deadletter, origin, …
│   └── scheduled/             # retry, daily-digest, slo-check, reconciliation, retention
├── client-lib/                # Böngésző-oldali sendToWorker/trackConversion helper
├── tests/                     # vitest (npm test)
├── migrations/                # D1 ledger séma
├── scripts/                   # site onboarding (generate-site.mjs), bootstrap
├── docs/                      # error-codes.md, admin-api.md, ledger-offline-loop.md, …
└── 0*-sprint-*.md             # TÖRTÉNETI sprint-tervek — nem az aktuális állapot
```

## Üzemeltetés

- Deploy: `npm run deploy` (wrangler). A worker neve `event-gateway`.
- Tesztek: `npm test` (vitest), `npm run typecheck`, `npm run check:events` (event-kontraktus guard).
- Monitoring: Analytics Engine metrikák, napi digest + reconciliation email, SLO-check 30 percenként, `docs/error-codes.md` a runbook.
- Site onboarding: `scripts/generate-site.mjs` + KV `SITE_CONFIG` bejegyzés — lásd `.claude/skills` `onboard-site`.
