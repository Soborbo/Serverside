# P5 — `commit-after-business-success`

**Státusz:** kód kész, **opt-in, alapból KIKAPCSOLVA**. Egyetlen site viselkedése sem
változik, amíg a `commitOnSuccess` / `submitMode="fetch"` propot be nem kapcsolják.

## A hiba, amit zár

Klasszikus (natív navigációs) form-submitnél a sorrend eredetileg:

```
validate → dataLayer push (a konverzió MEGTÖRTÉNT) → 600 ms → POST → backend
```

Ha a backend 500-at ad, a szerver-oldali validáció bukik, vagy a hálózat elszáll, a
Meta **már számolt egy Leadet**, amihez soha nem érkezik CAPI-pár. Ez fantom
konverzió: a dedup-partner hiánya miatt magától sem tűnik el, és felfelé torzítja a
ROAS-t — pont azon a felületen, ahol a legtöbb lead keletkezik.

A szerver lába ma is helyes (a backend csak elfogadott lead után hívja a gateway-t).
A hiba kizárólag a **böngésző** lábán volt.

## Az invariáns

```
business FAILED  → browser conversion = 0 ÉS server conversion = 0
business SUCCESS → PONTOSAN EGY logikai konverzió
```

A submit-kísérlet önmagában **nem** konverzió.

---

## Két út, két szerződés

| | `submitMode="fetch"` (P5.2) | `commitOnSuccess` + token (P5.3) |
|---|---|---|
| Mikor | a form XHR-rel megy, a lap marad | klasszikus POST, a lap navigál |
| Siker bizonyítéka | a backend JSON-válasza, ugyanabban a dokumentumban | **aláírt, egyszer-használatos token** |
| Kell hozzá titok | nem | igen (`CONVERSION_COMMIT_SECRET`) |
| EC-identity forrása | memóriabeli puffer (a lap nem hagyta el) | a siker-oldal szerver-oldali renderje |

**Ha választhatsz, a fetch-út az egyszerűbb és a biztonságosabb.** A token-út
azért létezik, mert sok site klasszikus form-POST-ot használ, és ott nincs
„siker utáni pillanat" ugyanabban a dokumentumban.

---

## P5.2 — fetch-út

```astro
<TrackedForm action="/api/quote" eventType="lead" submitMode="fetch" />
```

A backend siker-szerződése (2xx):

```json
{ "ok": true, "event_id": "<a rejtett mezőből kapott id>", "redirect": "/koszonjuk" }
```

- Az `event_id`-nek **egyeznie kell** azzal, amit a böngésző letett — a backend a
  form rejtett mezőjéből kapta. Ha mást ad vissza, a Meta Pixel↔CAPI dedup törne,
  ezért nem commitolunk (`TRK-5005`).
- A `redirect` opcionális; a komponens a **commit után** navigál.
- A form `sb:conversion-committed` / `sb:conversion-failed` DOM-eseményt küld, hogy
  a site megjeleníthesse a hibát.

Minden nem-siker ág **nulla konverzióval** zárul, saját kóddal:

| Ág | Kód |
|---|---|
| nem-2xx (400/403/409/500…), hálózati hiba, időtúllépés, `{ok:false}` | `TRK-5004` |
| 2xx, de nem JSON / hiányzó `ok` / hiányzó vagy üres `event_id` / `null` törzs | `TRK-5003` |
| a backend MÁS `event_id`-t igazolt vissza | `TRK-5005` |
| consent visszavonva a submit és a válasz között | `TRK-5001` |

## P5.3 — klasszikus POST + aláírt token (PRG)

```
1. SUBMIT      stageLeadSubmit() → event_id a rejtett mezőbe, konverzió LETÉVE
2. BACKEND     üzleti írás SIKERÜL → mintConversionCommitToken() → 303 → /koszonjuk?ct=<token>
3. SIKER-OLDAL consumeConversionCommitToken() szerver-oldalon → <ConversionCommit eventId=… />
```

**Miért nem elég az `?e=<event_id>`.** Az event_id a form rejtett mezőjében ott van
a DOM-ban. Bárki kiolvassa, elküldi a formot, és ha a backend **elutasítja**, kézzel
megnyitja a `/koszonjuk?e=<ugyanaz>` címet — a konverzió elég. Az INV-001 így csak a
jóhiszemű útvonalon állt. A tokent viszont csak a szerver tudja kiállítani.

**A backendben, az üzleti írás UTÁN:**

```ts
import { mintConversionCommitToken } from '../lib/tracking/conversion-token';

const lead = await createLead(data);          // ← ez a business truth
const token = await mintConversionCommitToken({
  secret: env.CONVERSION_COMMIT_SECRET,       // min. 32 karakter
  siteId: url.hostname,
  eventName: 'quote_calculator_submitted',
  eventId: String(form.get('event_id')),
});
return new Response(null, { status: 303, headers: { Location: `/koszonjuk?ct=${token}` } });
```

**A siker-oldalon (szerver-oldali render):**

```astro
---
import { consumeConversionCommitToken, kvCommitTokenStore } from '../lib/tracking/conversion-token';
import ConversionCommit from '../components/ConversionCommit.astro';

const env = Astro.locals.runtime.env;
const r = await consumeConversionCommitToken(Astro.url.searchParams.get('ct'), {
  secret: env.CONVERSION_COMMIT_SECRET,
  siteId: Astro.url.hostname,
  eventName: 'quote_calculator_submitted',
  store: kvCommitTokenStore(env.COMMIT_TOKENS),
});
if (!r.ok) console.warn('[tracking]', r.code, r.message);   // néma ág nincs

// KÖTELEZŐ: a köszönő-oldal nem cache-elhető. A token egyszer használatos,
// egy cache-elt HTML pedig MÁS látogatónak adná oda a commit-parancsot.
Astro.response.headers.set('Cache-Control', 'no-store');
---
<ConversionCommit eventId={r.ok ? r.eventId : null} />
```

### A token szerződése

- **HMAC-SHA256**, base64url `payload.signature`.
- **Nincs benne PII** — se e-mail, se telefon, se név, se hash. Csak: séma-verzió,
  site-azonosító, event-név, event_id, egyedi `jti`, lejárat. A token URL-be kerül,
  tehát bemegy a szerver-logokba és a referrerbe is (INV-002).
- **TTL** alapból 15 perc, felső korlát 60 perc (egy elgépelt érték nem nyithat
  hónapos replay-ablakot).
- **Site-hoz és eventhez kötött** — más site vagy más event tokenje elutasítva.
- **Egyszer használatos** — a beváltást a `CommitTokenStore` végzi.

### Token-store

| Implementáció | Atomi? | Mikor |
|---|---|---|
| `d1CommitTokenStore(db)` | **igen** (PK-ütközés) | ahol a site-nak van D1-je — ez az ajánlott |
| `kvCommitTokenStore(kv)` | nem (nincs „put if absent") | ahol csak KV van; az újratöltést megfogja, az egyszerre nyitott két tabfület nem |
| `memoryCommitTokenStore()` | — | teszt és fejlesztés, **nem éles** |

A D1-séma:

```sql
CREATE TABLE conversion_commit_tokens (
  jti        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_cct_expires ON conversion_commit_tokens(expires_at);
-- cron: DELETE FROM conversion_commit_tokens WHERE expires_at < unixepoch();
```

### Token-hibakódok

| Kód | Jelentés | Retryability |
|---|---|---|
| `TRK-510-001` | nincs token a siker-oldalon | TERMINAL |
| `TRK-510-002` | alakilag hibás token | TERMINAL |
| `TRK-510-003` | **az aláírás nem stimmel** — hamisítás vagy rossz titok | TERMINAL |
| `TRK-510-004` | ismeretlen séma-verzió | OPERATOR_ACTION |
| `TRK-510-005` | lejárt | TERMINAL |
| `TRK-510-006` | más site tokenje | TERMINAL |
| `TRK-510-007` | más event tokenje | TERMINAL |
| `TRK-510-008` | **már elhasznált** — újratöltés/back-forward, nem új konverzió | POLICY_SKIP |
| `TRK-510-009` | a store nem elérhető → **fail-closed**, nincs konverzió | RETRYABLE |
| `TRK-510-010` | hiányzó vagy 32 karakternél rövidebb titok | CONFIG_BLOCKED |

**Fail-closed indoklás.** Store-kiesésnél inkább elveszítünk egy valódi konverziót,
mint hogy duplikátumot engedjünk: a duplikátum torzítja a biddinget, és pont az
ellen készült az egész P5. Mindkét irány **hangos**.

---

## PII és tárolás (INV-002)

A `sessionStorage`-ba tett rekord **PII-mentes**: `kind`, `eventId`, `stagedAt`,
`value`, `currency`, `gclid`. Se e-mail, se telefon, se név.

Az Enhanced-Conversions identity egy **modul-privát memóriapufferben** él, ami a
dokumentummal együtt elszáll:

- **fetch-út:** a puffer kiszolgálja a commitot — a PII sehol nem érinti a tárat.
- **navigációs út:** navigáció után a puffer üres, ezért a siker-oldalnak **magának**
  kell átadnia az identityt a saját üzleti rekordjából
  (`<ConversionCommit identity={...} />`). Ilyenkor az adat a lap HTML-jébe kerül —
  ezért a `no-store` fejléc nem opcionális.
- **identity nélkül** a konverzió akkor is elmegy, csak gyengébb EC-match-csel, és
  ezt `TRK-5002` jelzi. Néma degradáció nincs.

> **Ez korábban hibás volt.** A P5 első köre nyers e-mailt, telefont és nevet tett a
> `sb_pending_conversion` kulcsba, és a fejlécében „nem PII"-nek nevezte. Az F12-es
> bámészkodó és bármelyik third-party szkript olvashatta.

## Amit tudni kell a migráció előtt

- **A bekapcsolás önmagában elveszi a böngésző-konverziót.** Ha a siker-oldal nem
  commitol, a Pixel-láb néma marad (a szerver-láb megy tovább). Ezért site-onként,
  ellenőrzéssel — nem flotta-szintű kapcsolóval.
- **A bot/érvénytelen konverziók eltűnése SZÁNDÉKOS**, de az Ads/Meta-riportban
  volumencsökkenésként jelentkezik, és a konverzió pillanata is átkerül (a GA4
  attribúció változik). A hirdető tájékoztatása a rollout része.
- **Idempotens két rétegben:** a token a beváltás után halott (szerver), és a commit
  `committed` halmazt vezet (böngésző).
- **TTL 30 perc, max 5 letett rekord.** A lejárt rekord nem commitolható, és az első
  olvasáskor fizikailag is törlődik a tárból.
- **Nincs néma no-op:** a `commitPendingConversion` megnevezett kimenetet ad
  (`committed` / `no_pending` / `already_committed` / `consent_revoked` /
  `invalid_event_id`).
- **Change-isolation (R0.2):** a bekapcsolás önálló rollout-ablak. Ne csomagold
  össze GTM-refactorral, CMP-flippel vagy conversion-action-változtatással.

## Ellenőrzés élesítés után

1. GTM Preview: a form elküldése után a köszönő-oldalig **nincs** konverziós push.
2. A köszönő-oldalon **pontosan egy** push, a szerver által igazolt `event_id`-vel.
3. Meta Events Manager: a Pixel- és a CAPI-esemény **egy** Leadként dedupál.
4. Szándékosan elrontott backend (pl. 500): **nincs** konverzió sehol.
5. A köszönő-oldal újratöltése: **nincs** második konverzió (`TRK-510-008`).
6. A köszönő-oldal `?ct=` nélküli megnyitása: **nincs** konverzió (`TRK-510-001`).
