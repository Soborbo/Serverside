# HANDOVER — Run 6 (2026-07-14/15): correctness fixes + rollout

**A következő Claude Code runnak.** Ez a dokumentum a Run 6 zárásakor élő állapotot,
a nyitott teendőket és a megégetett kezünk tanulságait rögzíti. A rendszer-modell
leírása a README-ben és a CLAUDE.md-ben van (Run 6-ban frissítve) — ez itt a
"hol tartunk és mire figyelj" réteg.

## Mi él most productionben (mind deployolva, valós forgalmon részben bizonyítva)

| Mi | Hol | Állapot |
|---|---|---|
| Gateway Run 6 (three-state ledger, high-value gate, DLQ-őr, 500-ok) | `event-gateway`, Serverside#25 + #26 | ÉLES; valós painless lead bizonyította: `meta accepted|200 + lead_id`, forwarderek `skipped` (2026-07-14 23:20 UTC) |
| Quote-state Durable Object | — | TÖRÖLVE (v2 migráció, tárolt state-tel együtt). NE építsd vissza. |
| Offline GA4 leg | lead-status | KIKAPCSOLVA (client_id nélkül szintetikus GA4-clientek). Data Manager (Google Ads offline) él. |
| lomtalan.hu site-fixek (CRM lead_id, bot-guard, browser-leg le) | lomtalan.hu#10 + #11 | ÉLES |
| painless site-fixek (contact/clearance/email-click CAPI visszaállítva a szerver-ingressen) | painlessremovals#29 + #30 | MERGED; deploy a Workers Builddel |
| beautyflow site-fixek (CRM lead_id, browser-leg le, 400 non-retriable) | Beautyflow_website#52 + #53 → **master** | MERGED a masterre (lásd branch-akna lent) |
| Napi synthetic smoke-lead cron (04:43/47/51 UTC) mindhárom site workerben | site repók `src/worker.ts` + `src/lib/tracking/smoke.ts` | MERGED; első futás a merge utáni hajnalon |
| Smoke-őr a napi digestben (08:00, `SMOKE_SITES` var) | Serverside#26 | ÉLES. Az ELSŐ digest a smoke-cronok első futása ELŐTT hamis "smoke failed"-et jelez — várt egyszeri zaj. |

## Nyitott teendők (fontossági sorrendben)

1. **Utolsó élő bizonyíték**: az első post-deploy lomtalan eventnek `meta|skipped`-et
   kell könyvelnie (nem `accepted`-et). Query:
   `SELECT platform,status,http_status,lead_id FROM deliveries WHERE site_id='lomtalan' AND created_at >= '2026-07-14T22:20'`.
2. **Queues bekapcsolása** (operátori): `wrangler queues create event-gateway-dlq`
   és `event-gateway-dlq-dead`, majd a wrangler.toml kikommentezett 3 blokkja + deploy.
   A kód kész és tesztelt; enélkül a retry R2 + óránkénti cron.
3. **Beautyflow Meta Lead↔Contact dedup-rés** (döntést igényel): a böngésző Pixel
   `Lead`-et lő (GTM `lead_submit` tag), a backend `contact_form_submitted`-et →
   Meta `Contact`. Különböző event-név = NINCS dedup → lead-enként 1 Lead + 1 Contact.
   Megoldás VAGY a backend-event átnevezése (a kvíz/konzultáció valójában
   quote_calculator_submitted → Lead), VAGY a GTM-tag cseréje Contact-ra. Kampány-
   optimalizációs döntés — a tulajé.
4. **Beautyflow `main` vs `master` szétválás rendezése**: a default+deployolt branch
   a **master**; a #48/#49 (newsletter modal) csak a `main`-en van. A #51 tévesen
   main-be merge-ölt (hatástalan), a #52 a korrekt master-merge.
5. **Painless `/api/callbacks` + `/api/save-quote` bot-kapu** (döntést igényel):
   Origin + rate limit mögül tüzelik a hitelesített konverziót — Turnstile/honeypot
   nélkül. Kapu nélkül hamisítható; rossz kapu valódi konverziót veszít. Szándékosan
   nem nyúltunk hozzá.
6. **7 nem bekötött site**: tilos volt hozzányúlni Run 6-ban; bekötéskor a
   `scripts/generate-site.mjs` MÁR a kettéválasztott (browser vs server-only)
   checklistát adja.
7. **Kliens-oldali maradványok**: a painless/beautyflow browser-kódban maradt
   Turnstile-prewarm infrastruktúra a worker-leghez már felesleges (a gateway nem
   validálja); takarítható, nem sürgős.

## Amit egy jövőbeli run NE csináljon

- **NE tegyél `test_event_code`-ot KV site-configba** — per-request megy, a config
  edge-cache (300s) kétszer okozott éles Meta-leaket.
- **NE hozd vissza** a Turnstile-gateway-validációt, a quote-state DO-t, az on-site
  szerver GA4/Google Ads legeket, az offline GA4-et.
- **NE tesztelj élő böngésző-pixellel** — synthetic proof CSAK a hitelesített
  szerver-ingressen, per-request test-koddal (a smoke-cron pont ezt csinálja).
- **NE deployolj DO-migrációt tartalmazó branchet versions-uploaddal** — a branch
  Workers Build 10211-gyel bukik (várt); csak a main-merge (valódi deploy) viszi fel.

## Megégetett kéz — tanulságok (a skill/tesztek frissítéséhez is)

1. **A ledger nem hazudhat**: `accepted` CSAK vendor HTTP-státusszal (TRK-950-004
   invariáns a `normalizeDelivery`-ben). A lomtalan hamis-`accepted` esete hetekig
   zöld monitort mutatott nulla adat fölött.
2. **Egy join-kulcs formátumhibája nem nyelheti el a money-eventet**: az érvénytelen
   `lead_id`-t a gateway DROP-olja (warn), nem az egész payloadot dobja.
3. **A lead_id a CRM kulcsa** — a CRM webhook-válasz `{success, id}`-jából; site-oldali
   fallback-kulcs TILOS (kitöltöttnek látszó, de joinolhatatlan oszlop rosszabb a NULL-nál).
4. **Böngésző-leg ≠ redundancia**: 3 painless flow CSAK böngésző-CAPI-legre épült;
   a gate deploy után ezek némán vesztek volna. A deployolt worker-bundle NEM
   tartalmazza a kliens-scripteket — kliens-oldali call site-okat a REPÓBAN kell
   auditálni.
5. **A default branch nem mindig `main`** (Beautyflow: master). Merge előtt:
   `git remote show origin | grep "HEAD branch"` + a Workers Build melyik branchet deployolja.
6. **TOML: a top-level kulcs (pl. `keep_vars`) minden `[table]` ELŐTT álljon** —
   különben az utolsó tábla almezője lesz, és a deploy törli a dashboard-varokat.
   A generált configot (dist/server/wrangler.json) MINDIG ellenőrizd build után.
7. **Konszenzus-skip a monitoringban**: a szándékos `skipped` sorokat ki kell vonni
   a coverage-elvárásból, különben az őszinte könyvelés hamis CRITICAL-t szül.
8. **A 204 méreg a szerver-hívónak**: minden szerver-szerver út valós hibakódot ad;
   a 400 non-retriable a site-kliensekben.
9. **A bot-szűrő a konverziós oldalon is szűrjön**: a csendes fake-success mellé
   `silent: true` flag, és a kliens/`dispatch` kihagyja a trackinget.

## Kulcs-azonosítók

- D1 ledger: `event-gateway-ledger` (8c7774d1-2eea-40ba-b99c-92e73055460f)
- Worker: `event-gateway`; élő site-workerek: `painlessremovals-website`,
  `beautyflow-website`, `lomtalan-weboldal`
- Smoke event_id minta: `smoke-<site>-YYYYMMDD`; digest-őr: `SMOKE_SITES` var
- Hibakód-runbook: `docs/error-codes.md` (TRK-400-017, TRK-900-007, TRK-950-004 újak)
