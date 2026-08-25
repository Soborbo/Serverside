# P5 — `commit-after-business-success`

**Státusz:** kód kész, **opt-in, alapból KIKAPCSOLVA**. Egyetlen site viselkedése sem
változik, amíg a `commitOnSuccess` propot be nem kapcsolják.

## A hiba, amit zár

Klasszikus (natív navigációs) form-submitnél a sorrend ma:

```
validate → dataLayer push (a konverzió MEGTÖRTÉNT) → 600 ms → POST → backend
```

Ha a backend 500-at ad, a szerver-oldali validáció bukik, vagy a hálózat elszáll, a
Meta **már számolt egy Leadet**, amihez soha nem érkezik CAPI-pár. Ez fantom
konverzió: a dedup-partner hiánya miatt magától sem tűnik el, és felfelé torzítja a
ROAS-t — pont azon a felületen, ahol a legtöbb lead keletkezik.

A szerver lába ma is helyes (a backend csak elfogadott lead után hívja a gateway-t).
A hiba kizárólag a **böngésző** lábán van.

## Miért nem elég „await a fetch-re”

Natív form-submitnél a lap **navigál**: nincs „siker utáni” pillanat ugyanabban a
dokumentumban. A komponens szerződése ráadásul explicit klasszikus submitre épül.
Ezért kétfázisú a megoldás, és a második fázis a **siker-oldalon** fut.

## A lánc

```
1. SUBMIT      stageLeadSubmit() / stageContactSubmit()
               → event_id generálódik, a rejtett mezők VÁLTOZATLANUL töltődnek
               → a konverzió sessionStorage-ba kerül, de NEM sül el
               → natív POST

2. BACKEND     a lead elfogadva → a gateway-láb elmegy (mint eddig)
               → a siker-oldalra irányít, és VISSZAADJA az event_id-t

3. SIKER-OLDAL commitPendingConversion(eventId)
               → a dataLayer push MOST történik, ugyanazzal az event_id-vel
```

A commit paramétere nem kényelmi kérdés: **a siker a szerver ténye**, ezért a
commitnak a szervertől visszakapott azonosítóra kell hivatkoznia. Egy paraméter
nélküli `commit()` minden oldalletöltést sikernek venne — vagyis semmit nem javítana.

## Beépítés egy site-on

**1. A form:**

```astro
<TrackedForm action="/api/quote" eventType="lead" commitOnSuccess />
```

**2. A backend** a siker-válaszban adja vissza az `event_id`-t (a form rejtett
mezőjéből kapta) — redirect-paraméterként vagy a köszönő-oldalra rendereltként.

**3. A siker-oldal:**

```astro
---
const eventId = Astro.url.searchParams.get('e') ?? '';
---
<script define:vars={{ eventId }}>
  import('/path/to/lib').then(({ commitPendingConversion }) => {
    if (eventId) commitPendingConversion(eventId);
  });
</script>
```

## Amit tudni kell a migráció előtt

- **A bekapcsolás önmagában elveszi a böngésző-konverziót.** Ha a siker-oldal nem
  commitol, a Pixel-láb néma marad (a szerver-láb megy tovább). Ezért site-onként,
  ellenőrzéssel — nem flotta-szintű kapcsolóval.
- **Idempotens:** a köszönő-oldal újratöltése nem tüzel másodszor
  (`already_committed`).
- **Consent-újraellenőrzés:** ha a látogató a két oldalletöltés között visszavonta a
  marketing-hozzájárulást, a commit nem tüzel, és a letett rekordot is eldobja
  (`consent_revoked`, TRK-5001). A visszavonás pillanatában (`initTracking`
  consent-change kezelője) a letett rekordok azonnal törlődnek is a
  `sessionStorage`-ból (`discardPendingConversions`), így egy későbbi
  újra-engedélyezés után sem éled fel a régi konverzió.
- **TTL 30 perc, max 5 letett rekord.** A lejárt rekord nem commitolható, és az
  első olvasáskor (peek/commit) fizikailag is törlődik a tárból.
- **Nincs néma no-op:** a `commitPendingConversion` megnevezett kimenetet ad
  (`committed` / `no_pending` / `already_committed` / `consent_revoked` /
  `invalid_event_id`).

## Ellenőrzés élesítés után

1. GTM Preview: a form elküldése után a köszönő-oldalig **nincs** konverziós push.
2. A köszönő-oldalon **pontosan egy** push, a szerver által ismert `event_id`-vel.
3. Meta Events Manager: a Pixel- és a CAPI-esemény **egy** Leadként dedupál.
4. Szándékosan elrontott backend (pl. 500): a köszönő-oldal nem jön be → **nincs**
   konverzió sehol. Ez a javítás lényege.
