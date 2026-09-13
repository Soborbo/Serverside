# Adatvédelmi panaszkezelési eljárás — TERVEZET jogi jóváhagyásra

> ## ⚠️ EZ EGY TERVEZET, NEM JOGI TANÁCS
>
> Ezt a szöveget **jogásznak kell jóváhagynia**, mielőtt bármelyik site-ra kikerül.
> Nem vagyok jogász, és ez a dokumentum nem jogi tanácsadás. Az alábbi tervezet a
> `cmp-research.md` jogi átvilágítás megállapításaira épül, és a szerkezetét a UK
> **Data (Use and Access) Act 2025 (DUAA)** panaszkezelési követelménye adja.
>
> ## 🔴 A HATÁRIDŐ MÁR LETELT
>
> A DUAA panaszkezelési kötelezettsége **2026. június 19-én** lépett hatályba
> (`cmp-research.md` 70. és 89. pont). Ma **2026-09-13** van — tehát ez a tétel
> nem „közelgő", hanem **~3 hónapja lejárt**. Ez a késedelem önmagában is
> bejelenteni való kockázat, és érdemes a jogásznak külön jelezni.
>
> ## Kit érint
>
> A DUAA **UK jog**. Elsődlegesen a brit közönségű site-okat érinti
> (`painlessremovals.com`, `agykontroll.co.uk` — mindkettő `country_code: GB`).
> A magyar site-oknál a GDPR/NAIH szabályai állnak; ott ugyanez az eljárás **jó
> gyakorlat**, de a DUAA-specifikus 30 napos visszaigazolási kötelezettség nem
> közvetlenül alkalmazandó. A jogász döntse el, egységes vagy kétféle szöveg kell.

---

## 1. Mit követel a DUAA (a tervezet szerkezetének indoka)

A DUAA a UK GDPR-t egészíti ki egy **panaszkezelési** kötelezettséggel. A tervezet
az alábbi elemekre épül — ezeket kérem a jogásszal tételesen visszaigazoltatni:

| elem | amit a tervezet feltételez |
|---|---|
| panasz benyújtásának megkönnyítése | elektronikus úton elérhető, ingyenes csatorna |
| visszaigazolás | **30 napon belül** |
| érdemi válasz | „indokolatlan késedelem nélkül" |
| nyilvántartás | a panaszok és a megtett lépések dokumentálása |
| ICO-hoz fordulás joga | a panaszosnak jeleznünk kell, hogy panaszt tehet a felügyeleti hatóságnál |

⚠️ **Amit NEM tudok megerősíteni**, és a jogásznak ellenőriznie kell: a pontos
határidők, hogy a 30 nap naptári vagy munkanap, kell-e formális panaszűrlap,
és hogy a magyar entitásra milyen mértékben terjed ki bármelyik elem.

---

## 2. A közzéteendő szöveg (HU) — TERVEZET

### Adatvédelmi panasz benyújtása

Ha úgy érzi, hogy személyes adatait nem megfelelően kezeljük, panaszt tehet
nálunk. A panaszkezelés **ingyenes**.

**Hogyan tehet panaszt**

Írjon a(z) **[ADATVÉDELMI E-MAIL CÍM]** címre, vagy használja a
[PANASZ-ŰRLAP LINK] űrlapot. Kérjük, adja meg:

- a nevét és egy elérhetőségét (hogy válaszolni tudjunk),
- mire vonatkozik a panasz (melyik weboldal, mikor, milyen adat),
- mit szeretne elérni.

Ha nem tudja pontosan megfogalmazni, az sem akadály — írja le a saját szavaival,
és mi visszakérdezünk.

**Mi történik ezután**

1. A panasz beérkezését **30 napon belül** visszaigazoljuk.
2. Megvizsgáljuk, és **indokolatlan késedelem nélkül** érdemi választ adunk.
3. Ha a vizsgálat hosszabb időt vesz igénybe, tájékoztatjuk a várható határidőről
   és annak okáról.
4. A panaszt és a megtett lépéseket **nyilvántartjuk**.

**Ha nem ért egyet a válaszunkkal**

Panaszával a felügyeleti hatósághoz is fordulhat:

- **Egyesült Királyság:** Information Commissioner's Office (ICO) — ico.org.uk
- **Magyarország:** Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH) —
  naih.hu

A hatósághoz fordulás joga **független attól**, hogy nálunk tett-e panaszt: nem
kell megvárnia a mi válaszunkat.

---

## 3. A közzéteendő szöveg (EN) — DRAFT

### Making a data protection complaint

If you believe we have not handled your personal data properly, you can complain
to us. Complaining is **free**.

**How to complain**

Email **[DATA PROTECTION EMAIL]** or use the [COMPLAINT FORM LINK] form. Please tell us:

- your name and a way to reach you,
- what the complaint is about (which website, when, what data),
- what outcome you are looking for.

If you are not sure how to phrase it, write it in your own words — we will come
back to you with questions.

**What happens next**

1. We will **acknowledge** your complaint **within 30 days**.
2. We will investigate and respond **without undue delay**.
3. If the investigation takes longer, we will tell you why and when to expect a
   substantive reply.
4. We keep a **record** of the complaint and the steps we took.

**If you are not satisfied with our response**

You can also complain to the supervisory authority:

- **UK:** Information Commissioner's Office (ICO) — ico.org.uk
- **Hungary:** Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH) — naih.hu

Your right to complain to the regulator is **independent** of complaining to us —
you do not have to wait for our reply.

---

## 4. Belső eljárás (nem közzéteendő) — TERVEZET

Ez a rész a működésről szól, nem a látogatóknak.

**Beérkezés.** A panasz e-mailben vagy űrlapon érkezik. Egyetlen postafiók
figyelje; ne szóródjon szét személyes fiókokba.

**Nyilvántartás.** Minden panaszról rögzítendő: beérkezés dátuma, panaszos,
érintett site, tárgy, visszaigazolás dátuma, érdemi válasz dátuma, kimenet,
megtett intézkedés.

✅ **A CRM-oldali technikai fele KÉSZ** (2026-09-13, `soborbo-crm` #164): a
`data_protection` panasz-típus minden panasz-packben elérhető. Nem a packekbe
került, hanem a `resolvePack` fojtópontjára, hogy egy új vertikál szerzője ne
felejthesse el — a hiány ugyanis **néma** lenne: a bejelentő nem találna hova
fordulni, mi meg nem tudnánk, hogy nem találta. Alap-súlyossága `high`, így a
7 napos SLA-eszkaláció bőven a 30 napos visszaigazolási ablakon belül szól.

Vagyis **a panasz befogadására és nyilvántartására a rendszer ma képes**; ami
hiányzik, az a közzéteendő szöveg jogi jóváhagyása.

**Határidők.** Visszaigazolás 30 napon belül; érdemi válasz indokolatlan
késedelem nélkül. A határidők **mérendők**, nem becsülendők — a nyilvántartásnak
ki kell tudnia mutatni a teljesítést.

**Eszkaláció.** Ha a panasz adatvédelmi incidensre utal, az incidenskezelés
külön útvonalon indul (72 órás bejelentési kötelezettség) — a panaszkezelés ezt
nem helyettesíti.

**Felelős.** [NÉV / SZEREPKÖR] — a jogásszal együtt kitöltendő. Ha van kijelölt
adatvédelmi tisztviselő, ő; ha nincs, nevesített felelős kell.

---

## 5. Amit a jogásznak el kell döntenie

1. **Egy szöveg vagy kettő?** UK és HU entitás, eltérő jogalap.
2. **Kontrollerség.** Az ügynökségi modellben ki a címzettje a panasznak — a
   kliens (mint adatkezelő) vagy a Soborbo (mint adatfeldolgozó)? A
   `cmp-research.md` 16. pontja szerint ez site-onként eldöntendő, és ez a
   **legnagyobb dokumentációs hiányosság**. A panasz-szöveg ezen áll vagy bukik:
   rossz címzett esetén a panasz a semmibe megy.
3. **A 30 nap** naptári vagy munkanap.
4. **A lejárt határidő** kezelése — kell-e bármit tenni a ~3 hónapos csúszás miatt.
5. **Az űrlap** kötelező-e, vagy elég az e-mail cím.

---

## 6. Ez hova kerül ki

Jóváhagyás után: az adatkezelési tájékoztató önálló szakaszaként minden site-on,
és a süti-tájékoztató oldal aljáról hivatkozva (`<CookiePolicy />` alatt). A
`consent-texts/` verziózott szövegkészletbe **nem** való: az a banner-szövegé, és
a verzió-kapu miatt egy panaszkezelési szöveg változása fölöslegesen érvénytelenítené
a meglévő hozzájárulásokat.
