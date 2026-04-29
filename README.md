# Soborbo Tracking Worker — Teljes spec (v2)

**Project**: Multi-tenant Cloudflare Worker server-side conversion tracking 15 Astro lead-gen oldalra.

**Cél**: Egyetlen, jól tesztelt, vendor-független server-side tracking infrastruktúra, ami Meta CAPI, GA4 Measurement Protocol, és Google Ads Conversion API-t kezel egységesen. $0/hó hosting (Cloudflare Workers Paid plan-en belül), Stape $20/hó/site helyett.

## Mi újdonság a v2-ben

A v1-hez képest **3 új sprint** beépítve a kezdeti specbe:
- **Sprint 2.5**: Error code taxonómia (production-grade strukturált hibakezelés)
- **Sprint 6.5**: Durable Objects a quote state-hez (strong consistency)
- **Sprint 8.5**: Monitoring, SLO mérés, automatikus admin email/SMS alerting

**1 új sprint** opcionális 2. körre:
- **Sprint 11**: Cookie Keeper (Safari ITP server-set cookies)

## Sprint-bontás

| Sprint | Cél | Idő (Claude Code-dal) |
|---|---|---|
| Sprint 1 | Worker scaffolding | 2-3 óra |
| Sprint 2 | Site config + Turnstile | 3-4 óra |
| **Sprint 2.5** | **Error code taxonómia** ⭐ új | **2 óra** |
| Sprint 3 | Hash + normalize lib | 3-4 óra |
| Sprint 4 | Meta CAPI integration | 4-6 óra |
| Sprint 5 | GA4 Measurement Protocol | 2-3 óra |
| Sprint 6 | Google Ads OAuth2 | 4-6 óra |
| **Sprint 6.5** | **Durable Objects (quote state)** ⭐ új | **6-10 óra** |
| Sprint 7 | Google Ads Conversion Upload | 3-4 óra |
| Sprint 8 | Dead Letter Queue + Cron | 3-4 óra |
| **Sprint 8.5** | **Monitoring, SLO, alerting** ⭐ új | **10-15 óra** |
| Sprint 9 | Astro production integráció Painless-en | 4-6 óra |
| Sprint 10 | Multi-tenant rollout 14 másik site-ra | 1-3 óra/site |
| **Sprint 11** | **Cookie Keeper (Safari ITP)** ⭐ opcionális | **5-15 óra** |

**Alapváltozat (Sprint 1-10 + 2.5/6.5/8.5)**: 50-65 óra Claude Code-dal.
**Sprint 11 opcionális**: csak 4 hét Painless production data alapján.
**Kalendáris**: 5-7 hónap part-time, hetente 5-8 óra.

## Architektúra

```
Astro site (Painless, NemesVent, stb.)
  ├─ Kliensoldali GTM (változatlan): GA4 page_view, Meta Pixel base, scroll
  └─ sendToWorker() helper konverziós eventekhez
       ↓ POST /api/event/conversion
Cloudflare Worker (multi-tenant)
  ├─ Hostname → site_id (KV: SITE_CONFIG)
  ├─ Turnstile validate
  ├─ Hash + normalize user_data (SHA-256)
  ├─ Quote state Durable Object (60-min upgrade window) ⭐
  ├─ Cookie Keeper shadow cookies ⭐ Sprint 11
  └─ Fan-out:
       ├─ Meta CAPI (Graph API v25)
       ├─ GA4 Measurement Protocol
       └─ Google Ads Conversion Upload (OAuth2)
  ├─ Failed → R2 dead-letter → óránkénti Cron retry
  └─ Metrics → Analytics Engine → Grafana ⭐
       └─ Email/SMS alerts ⭐
```

## Mappa-struktúra

```
soborbo-tracking-spec/
├── README.md                             # Ez a fájl
├── CLAUDE.md                             # Critical implementation rules
├── 00-pre-sprint-setup.md                # Manuális Cloudflare-setup
├── 01-sprint-scaffolding.md              # Worker scaffolding
├── 02-sprint-config-turnstile.md         # Site config + Turnstile
├── 02-5-sprint-error-codes.md            # ⭐ Error code taxonómia
├── 03-sprint-hash-normalize.md           # Hash + normalize lib
├── 04-sprint-meta-capi.md                # Meta CAPI integration
├── 05-sprint-ga4-mp.md                   # GA4 Measurement Protocol
├── 06-sprint-gads-oauth.md               # Google Ads OAuth2
├── 06-5-sprint-durable-objects.md        # ⭐ Durable Objects
├── 07-sprint-gads-conversion.md          # Google Ads Conversion Upload
├── 08-sprint-dlq-cron.md                 # DLQ + Cron retry
├── 08-5-sprint-monitoring-alerting.md    # ⭐ Monitoring + alerting
├── 09-sprint-astro-painless.md           # Painless production integráció
├── 10-sprint-multi-tenant-rollout.md     # 14 site rollout
├── 11-sprint-cookie-keeper.md            # ⭐ Cookie Keeper (opcionális)
└── ASTRO-FRONTEND-SPEC.md                # 17-event Astro tracking spec
```

## Fejlettségi szint

| Dimenzió | v1 (Sprint 1-10) | v2 (+ 2.5/6.5/8.5) |
|---|---|---|
| Funkcionális teljesség | 8/10 | 8/10 |
| Reliability | 6/10 | **8/10** |
| Security | 6/10 | 6/10 |
| Performance | 8/10 | **9/10** |
| Maintenance burden | 5/10 | **7/10** |
| GDPR/compliance | 7/10 | 7/10 |
| Observability | 4/10 | **9/10** |
| **Összpontszám** | **6.5/10** | **7.7/10** |

Stape ehhez képest ~8.5/10 (kifinomultabb, de havi $300 plus). Hand-coded enterprise stack ~9.5/10 (overkill Painless-méretben).

## Költség

| Tétel | Költség |
|---|---|
| Cloudflare Workers Paid plan | $5/hó (már van) |
| Workers KV | $0 (10M-ig benne) |
| R2 bucket | $0 (10 GB-ig benne) |
| Durable Objects | <$1/hó Painless-volumenre |
| Workers Analytics Engine | $0 (10M data points/hó) |
| Cloudflare Email Routing | $0 (ingyenes) |
| Twilio SMS (kritikus alert-ek) | ~$2-5/hó (opcionális) |
| Grafana Cloud | $0 (free tier) |
| **Total** | **~$8-11/hó (15 site-ra együtt)** |

Stape: $20 × 15 site = $300/hó. **~$290/hó megtakarítás** (idő-érték nélkül).

## Hogyan használd

1. Olvasd el a `CLAUDE.md`-t — kritikus rules document
2. Csináld meg a `00-pre-sprint-setup.md`-t — manuális Cloudflare lépések
3. Sprint 1-2 (scaffolding + Turnstile, kockázatmentes)
4. Sprint 2.5 (error code taxonómia, cross-cutting)
5. Sprint 3-8 + 6.5 (Worker stack)
6. **Sprint 8.5 (monitoring) MIELŐTT Sprint 9 production deploy**
7. Sprint 9 (Painless production, első kockázatos sprint)
8. Sprint 10 (14 site rollout)
9. Sprint 11 (Cookie Keeper, **csak ha 4 hét Painless data <8 EMQ**)

## Rollback plan

- Sprint 1-8 + 2.5/6.5: a Worker még nem érint production user-eket
- Sprint 8.5: monitoring nem érinti fan-out-ot, eltávolítható
- Sprint 9: Painless GTM backup JSON-ből 5 perc alatt visszaállítható
- Sprint 10: ugyanaz, per site
- Sprint 11: KV-flag-gel ki/be kapcsolható

## Kritikus döntés Painless-re

A Sprint 9 előtt:

**Opció A — Worker-rel megy Painless azonnal**: 5-7 hónap beruházás, $0/hó, Painless tanulási kockázat.

**Opció B — Painless Stape Pro ($16/hó), Worker POC BeautyFlow-n**: Painless stable, Worker tanulás low-stake. 3-6 hónap után átköltöztetés.

**Opció B az ajánlott**, kivéve ha vállalod a Painless production tanulási kockázatát.

## Mi nem tartozik ehhez

- Stape sGTM hosting (alternatíva)
- Cloudflare Zaraz (kifejezetten visszadobva)
- Custom Loader / ad blocker bypass (3. kör)
- Server-side Consent Mode v2 Advanced (3. kör)
- TikTok / LinkedIn CAPI (demand-driven)
