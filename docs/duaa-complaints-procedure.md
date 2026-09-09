# DUAA adatvédelmi panaszkezelési eljárás (UK site-ok)

> **Státusz:** ELŐKÉSZÍTVE, jogi jóváhagyásra vár. A közzétehető szöveg és a belső
> runbook kész; a CRM-oldali változás specifikálva (§5), de MÉG NINCS implementálva.
>
> **Miért készült:** a 2026-08-25-i CMP-átvilágítás egyetlen LEJÁRT HATÁRIDEJŰ tétele.
> A UK Data (Use and Access) Act 2025 az érintetti panaszra külön, a controllert
> terhelő eljárási kötelezettséget vezetett be; a mi UK-s site-jainkon ma nincs
> ilyen eljárás — sem közzétett út, sem belső határidő, sem számláló.

---

## 1. Mit követel a jog (és mit NEM)

A DUAA a UK GDPR-t módosítja, nem váltja fel. Az itt releváns új elem: az érintett
**panaszt tehet közvetlenül az adatkezelőnél**, és az adatkezelőnek ezt

1. **könnyűvé kell tennie** — kifejezetten elektronikus úton benyújtható formában;
2. **vissza kell igazolnia 30 napon belül**;
3. **érdemben ki kell vizsgálnia**, és a lépésekről/eredményről tájékoztatnia kell,
   indokolatlan késedelem nélkül;
4. **számon kell tartania** — az ICO jogosult a panaszok számáról adatot kérni.

Két dolog, amit ez NEM jelent, és amit ezért nem is építünk be:

- **Nem SAR.** Az adathozzáférési kérelem (Art 15) külön út, saját határidővel; a
  panasz-út nem helyettesíti és nem is nyeli el.
- **Nem zárja ki az ICO-t.** A panaszos bármikor fordulhat közvetlenül az ICO-hoz;
  a közzétett szövegnek ezt ki KELL mondania, különben az eljárásunk úgy hatna,
  mintha korlátozná a jogorvoslatot.

> ⚠️ **Jogi ellenőrzés kell:** a pontos hatálybalépési dátumot és a 30 napos
> visszaigazolási határidő szövegszerű megfogalmazását ügyvéddel kell jóváhagyatni,
> mielőtt bármelyik site-on megjelenik. Ez a dokumentum a *műszaki és folyamati*
> előkészítés, nem jogi tanácsadás.

**Hatály nálunk:** a UK-s adatkezelést végző site-ok — `painless`
(painlessremovals.com), `agykontroll` (agykontrollanglia), `jamesdunbar`,
`femkerites`/`clearfields`, amennyiben UK-ban telepedett adatkezelő áll mögöttük.
A magyar site-ok NAIH alá tartoznak: rájuk a magyar panasz-út érvényes, ezt a
§4 külön kezeli.

---

## 2. Közzéteendő szöveg (EN) — a UK site-ok adatvédelmi tájékoztatójába

> ### How to complain about how we use your data
>
> If you think we have used your personal data unfairly or unlawfully, you can
> complain to us directly. You do not have to give a reason for complaining, and
> complaining will never affect the service you receive from us.
>
> **How to complain.** Use the form at **/data-protection-complaint**, or email
> **privacy@&lt;domain&gt;**. Tell us what happened, when, and what you would like us
> to do. If you need this in another format, or need help making the complaint,
> tell us and we will arrange it.
>
> **What happens next.**
>
> 1. We will **acknowledge your complaint within 30 days** of receiving it, and
>    give you a reference number.
> 2. We will look into what happened and take appropriate steps.
> 3. We will tell you the outcome, and what we have changed, **without undue
>    delay**. If the investigation takes longer than expected, we will tell you
>    why and when to expect an answer.
>
> **You can also go to the regulator.** You do not have to complain to us first.
> You can contact the Information Commissioner's Office at any time —
> ico.org.uk/make-a-complaint, or 0303 123 1113. Complaining to us does not
> reduce your right to complain to the ICO, or to seek a remedy through the
> courts.
>
> **What we keep.** We keep a record of your complaint and how we handled it, so
> we can answer the ICO if asked, and so we can spot patterns. We keep it for
> **three years** from closing the complaint.

**Hungarian sites** get the equivalent HU text with the NAIH route instead of the
ICO (§4).

---

## 3. Belső runbook — mit csinál egy ember, mikor

| lépés | határidő | ki | mit |
|---|---|---|---|
| **Beérkezés** | azonnal | rendszer | Panasz-sor jön létre `type_key='data_protection'`-nel, referenciaszámmal. |
| **Visszaigazolás** | **≤30 nap** (cél: ≤2 munkanap) | rendszer (ack-email) | A meglévő `lib/complaints/ack-email.ts` küldi, DUAA-szöveggel. A 30 nap a jogi plafon, nem a célérték — a 2 munkanapos cél az, ami mérhetően teljesíthető. |
| **Triage** | ≤5 munkanap | adatvédelmi felelős | Eldönti: valós adatvédelmi panasz, SAR-nak álcázott kérés, vagy szolgáltatási panasz. Utóbbi kettő ÁTKERÜL a megfelelő útra, és ezt a panaszosnak meg kell írni. |
| **Vizsgálat** | ≤30 nap | adatvédelmi felelős | Mit gyűjtöttünk, milyen jogalapon, ki fért hozzá, mi a hiba. A ledger + `consent_log` a bizonyíték. |
| **Válasz** | indokolatlan késedelem nélkül | adatvédelmi felelős | Eredmény + a megtett intézkedés + az ICO-út megismétlése. |
| **Lezárás** | — | rendszer | `resolved`/`rejected`, a döntés indokával. Megőrzés: 3 év. |
| **Csúszás** | a 30. nap előtt | rendszer (`complaint-sla` cron) | Riaszt, ha egy `data_protection` panasz visszaigazolás nélkül közelít a 30 naphoz. |

**Eszkaláció:** ha a panasz adatvédelmi incidensre (személyes adat jogosulatlan
megismerése/elvesztése) utal, az incidens-út indul, **72 órás** ICO-bejelentési
órával — az sokkal szorosabb, mint a panasz-határidő, és nem várhatja meg a
panasz-vizsgálat végét.

---

## 4. Magyar site-ok (NAIH)

Ugyanez a folyamat fut, két eltéréssel:

- a hatóság a **NAIH** (naih.hu, +36 1 391 1400), nem az ICO;
- a magyar jog a panaszra nem ír elő külön 30 napos *visszaigazolási* kötelezettséget,
  viszont az érintetti kérelemre **egy hónapos** érdemi válaszhatáridő él (GDPR Art 12(3)).

Ezért a HU-szöveg a válaszhatáridőt ígéri, nem a visszaigazolást — **a két szöveg
nem fordítása egymásnak**, és nem is szabad annak lennie.

---

## 5. CRM-oldali változás — SPECIFIKÁLVA, MÉG NEM IMPLEMENTÁLT

Nem kell új modul: a CRM-ben **már megvan** a teljes gépezet — publikus űrlap
(`PublicComplaintForm.tsx`), intake (`public-intake.ts`), visszaigazoló levél
(`ack-email.ts`), állapotgép (`state-machine.ts`), SLA-cron
(`/api/cron/complaint-sla`) és per-vertikál típus-csomagok (`packs/*`).

A DUAA-panasz **egy új típus** ebben a gépezetben:

```ts
// astro/src/lib/complaints/packs/*.ts — MINDEN UK-s pack kapja meg
{
  key: 'data_protection',
  labelHu: 'Adatvédelmi panasz',
  labelEn: 'Data protection complaint',
  hintHu: 'Ha úgy érzed, a személyes adataidat tisztességtelenül vagy jogszerűtlenül kezeltük.',
  hintEn: 'If you think we have used your personal data unfairly or unlawfully.',
  fields: [],            // a közös név/elérhetőség/leírás elég; extra mező elriaszt
  defaultSeverity: 'high',
}
```

Három dolog, ami NEM triviális, és ezért ki van mondva:

1. **A 7 napos bejelentési ablak erre a típusra NEM alkalmazható.** A
   `deadline.ts` `COMPLAINT_WINDOW_DAYS = 7` a költöztetési T&C szabálya
   („a kiszállítás napjától"). Egy adatvédelmi panasznak nincs ilyen ablaka, és a
   `reported_late` jelölés itt félrevezető lenne az admin listában. A típusnak ki
   kell kerülnie az ablak-számítás alól — nem a küszöb emelésével, hanem
   típus-alapú kizárással, mert az ablak a *szolgáltatás* dátumához kötődik, ami
   itt nem is értelmezett.

2. **A visszaigazolásnak DUAA-szöveget kell adnia.** Az általános ack-levél a
   szolgáltatási panasz szótárát használja; a DUAA-válasznak tartalmaznia kell a
   30 napos visszaigazolást, a referenciaszámot és az ICO-utat. Ez az `ack-email.ts`
   típus-szerinti szövegválasztása, nem új levélküldő.

3. **Számláló az ICO felé.** A DUAA szerint az ICO kérheti a panaszok számát. Ez ma
   egy `SELECT count(*) ... WHERE type_key='data_protection'` — de csak akkor, ha a
   típus külön kulcson él, és nem olvad bele a `service`-be. Ezért kell saját
   `key`, nem egy „egyéb" alá söpört alkategória.

**A `/data-protection-complaint` útvonal** a meglévő publikus panasz-űrlap
type-előválasztott változata, nem új oldal.

---

## 6. Amit ez a dokumentum SZÁNDÉKOSAN nem tesz meg

- **Nem publikál.** A szöveg jogi jóváhagyás előtt egyetlen site-ra sem kerül ki.
- **Nem módosítja a CRM-et.** A §5 spec, nem PR — a CRM-változás önálló, tesztelt
  körben megy, mert a publikus intake-et érinti.
- **Nem állít határidőt a jogi jóváhagyásra.** A kötelezettség 2026-06-19 óta él,
  tehát a késedelem MÁR fennáll; ezt nem szépítjük egy önkényes dátummal.

---

*Írta: Claude Opus 5 · 2026-09-09 · a CRM-hivatkozások az `origin/main`-ről mérve.*
