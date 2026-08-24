# A — CRM click-ID fix: mentés, branch, PR (a GÉPEDEN futtatandó)

**Dátum:** 2026-08-24 · **vNext P0.1 · CRITICAL** · **Státusz: NEM VÉGREHAJTHATÓ
felhőből — a te gépeden kell.**

---

## 0. Miért ez a dokumentum, és nem a kész PR

A javítás **kizárólag a te Windows-gépeden, a `d:\soborbo-crm\soborbo-crm` working
tree-jében létezik**, uncommitted, semmilyen branchen. Ez a session egy izolált
felhő-konténerben fut, aminek nincs hozzáférése a te lemezedhez — a diffet nem tudom
sem elolvasni, sem átmenteni.

**Ezért ezt SZÁNDÉKOSAN nem implementáltam újra.** Ha újraírnám, két, egymástól
eltérő javítás lenne ugyanarra a hibára (a tiéd +64 sornyi, már megírt teszttel), és az
összefésülésük vagy konfliktus, vagy — rosszabb — az egyik példány néma elvesztése
lenne. Money-path változásnál ez elfogadhatatlan kockázat.

### Amit a felhőből viszont ELLENŐRIZTEM (2026-08-24)

| Állítás | Igazolva |
|---|---|
| a CRM `origin/main` még mindig `ac6cec8` | friss klón, `git rev-parse HEAD` |
| a javítás **nincs** a remote-on | `lifecycle.ts` `buildLifecycleTracking`-je nem olvas click ID-t; `ads.ts`-ben nincs `OUTBOX-BUILD-003` (csak -001 és -002) |
| a hiba pontos helye | `gateway-sender.ts` `buildConversionServerRequest`-je (a KEZDETI konverzió) **igen**, a `buildLeadStatusRequest`-je (a LIFECYCLE / offline leg) **nem** küld click ID-t — ez a 2026-08-09-i incidens: 16 `revenue_confirmed` gclid nélkül, **nulla match** |
| **a gateway-oldal MÁR KÉSZ** | `/api/event/lead-status` elfogadja a top-level `gclid`/`gbraid`/`wbraid`-et (`src/routes/lead-status.ts:80-82` típus, `:144-146` validáció, `:422-424` és `:585-587` továbbadás), a `datamanager.ts:138-140` pedig `adIdentifiers`-be teszi `gclid > gbraid > wbraid` prioritással |

**Következmény: az „A" fázis tisztán CRM-oldali munka.** A Serverside-on nincs mit
csinálni hozzá — a fogadó fél kész és tesztelt.

---

## 1. ELSŐ LÉPÉS — mentsd meg a diffet, MIELŐTT bármi mást csinálsz

⚠️ **Ne `git checkout`-olj, ne `git clean`-elj, ne `git stash`-elj, ne válts branchet,
amíg a diff nincs kimentve.** Ez a javítás egyetlen példánya.

```bash
cd /d/soborbo-crm/soborbo-crm       # Git Bash; PowerShellben: cd D:\soborbo-crm\soborbo-crm

# 1) Mi van pontosan a working tree-ben?
git status --short
git diff --stat

# 2) MENTÉS a repón KÍVÜLRE (ezt akkor is megtartod, ha bármi félremegy)
git diff > /d/_backup/crm-clickid-fix-$(date +%Y%m%d-%H%M).patch
git diff --stat > /d/_backup/crm-clickid-fix-STAT.txt
```

Elvárt (a cross-check mérése szerint): `gateway-sender.ts +13`, `lifecycle.ts +38-3`,
`errors/codes/ads.ts +1`, `lifecycle.test.ts +64`.

Ha **több** fájl módosult (pl. a `feat/beautyflow-services-treatments` munkád is bent
van), az sem baj — a 2. lépés fájlonként emel át.

---

## 2. Branch `origin/main`-ről + CSAK a 4 fájl

A tracking-modul bájt-azonos `main` és a kicsekkolt beautyflow-branch között (a
cross-check ezt ellenőrizte), ezért a diff tisztán átemelhető.

```bash
git fetch origin main

# Jelöld meg a jelenlegi (beautyflow) állapotot, hogy biztosan visszatalálj
git stash push -m "beautyflow WIP + clickid fix" --include-untracked
git stash list        # győződj meg róla, hogy létrejött

git checkout -B fix/crm-lifecycle-click-ids origin/main

# CSAK a 4 érintett fájlt emeld át a stashből
git checkout stash@{0} -- \
  astro/src/lib/tracking/lifecycle.ts \
  astro/src/lib/tracking/gateway-sender.ts \
  astro/src/lib/errors/codes/ads.ts \
  astro/src/lib/tracking/lifecycle.test.ts

git diff --stat        # PONTOSAN ez a 4 fájl legyen
```

> A `stash push` + `checkout stash@{0} -- <fájl>` páros azért jobb, mint a
> `git checkout main` utáni kézi másolás: a stash a beautyflow-munkádat is megőrzi, és
> a `--` utáni fájllista miatt semmi más nem jön át. A stash a PR után
> `git stash pop`-pal visszatér a beautyflow-branchre.

---

## 3. Zöld bizonyíték a commit ELŐTT

```bash
cd astro
npm test -- lifecycle            # a working tree-beli +64 sornyi teszt
npm run typecheck
```

A tervben rögzített DoD-elemek, amiket a teszteknek le kell fedniük (a cross-check
szerint NAGYRÉSZT MÁR MEGVANNAK a working tree-ben):

- [ ] a lifecycle-outbox snapshot tartalmazza az elérhető click ID-ket;
- [ ] top-level emisszió a `/lead-status` bodyban (**nem** `attribution` alatt — a
      gateway a top-level `gclid`/`gbraid`/`wbraid`-et olvassa, lásd §0 táblázat);
- [ ] `'attribution' in body === false` a lifecycle-bodyra;
- [ ] üres string kihagyása (nem megy fel `gclid: ""`);
- [ ] null-safe default;
- [ ] **negatív eset:** nincs click ID → a hash-elt identity megy, **fabrikált gclid
      nincs** (egy kitalált click ID rosszabb, mint a semmi: elrontja a matchet ÉS
      hamis attribúciót ad).

---

## 4. Commit + PR

```bash
git add astro/src/lib/tracking/lifecycle.ts \
        astro/src/lib/tracking/gateway-sender.ts \
        astro/src/lib/errors/codes/ads.ts \
        astro/src/lib/tracking/lifecycle.test.ts
git commit           # az üzenethez lásd lentebb
git push -u origin fix/crm-lifecycle-click-ids
```

**A PR-leírásba KÖTELEZŐEN bele kell kerülnie** (a terv P0.1 kikötése):

> A `payloadHash` az új mezőkkel **változik**, a dedup-kulcs
> (`lc:<leadId>:<eventName>`) **NEM**. Ezért a már sorban álló outbox-rekordok
> **nem duplázódnak**: az `onConflictDoNothing` a változatlan kulcson elnyeli az
> ismételt beszúrást. A hash-változás csak azt jelenti, hogy az ÚJ sorok más
> payloadHash-t kapnak — ez nem idempotencia-törés.

Ajánlott commit-üzenet:

```
fix(tracking): click ID-k propagálása a lifecycle-outboxba és a /lead-status bodyba

A 2026-08-09-i incidens javítása: 16 revenue_confirmed ment fel gclid nélkül,
NULLA match. A kezdeti konverzió (buildConversionServerRequest) már küldött click
ID-t, a lifecycle/offline leg (buildLeadStatusRequest) nem — pedig a Google Ads
Enhanced Conversions for Leads determinisztikus matchje pont ezen múlik.

A gclid/gbraid/wbraid a lead_attribution snapshotból kerül a lifecycle-outbox
sorába, onnan TOP-LEVEL mezőként a /lead-status bodyba (nem `attribution` alatt —
a gateway ott olvassa: routes/lead-status.ts:80-82,144-146).

Click ID hiányában a hash-elt identity megy egyedül; fabrikált gclid SOHA.

payloadHash: változik (új mezők). Dedup-kulcs (lc:<leadId>:<eventName>): NEM
változik → a sorban álló rekordok nem duplázódnak.
```

**Merge-t ne csinálj kérdezés nélkül**, ha a CRM main-merge is autodeployol.

---

## 5. PROD CHECK — a következő valódi `revenue_confirmed` után

```sql
-- CRM oldal: a click ID tényleg bekerült az outbox-sorba
SELECT lead_id, event_name, gclid, gbraid, wbraid, created_at
FROM crm_tracking_events
WHERE event_kind = 'lifecycle'
ORDER BY created_at DESC LIMIT 5;
-- elfogadás: legalább egy sor NEM-NULL gclid-del
```

```sql
-- Gateway oldal (event-gateway-ledger D1): a feltöltés célba ért
SELECT site_id, event_name, platform, status, http_status, created_at
FROM deliveries
WHERE origin = 'offline' AND platform = 'gads'
  AND event_id NOT LIKE 'smoke-%' AND event_id NOT LIKE 'dm-validate%'
ORDER BY created_at DESC LIMIT 5;
-- elfogadás: status='accepted' ÉS http_status NOT NULL (INV-010)
```

Google-oldal: **Ads → Goals → Conversions** — az offline action „Recording
conversions"-re vált, és a match rate a gclid-es feltöltéseknél ugrik.

> **Nyitott függőség:** ha a P2 OAuth-helyreállítás még nem történt meg, a §5 gateway-
> oldali lekérdezése akkor sem ad `accepted` sort, ha a CRM-fix tökéletes — a Google-
> hívás az auth-nál bukna el. A CRM-oldali ellenőrzés (`crm_tracking_events.gclid`)
> ettől függetlenül elvégezhető és elegendő a PR elfogadásához. Sorrend:
> `docs/gads-oauth-repair-runbook.md`.

---

## 6. ROLLBACK

Revert-commit. A dedup-kulcs változatlan, ezért a visszaállítás **adatkockázat
nélküli**: nem keletkeznek duplikált outbox-sorok sem oda, sem vissza úton.
