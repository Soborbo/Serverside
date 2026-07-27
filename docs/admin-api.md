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
lead-trail (a 4 ledger-szekció), DLQ replay/discard (kulcs vagy bulk), és a
**dead-record lista** („List dead records" → táblázat + „Use key" gomb, ami az R2
kulcsot a replay-mezőbe tölti; a „Bulk replay (DEAD)" az egész archívumot viszi).

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

## GET /api/event/admin/dlq/dead[?site_id=&max=100]

A **dead archívum** (`{site}/{platform}/dead/…`) tartalma — a retry-keretüket
kimerített, SOHA le nem kézbesített konverziók. Ez a végpont teszi a „Dead
records: N" riasztást követhetővé: a single replay pontos R2-kulcsot vár, a bulk
replay pedig szándékosan átugorja a dead kulcsokat (`listPendingRetries` →
`isDeadKey`), tehát a kulcs korábban sehonnan nem volt megtudható.

```bash
curl -s "https://<host>/api/event/admin/dlq/dead?max=100" \
  -H "X-Admin-Token: $ADMIN_API_TOKEN"
```

Válasz: `{ count, truncated, corrupt_keys: [...], records: [{ key, site_id,
platform, event_id, event_name, lead_id, failure_reason, blocked_configuration,
retry_count, first_failed_at, last_attempted_at, age_days }] }`.

`max` 1..500 (default 100), `site_id` **segment-prefix** szűrő (nem substring).
A válasz **PII-mentes**: sem hash-elt `user_data`, sem nyers `event_payload` nem
megy ki rajta (CLAUDE.md 13.). `503 dlq_list_failed`, ha az R2-listázás elbukik —
soha nem hamis „nincs dead rekord".

## POST /api/event/admin/dlq/replay

Sikertelen kézbesítések (R2 DLQ) újrajátszása vagy eldobása. Az újraküldés
idempotens downstream (event_id / orderId dedup), így nem okoz dupla konverziót.

```bash
# Egy konkrét record újrajátszása kulcs szerint (pending VAGY dead)
curl -s -X POST https://<host>/api/event/admin/dlq/replay \
  -H "X-Admin-Token: $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "key": "painless/meta/2026-06-26/12-00-00_evt_0.json" }'

# Do-not-replay: egy record eldobása (consent/policy tiltás miatt)
curl -s -X POST .../dlq/replay -d '{ "key": "...", "discard": true }'

# Bulk replay — PENDING rekordok (opcionálisan site prefixre szűrve)
curl -s -X POST .../dlq/replay -d '{ "site_id": "painless", "max": 50 }'

# Bulk replay — a DEAD archívum (a `dlq/dead` listával azonos halmaz)
curl -s -X POST .../dlq/replay -d '{ "dead": true, "site_id": "painless", "max": 50 }'
```

Válasz kulcs szerint: `{ action, key, replayed, succeeded, outcome, skipped }`.
Bulk: `{ action, scope: "pending"|"dead", attempted, succeeded, failed, skipped, suppressed }`.

**`outcome` / a rekord sorsa:**

| outcome | jelentés | R2-objektum |
|---|---|---|
| `replayed` | valódi vendor-kézbesítés (`accepted` ledger-sor) | törölve |
| `skipped` | a platform-config épp hiányzik → hívás NEM történt | **megmarad** |
| `suppressed` | `do_not_replay=1` (consent-visszavonás / korábbi discard) → HTTP **409** | **megmarad** |
| `failed` | vendor-bukás | **megmarad** |

A `do_not_replay` kapu MINDEN replay-utat blokkol (single és bulk) — enélkül a
dead-bulk pont azokat az eventeket támasztaná fel, amiket valaki szándékosan
eltiltott. A kapu read-only (`isDoNotReplay`, SELECT — nem mozdítja az
idempotencia-állapotot), és D1-hiba esetén **fail-closed**.

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

## MCP?

Ez az API a helyes absztrakciós szint. Egy MCP csak vékony wrapper lenne fölötte, és
akkor éri meg megírni, ha a napi ops-műveleteket ismételten Claude Code-on át vezényled
a több site-on. Addig a Cloudflare **D1 MCP** (`d1_database_query`) + a strukturált
error-kódok már most elég a read/diagnose úthoz. A mutáló műveletek (replay/discard)
auditálhatók: a fan-out/retry a ledgerbe ír.
