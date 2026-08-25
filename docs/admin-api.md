# Admin read/ops API

Operatív API a tracking-gateway-hez, a meglévő **`X-Admin-Token`** (`ADMIN_API_TOKEN`
secret) mögött. Ez a backend a korábban elhalasztott P2 tételekhez (#4 replay UI,
#18 admin UI, #19 onboarding validator) — és ez a réteg, amit egy esetleges ops-MCP
vékonyan körbecsomagolhat.

Minden útvonal a `/api/event/admin/*` alatt él (a meglévő zone-route lefedi).
Hostname-alapú tenant-scoping (CLAUDE.md 14.): a lekérdezések a host site_id-jére szűkülnek.

> **Auth**: `X-Admin-Token: <ADMIN_API_TOKEN>`. Hiányzó secret → minden admin-útvonal 401.
> Konstans idejű összehasonlítás (`admin-auth.ts`). A `health-check` SOHA nem ad vissza
> secret-értéket, csak jelenlét/hiány boolean-t.

## GET /api/event/admin-ui (vizuális dashboard)

Önálló, build-mentes egylapos UI, ami a lenti 4 endpointot fogyasztja böngészőből
(`src/routes/admin-ui.ts`). **NEM** az `/api/event/admin/` prefix alatt van, hogy ne
legyen auth-gated — a váz nem tartalmaz secretet; a tokent te írod be, és minden
adat-hívás az `X-Admin-Token` headerrel megy. A token a `sessionStorage`-ben marad
(tab-záráskor törlődik), relatív URL-ek → azon a host-on dolgozik, ahol megnyitod.

```
https://<host>/api/event/admin-ui
```

Szigorú CSP (`default-src 'none'; connect-src 'self'`), minden ledger-adat
`textContent`/DOM-API-val renderelve (XSS-védelem a vendor_message-szerű mezőkre).
Funkciók: health-check (badge-elt tábla), reconciliation (statok + findings tábla),
lead-trail (a 4 ledger-szekció), DLQ replay/discard (kulcs vagy bulk).

## GET /api/event/admin/reconciliation[?hours=24]

On-demand drift-report (a napi cron interaktív megfelelője). `hours` 1..168, default 24.

```bash
curl -s https://<host>/api/event/admin/reconciliation?hours=48 \
  -H "X-Admin-Token: $ADMIN_API_TOKEN"
```

Válasz: `{ window_hours, since, summary: { findings, sites_checked, warning_count,
critical_count, worst }, sites: [...] }`. `503 ledger_unavailable`, ha nincs D1.

## GET /api/event/admin/leads/:lead_id

Egy lead teljes ledger-nyomvonala (audit): `events_raw → deliveries → consent_receipts
→ lead_status`, a host site_id-jére szűkítve.

```bash
curl -s https://<host>/api/event/admin/leads/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-Admin-Token: $ADMIN_API_TOKEN"
```

`400 invalid_lead_id` (nem UUID/opaque), `404 not_configured`, `503 ledger_unavailable`.

## POST /api/event/admin/dlq/replay

Sikertelen kézbesítések (R2 DLQ) újrajátszása vagy eldobása. Az újraküldés
idempotens downstream (event_id / orderId dedup), így nem okoz dupla konverziót.

```bash
# Egy konkrét record újrajátszása kulcs szerint
curl -s -X POST https://<host>/api/event/admin/dlq/replay \
  -H "X-Admin-Token: $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "key": "painless/meta/2026-06-26/12-00-00_evt_0.json" }'

# Do-not-replay: egy record eldobása (consent/policy tiltás miatt)
curl -s -X POST .../dlq/replay -d '{ "key": "...", "discard": true }'

# Bulk replay (opcionálisan site prefixre szűrve)
curl -s -X POST .../dlq/replay -d '{ "site_id": "painless", "max": 50 }'
```

Válasz: `{ action, replayed|attempted, succeeded, failed }`.

## GET /api/event/admin/health-check

Onboarding validator (#19) — a host site config-ját ellenőrzi. Minden check
`PASS | WARN | FAIL`, az `overall` a legrosszabb.

```bash
curl -s https://<host>/api/event/admin/health-check -H "X-Admin-Token: $ADMIN_API_TOKEN"
```

Ellenőrzések: `site_config`, `meta_pixel_id`, `meta_access_token`,
`meta_test_event_code` (WARN ha bent maradt — CLAUDE.md 17.), `ga4_config`,
`gads_conversion_actions`, `gads_oauth` (élő token-csere), `ledger_binding`,
`require_consent` (WARN ha nem fail-closed). Secret-érték SOHA nem szerepel a válaszban.

## GET /api/event/admin/fleet-health

F8 · P12 — **EGY képernyő az egész flottáról.** A `health-check` egyetlen site
CONFIGJÁT nézi; ez minden site-ot végigmér, és MÉRT adatot (D1) is használ.

```bash
curl -s https://<host>/api/event/admin/fleet-health -H "X-Admin-Token: $ADMIN_API_TOKEN"
```

Site-onként 10 dimenzió: `ingest`, `meta`, `google_offline`,
`enhanced_conversions`, `cmp`, `package_version`, `browser_smoke`,
`business_recon`, `gtm_conformance`, `inventory`. Minden dimenzió szintje
`GREEN | YELLOW | RED | UNKNOWN | NOT_APPLICABLE`.

**A nézet egyetlen kemény invariánsa: az UNKNOWN SOHA nem GREEN.** Ebből három
gyakorlati szabály következik, és mindhármat teszt őrzi:

1. **A `null` nem nulla.** Ha egy D1-lekérdezés elbukik (TRK-950-022), az érintett
   dimenzió UNKNOWN lesz — nem „0 konverzió" (ami RED-et adna, tehát hazudna a hiba
   természetéről), és főleg nem zöld.
2. **A `NOT_APPLICABLE` csak EXPLICIT config-elvárásból származhat**
   (`expected_platforms`). Egy KV-ből kiesett `meta` blokk és egy szándékosan
   meta-nélküli site a delivery-sorból nézve azonos — ezért a „nem várjuk" csak
   kimondva érvényes. Kimondás nélkül: UNKNOWN.
3. **A rollupban az UNKNOWN a YELLOW FÖLÖTT van** (RED > UNKNOWN > YELLOW > GREEN):
   a méretlen pénzútról nem tudjuk, mekkora a baj, a sárgáról igen.

Két dimenzió MA ÁLLANDÓ vakfolt, és ez szándékosan látszik: a `gtm_conformance`
offline konténer-exportot igényel (`npm run check:live-gtm`), a runtime `inventory`
(F7) pedig nincs a gateway-be kötve. Ezért ma minden site összesített szintje
legfeljebb UNKNOWN — a mért lábak igazsága viszont dimenziónként látszik, és a
válasz `blind_spots` mezője nevesíti, mit nem mérünk.

A `config_enumeration_complete: false` (részleges KV-felsorolás) KEMÉNYEN UNKNOWN-ra
viszi a flotta szintjét: részlistából nem következik, hogy a nem látott site-ok
rendben vannak. A `monitoring:false` site-ok MEGJELENNEK (jelölve) — egy
flotta-nézetből néma kizárás ugyanaz a hibaosztály lenne.

A HTTP-státusz RED flotta esetén is **200**: ez riport, nem liveness-probe. A gépi
fogyasztó a `fleet_overall` mezőt olvassa. A vizuális változat: `admin-ui` →
„Fleet health (P12)" kártya.

## MCP?

Ez az API a helyes absztrakciós szint. Egy MCP csak vékony wrapper lenne fölötte, és
akkor éri meg megírni, ha a napi ops-műveleteket ismételten Claude Code-on át vezényled
a több site-on. Addig a Cloudflare **D1 MCP** (`d1_database_query`) + a strukturált
error-kódok már most elég a read/diagnose úthoz. A mutáló műveletek (replay/discard)
auditálhatók: a fan-out/retry a ledgerbe ír.
