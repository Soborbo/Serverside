# GO-LIVE checklist — event-gateway

**Cél:** mire egy site (elsőként Painless, Sprint 9) éles forgalmat küld a
Worker-nek, MINDEN alábbi sor `[x]`. A staging/test-deploy alatt szándékosan sok
binding ki van kommentelve (`wrangler.toml`) — a kód guardolt, no-op marad nélkülük,
de **éles forgalomnál ezek aktiválása nem opcionális.** Minden pont igen/nem.

A kódszintű szabályok forrása: `CLAUDE.md`. Ez a fájl a **deploy/infra** kapuk
listája — nem helyettesíti a `CLAUDE.md`-t, hanem operatívan kikényszeríti.

---

## A. Infra-binding aktiválás (`wrangler.toml`)

- [ ] **Routes** — az adott site `[[routes]]` blokkja aktív (nincs kommentben),
      `zone_name` helyes. Nélküle a gateway nem szolgálja ki a saját domainről az
      `/api/event/*`-ot (csak a `workers.dev` URL él). (CLAUDE.md #14, #19)
- [ ] **Cron triggers** — a `[triggers] crons` blokk aktív. Ez kapcsolja be:
      daily-digest, reconciliation, SLO-check, **retention cleanup (3:30)**, DLQ-retry.
- [ ] **Email binding** (`[[send_email]] ADMIN_EMAIL`) — a destination cím
      (`laszlo@soborbo.com`) Cloudflare Email Routing-ban **verifikálva**, a blokk
      aktív. Nélküle a digest/SLO/reconciliation alert csak logba megy (soft-skip).
- [ ] **Rate limiting** (`[[ratelimits]] INGEST_LIMITER`) — aktív. Nélküle csak a
      Turnstile véd az ingestion végponton. (Opcionális: `DEGRADED_LIMITER`,
      `ADMIN_LIMITER`.)
- [ ] **Queues** (opcionális, H1) — ha natív Queues-retry kell: a 3 queue-blokk
      aktív + `wrangler queues create event-gateway-dlq{,-dead}` lefutott. Ha nem,
      az R2-fallback + óránkénti cron viszi a retry-t (ez is elég KKV-skálán).

## B. GDPR / adat-rezidencia (hard gate)

- [ ] **R2 DLQ EU jurisdikció** — a `DEAD_LETTER` bucket EU-jurisdikciós.
      A DLQ NYERS PII-t tárol → tilos default/ENAM bucketben EU-érintettnél. Állapot:
      1. ✅ **KÉSZ:** `soborbo-tracking-dlq-eu` létrehozva (location **EEUR**, 2026-06-27,
         `wrangler r2 bucket create ... --jurisdiction eu`). A jurisdikció CSAK
         létrehozáskor állítható; a Cloudflare MCP figyelmen kívül hagyja → wrangler kell.
      2. ✅ **N/A:** a régi `soborbo-tracking-dlq` (ENAM) 9 objektuma igazoltan
         **csak teszt** (site_id `test-painless`, 2026-04-29, szintetikus event_id-k,
         mind a 24h retry-ablakon kívül) → a swap semmi élőt nem árvít el. Nincs drain.
      3. ✅ **KÉSZ a kódban:** `wrangler.toml` `DEAD_LETTER` binding már az EU-bucketre
         mutat (`claude/r2-dlq-eu-jurisdiction` PR). **Hátra van:** merge + a következő
         `wrangler deploy` (a Painless go-live deploy vigye be, NE staging-mode main-ből).
      4. ⏳ **Opcionális:** tiszta ablak után a régi ENAM bucket törlése
         (`wrangler r2 bucket delete soborbo-tracking-dlq`) — csak teszt-archívum.
- [ ] **D1 ledger EU** — az `event-gateway-ledger` D1 `weur` (EU). ✅ már EU
      (created 2026-06-26), csak igazold deploy előtt.
- [ ] **Retention env** — beállítva (vagy tudatosan a 90-napos default elfogadva):
      `RETENTION_DAYS` (operatív táblák + R2 'dead', default 90). A
      `consent_receipts` / `lead_status` alapból MEGMARAD; ha jogi megőrzési ablak
      kell, `CONSENT_RETENTION_DAYS` / `LEAD_RETENTION_DAYS` explicit. (#8/#9)

## C. Secrets

- [ ] `TURNSTILE_SECRET_KEY` beállítva — **enélkül minden `/api/event/conversion`
      403** (fail-closed, CLAUDE.md #10). Ez az EGYETLEN core-secret. `TURNSTILE_FAILOPEN`
      prod-ban **NEM** `1`.
- [ ] `ADMIN_API_TOKEN` beállítva (admin API/UI + lead-status auth).
- [ ] Google Ads útvonalhoz: `GADS_OAUTH_CLIENT_ID` / `GADS_OAUTH_CLIENT_SECRET` /
      `GADS_DEVELOPER_TOKEN` + az OAuth refresh-token feltöltve (`oauth-init` flow).
- [ ] (Opc.) Twilio SMS alert: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`.

## D. Per-site KV config (`SITE_CONFIG`)

- [ ] A site config bekerült (`wrangler kv:key put --binding=SITE_CONFIG "<host>" '...'`),
      hostname pontos. Hibás/hiányzó config → 404, **nincs fallback** (CLAUDE.md #14).
- [ ] **`test_event_code` ELTÁVOLÍTVA** a Meta configból — ha bent marad, minden
      valós konverzió a Meta **Test** stream-be megy, nem a fő riportba (csendes hiba,
      CLAUDE.md #17). Hard gate.
- [ ] Customer ID-k formátuma helyes: Google Ads 10 számjegy dashes nélkül (CLAUDE.md #4),
      Meta pixel ID stb.

## E. Kliensoldal (Astro / GTM)

- [ ] `client-lib/` bemásolva, Turnstile widget él, az `event_id` **shared** mind a
      3 platformon (CLAUDE.md #16).
- [ ] **GA4 dupla-mérés guard** — ha a böngészős GA4 (gtag/GTM) MÁR fut a site-on,
      a gateway GA4 MP blokkját ki kell hagyni, KÜLÖNBEN dupla event. (Audit P1 #7)
- [ ] `dataLayer.push` **NEM** tartalmaz PII-t (CLAUDE.md #15).

## F. Verifikáció (deploy után, go-live ELŐTT)

- [ ] `GET /api/event/health` → 200.
- [ ] curl smoke-test minden konfigurált platformra (Meta Test Events / GA4 DebugView).
- [ ] Cloudflare Workers logs **24 órán át tiszták** (CLAUDE.md #20).
- [ ] CI zöld a release-commiton (`.github/workflows/ci.yml`: typecheck + 273+ teszt).
- [ ] Conversion-drop alert / SLO-check ténylegesen küld (Twilio/email próbariasztás).

---

### Rollback

Ha go-live után conversion-drop vagy hibaspike: a route-blokk visszakommentelése +
redeploy azonnal leveszi a site-ot a gateway-ről (visszaesik a böngészős mérésre),
amíg a hiba megvan. (CLAUDE.md #19)
